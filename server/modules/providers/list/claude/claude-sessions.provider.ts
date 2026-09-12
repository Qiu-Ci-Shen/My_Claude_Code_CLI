import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, FetchSubagentsOptions, NormalizedMessage, SubagentConversation, SubagentSummary } from '@/shared/types.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, sliceTailPage } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

import { filterPostAbortTranscriptEntries, getAbortedTurnTimestamps } from './aborted-turns.js';

const PROVIDER = 'claude';

// 转录解析缓存：历史 API 每次请求都重读+重解析整个 JSONL（多 MB 文件每次几十
// 毫秒，且激活/刷新/回退后都会触发）。mtime+size 未变化时直接复用解析结果。
// 缓存为原始解析条目（未按 providerSessionId 过滤）。
// 淘汰按「原始字节预算 + 文件数」双上限、命中提升为 LRU：解析后的对象体积约为
// 原始字节的 3-5 倍，只限文件数挡不住内存（30 个大文件可常驻数百 MB~1GB）。
const transcriptParseCache = new Map<string, { mtimeMs: number; size: number; entries: AnyRecord[] }>();
const TRANSCRIPT_CACHE_MAX_FILES = 30;
const TRANSCRIPT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
let transcriptCacheBytes = 0;

async function readTranscriptEntries(jsonlPath: string): Promise<AnyRecord[]> {
  const stat = await fsp.stat(jsonlPath);
  const cached = transcriptParseCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // LRU：命中后移到队尾，热点会话不会被插入序淘汰误伤
    transcriptParseCache.delete(jsonlPath);
    transcriptParseCache.set(jsonlPath, cached);
    return cached.entries;
  }

  const entries: AnyRecord[] = [];
  const fileStream = fs.createReadStream(jsonlPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as AnyRecord);
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  // 单文件超过预算不缓存：解析后内存还要再翻几倍，宁可每次重读也不让它独占预算。
  // 同路径的旧条目（内容已变）先扣掉旧权重再入账。
  if (stat.size <= TRANSCRIPT_CACHE_MAX_BYTES) {
    if (cached) {
      transcriptCacheBytes -= cached.size;
    }
    transcriptParseCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    transcriptCacheBytes += stat.size;
    while (
      (transcriptParseCache.size > TRANSCRIPT_CACHE_MAX_FILES
        || transcriptCacheBytes > TRANSCRIPT_CACHE_MAX_BYTES)
      && transcriptParseCache.size > 1
    ) {
      const oldestKey = transcriptParseCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldestEntry = transcriptParseCache.get(oldestKey);
      transcriptParseCache.delete(oldestKey);
      if (oldestEntry) {
        transcriptCacheBytes -= oldestEntry.size;
      }
    }
  } else if (cached) {
    // 文件涨过预算阈值：清掉旧缓存条目，权重同步出账
    transcriptParseCache.delete(jsonlPath);
    transcriptCacheBytes -= cached.size;
  }
  return entries;
}

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

// subagent 文件解析缓存：历史 API 对会话涉及的每个 agent-*.jsonl 全量重解析
// （重会话可能有几十个 1MB 级文件），mtime+size 未变时复用。一次解析同时产出
// 「工具列表」（挂到主转录的 Task/Agent tool_result 上）与「完整对话」
//（Agents 面板的历史回看）。
type AgentFileParse = {
  tools: AnyRecord[];
  conversation: NormalizedMessage[];
};
const agentFileParseCache = new Map<string, { mtimeMs: number; size: number } & AgentFileParse>();
const AGENT_FILE_CACHE_MAX_FILES = 40;

async function parseAgentFile(filePath: string): Promise<AgentFileParse> {
  try {
    const stat = await fsp.stat(filePath);
    const cached = agentFileParseCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { tools: cached.tools, conversation: cached.conversation };
    }

    const parsed = await parseAgentFileUncached(filePath);
    agentFileParseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed });
    if (agentFileParseCache.size > AGENT_FILE_CACHE_MAX_FILES) {
      const oldest = agentFileParseCache.keys().next().value;
      if (oldest !== undefined) agentFileParseCache.delete(oldest);
    }
    return parsed;
  } catch {
    // stat 失败（文件缺失等）：交给解析函数按原逻辑告警并返回空结果
    return parseAgentFileUncached(filePath);
  }
}

async function parseAgentFileUncached(filePath: string): Promise<AgentFileParse> {
  const tools: AnyRecord[] = [];
  const conversation: NormalizedMessage[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineIndex = 0;
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      lineIndex += 1;

      try {
        const entry = JSON.parse(line) as AnyRecord;
        collectAgentTools(entry, tools);
        collectAgentConversation(entry, conversation, lineIndex);
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  return { tools, conversation };
}

/** Extracts the tool_use/tool_result pairs the main transcript attaches to its Agent call. */
function collectAgentTools(entry: AnyRecord, tools: AnyRecord[]): void {
  if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
    for (const part of entry.message.content as AnyRecord[]) {
      if (part.type === 'tool_use') {
        tools.push({
          toolId: part.id,
          toolName: part.name,
          toolInput: part.input,
          timestamp: entry.timestamp,
        });
      }
    }
  }

  if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
    for (const part of entry.message.content as AnyRecord[]) {
      if (part.type !== 'tool_result') {
        continue;
      }

      const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
      if (!tool) {
        continue;
      }

      tool.toolResult = {
        content: toolResultText(part.content),
        isError: Boolean(part.is_error),
      };
    }
  }
}

/**
 * Projection of a subagent transcript entry into the normalized message shape
 * the Agents panel renders (user prompt, assistant text/thinking/tool calls,
 * tool results). `sessionId` is left blank here because this parse result is
 * cached per file, independent of the app session it will be served under.
 */
function collectAgentConversation(entry: AnyRecord, conversation: NormalizedMessage[], lineIndex: number): void {
  if (entry.isMeta === true) {
    return;
  }
  if (entry.type !== 'user' && entry.type !== 'assistant') {
    return;
  }
  const message = entry.message as AnyRecord | undefined;
  if (!message || !message.content) {
    return;
  }

  const baseId = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `agent_line_${lineIndex}`;
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
  const push = (fields: AnyRecord) => {
    conversation.push(createNormalizedMessage({
      ...fields,
      sessionId: '',
      provider: PROVIDER,
      ...(timestamp ? { timestamp } : {}),
    } as Parameters<typeof createNormalizedMessage>[0]));
  };

  if (entry.type === 'user') {
    if (typeof message.content === 'string') {
      const text = message.content;
      if (text.trim() && !isInternalContent(text)) {
        push({ id: `${baseId}_text`, kind: 'text', role: 'user', content: text });
      }
      return;
    }

    if (Array.isArray(message.content)) {
      let partIndex = 0;
      for (const part of message.content as AnyRecord[]) {
        partIndex += 1;
        if (part?.type === 'tool_result') {
          push({
            id: `${baseId}_tr_${part.tool_use_id ?? partIndex}`,
            kind: 'tool_result',
            toolId: part.tool_use_id,
            content: toolResultText(part.content),
            isError: Boolean(part.is_error),
            images: extractToolResultImages(part.content),
          });
        } else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim() && !isInternalContent(part.text)) {
          push({ id: `${baseId}_text_${partIndex}`, kind: 'text', role: 'user', content: part.text });
        }
      }
    }
    return;
  }

  // assistant
  if (typeof message.content === 'string') {
    if (message.content.trim()) {
      push({ id: `${baseId}_text`, kind: 'text', role: 'assistant', content: message.content });
    }
    return;
  }

  if (Array.isArray(message.content)) {
    let partIndex = 0;
    for (const part of message.content as AnyRecord[]) {
      partIndex += 1;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        push({ id: `${baseId}_text_${partIndex}`, kind: 'text', role: 'assistant', content: part.text });
      } else if (part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
        push({ id: `${baseId}_think_${partIndex}`, kind: 'thinking', content: part.thinking });
      } else if (part?.type === 'tool_use') {
        push({
          id: `${baseId}_tool_${part.id ?? partIndex}`,
          kind: 'tool_use',
          toolId: part.id,
          toolName: part.name,
          toolInput: part.input,
        });
      }
    }
  }
}

/**
 * Resolves one subagent transcript path across CLI layouts: current releases
 * nest them under `<projectDir>/<providerSessionId>/subagents/`; older releases
 * wrote them flat next to the session transcript.
 */
function resolveAgentTranscriptPath(projectDir: string, providerSessionId: string | null, taskId: string): string {
  const fileName = `agent-${taskId}.jsonl`;
  const candidates = [
    ...(providerSessionId ? [path.join(projectDir, providerSessionId, 'subagents', fileName)] : []),
    path.join(projectDir, fileName),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

function agentMetaPathFor(transcriptPath: string): string {
  return transcriptPath.endsWith('.jsonl')
    ? `${transcriptPath.slice(0, -'.jsonl'.length)}.meta.json`
    : `${transcriptPath}.meta.json`;
}

function readAgentMeta(transcriptPath: string): AnyRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(agentMetaPathFor(transcriptPath), 'utf-8')) as AnyRecord;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Background Agent launches echo the agent id inside the tool_result text trailer. */
function extractAgentIdFromResultContent(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as AnyRecord[]).map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
      : '';
  const match = /agentId:\s*([A-Za-z0-9_-]{4,64})/.exec(text);
  return match ? match[1] : null;
}

/** Tolerant reader for a completed Agent tool_result's aggregate usage. */
function readSubagentUsageFromToolResult(toolUseResult: unknown): SubagentSummary['usage'] {
  if (!toolUseResult || typeof toolUseResult !== 'object') {
    return null;
  }
  const usage = (toolUseResult as AnyRecord).usage;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const read = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    totalTokens: read((usage as AnyRecord).total_tokens),
    toolUses: read((usage as AnyRecord).tool_uses),
    durationMs: read((usage as AnyRecord).duration_ms),
  };
}

/**
 * Background tasks report completion through `<task-notification>` XML carried
 * by `queued_command` attachment entries (commandMode 'task-notification').
 * Those are the authoritative completion signal for background agents — their
 * Agent tool_result is only the immediate `async_launched` ack.
 */
type AgentNotification = {
  taskId: string | null;
  toolUseId: string | null;
  status: string | null;
  timestamp: string | null;
  usage: SubagentSummary['usage'];
};

function parseAgentNotificationAttachment(entry: AnyRecord): AgentNotification | null {
  const attachment = entry.attachment as AnyRecord | undefined;
  if (!attachment || attachment.type !== 'queued_command' || attachment.commandMode !== 'task-notification') {
    return null;
  }
  const prompt = typeof attachment.prompt === 'string' ? attachment.prompt : '';
  if (!prompt.includes('<task-notification>')) {
    return null;
  }

  const readTag = (tag: string): string | null => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(prompt);
    return match ? match[1].trim() : null;
  };

  let usage: SubagentSummary['usage'] = null;
  const usageBlock = readTag('usage');
  if (usageBlock) {
    const readNumber = (key: string): number => {
      const match = new RegExp(`${key}[^0-9]*([0-9]+)`).exec(usageBlock);
      return match ? Number(match[1]) : 0;
    };
    const totalTokens = readNumber('total_tokens');
    const toolUses = readNumber('tool_uses');
    const durationMs = readNumber('duration_ms');
    if (totalTokens || toolUses || durationMs) {
      usage = { totalTokens, toolUses, durationMs };
    }
  }

  return {
    taskId: readTag('task-id'),
    toolUseId: readTag('tool-use-id'),
    status: readTag('status'),
    timestamp: typeof entry.timestamp === 'string'
      ? entry.timestamp
      : (typeof attachment.timestamp === 'string' ? attachment.timestamp : null),
    usage,
  };
}

function mapNotificationStatus(status: string | null): SubagentSummary['status'] | null {
  if (status === 'completed' || status === 'failed' || status === 'stopped') {
    return status;
  }
  return null;
}

/**
 * Enumerates a session's subagents by merging three views: the agent-*.jsonl
 * transcripts on disk (current `<sessionId>/subagents/` layout, legacy flat
 * fallback), their meta.json companions, and the Agent/Task tool calls in the
 * main transcript (prompt/name/description plus the completion tool_result).
 */
async function listSubagentsForSession(jsonlPath: string, providerSessionId: string): Promise<SubagentSummary[]> {
  const projectDir = path.dirname(jsonlPath);

  // 1) Transcript files across CLI layouts
  const files: Array<{ taskId: string; filePath: string }> = [];
  const collectFrom = async (dir: string): Promise<void> => {
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^agent-([A-Za-z0-9_-]{4,64})\.jsonl$/.exec(name);
      if (match && !files.some((file) => file.taskId === match[1])) {
        files.push({ taskId: match[1], filePath: path.join(dir, name) });
      }
    }
  };
  await collectFrom(path.join(projectDir, providerSessionId, 'subagents'));
  if (files.length === 0) {
    await collectFrom(projectDir);
  }
  if (files.length === 0) {
    return [];
  }

  const metas = new Map<string, AnyRecord | null>();
  for (const file of files) {
    metas.set(file.taskId, readAgentMeta(file.filePath));
  }
  const fileByToolUseId = new Map<string, { taskId: string; filePath: string }>();
  const fileByTaskId = new Map<string, { taskId: string; filePath: string }>();
  for (const file of files) {
    fileByTaskId.set(file.taskId, file);
    const toolUseId = metas.get(file.taskId)?.toolUseId;
    if (typeof toolUseId === 'string' && toolUseId) {
      fileByToolUseId.set(toolUseId, file);
    }
  }

  // 2) Agent calls + results from the main transcript
  type AgentCall = {
    toolUseId: string;
    description: string | null;
    subagentType: string | null;
    name: string | null;
    prompt: string | null;
    runInBackground: boolean;
    timestamp: string | null;
  };
  const agentCalls: AgentCall[] = [];
  const results = new Map<string, { isError: boolean; isAsyncAck: boolean; agentId: string | null; timestamp: string | null; toolUseResult: unknown }>();
  // 后台任务的完成通知：按 toolUseId 与 taskId 双键索引，后到者覆盖（同一
  // task 恢复后可多次通知，最新一次为准）。
  const notificationsByToolUseId = new Map<string, AgentNotification>();
  const notificationsByTaskId = new Map<string, AgentNotification>();

  try {
    const entries = await readTranscriptEntries(jsonlPath);
    for (const entry of entries) {
      if (entry.sessionId && providerSessionId && entry.sessionId !== providerSessionId) {
        continue;
      }
      const content = entry.message?.content;
      if (entry.message?.role === 'assistant' && Array.isArray(content)) {
        for (const part of content as AnyRecord[]) {
          if (part?.type === 'tool_use' && (part.name === 'Agent' || part.name === 'Task')) {
            const input = (part.input || {}) as AnyRecord;
            agentCalls.push({
              toolUseId: String(part.id ?? ''),
              description: typeof input.description === 'string' ? input.description : null,
              subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : null,
              name: typeof input.name === 'string' && input.name ? input.name : null,
              prompt: typeof input.prompt === 'string' ? input.prompt : null,
              runInBackground: Boolean(input.run_in_background),
              timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
            });
          }
        }
      } else if (entry.message?.role === 'user' && Array.isArray(content)) {
        for (const part of content as AnyRecord[]) {
          if (part?.type !== 'tool_result' || !part.tool_use_id) {
            continue;
          }
          const toolUseResult = entry.toolUseResult as AnyRecord | undefined;
          const agentId = typeof toolUseResult?.agentId === 'string' && toolUseResult.agentId
            ? toolUseResult.agentId
            : extractAgentIdFromResultContent(part.content);
          results.set(String(part.tool_use_id), {
            isError: Boolean(part.is_error),
            // 后台 Agent 的 tool_result 只是 async_launched 回执，不是完成信号。
            isAsyncAck: toolUseResult?.isAsync === true || toolUseResult?.status === 'async_launched',
            agentId,
            timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
            toolUseResult: entry.toolUseResult,
          });
        }
      } else if (entry.type === 'attachment') {
        const notification = parseAgentNotificationAttachment(entry);
        if (notification) {
          if (notification.toolUseId) {
            notificationsByToolUseId.set(notification.toolUseId, notification);
          }
          if (notification.taskId) {
            notificationsByTaskId.set(notification.taskId, notification);
          }
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ClaudeProvider] Failed to read agent calls for ${jsonlPath}:`, message);
  }

  // 3) Assemble: transcript calls in order, then orphan files by mtime
  const summaries: SubagentSummary[] = [];
  const consumed = new Set<string>();

  for (const call of agentCalls) {
    const result = results.get(call.toolUseId) ?? null;
    const file = fileByToolUseId.get(call.toolUseId)
      ?? (result?.agentId ? fileByTaskId.get(result.agentId) : undefined)
      ?? null;
    const meta = file ? metas.get(file.taskId) ?? null : null;
    if (file) {
      consumed.add(file.taskId);
    }

    const taskId = file?.taskId ?? result?.agentId ?? null;
    const notification = notificationsByToolUseId.get(call.toolUseId)
      ?? (taskId ? notificationsByTaskId.get(taskId) : undefined)
      ?? null;
    const completedResult = result && !result.isAsyncAck ? result : null;

    let status: SubagentSummary['status'];
    if (meta?.stoppedByUser === true) {
      status = 'stopped';
    } else if (mapNotificationStatus(notification?.status ?? null)) {
      status = mapNotificationStatus(notification?.status ?? null) as SubagentSummary['status'];
    } else if (completedResult) {
      status = completedResult.isError ? 'failed' : 'completed';
    } else {
      status = 'running';
    }

    summaries.push({
      taskId: taskId ?? call.toolUseId,
      toolUseId: call.toolUseId || null,
      agentType: (typeof meta?.agentType === 'string' && meta.agentType) || call.subagentType,
      description: (typeof meta?.description === 'string' && meta.description) || call.description,
      name: call.name,
      prompt: call.prompt,
      status,
      isBackgrounded: call.runInBackground || meta?.requestShape === 'background',
      spawnDepth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : null,
      startedAt: call.timestamp,
      endedAt: notification?.timestamp ?? completedResult?.timestamp ?? null,
      usage: notification?.usage ?? (completedResult ? readSubagentUsageFromToolResult(completedResult.toolUseResult) : null),
      hasConversation: Boolean(file),
    });
  }

  for (const file of files) {
    if (consumed.has(file.taskId)) {
      continue;
    }
    const meta = metas.get(file.taskId);
    const notification = notificationsByTaskId.get(file.taskId) ?? null;
    let startedAt: string | null = null;
    try {
      startedAt = fs.statSync(file.filePath).mtime.toISOString();
    } catch {
      startedAt = null;
    }
    summaries.push({
      taskId: file.taskId,
      toolUseId: typeof meta?.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : null,
      agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
      description: typeof meta?.description === 'string' ? meta.description : null,
      name: null,
      prompt: null,
      status: meta?.stoppedByUser === true
        ? 'stopped'
        : (mapNotificationStatus(notification?.status ?? null) ?? 'running'),
      isBackgrounded: meta?.requestShape === 'background',
      spawnDepth: typeof meta?.spawnDepth === 'number' ? meta.spawnDepth : null,
      startedAt,
      endedAt: notification?.timestamp ?? null,
      usage: notification?.usage ?? null,
      hasConversation: true,
    });
  }

  return summaries;
}

/** Loads one subagent's full conversation from its transcript file. */
async function getSubagentConversationForSession(
  sessionId: string,
  taskId: string,
  jsonlPath: string,
  providerSessionId: string,
): Promise<SubagentConversation | null> {
  const projectDir = path.dirname(jsonlPath);
  const filePath = resolveAgentTranscriptPath(projectDir, providerSessionId, taskId);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const { conversation } = await parseAgentFile(filePath);
  const meta = readAgentMeta(filePath);
  return {
    taskId,
    agentType: typeof meta?.agentType === 'string' ? meta.agentType : null,
    description: typeof meta?.description === 'string' ? meta.description : null,
    messages: conversation.map((message) => ({ ...message, sessionId })),
  };
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // The DB row is keyed by the app-facing session id, while the JSONL rows
    // on disk carry the provider-native id — both ids are needed here.
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const projectDir = path.dirname(jsonLPath);

    const messages: AnyRecord[] = [];
    const agentToolsCache = new Map<string, AnyRecord[]>();

    // 历史 API 每次请求都重读+重解析整个 JSONL（多 MB 转录每次几十毫秒），
    // 而激活/刷新/回退后都会触发请求。mtime+size 未变化时直接复用解析结果。
    const allEntries = await readTranscriptEntries(jsonLPath);

    for (const entry of allEntries) {
      if (entry.sessionId === providerSessionId) {
        messages.push(entry);
      }
    }

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    for (const agentId of agentIds) {
      // 子代理转录在 CLI 新布局里位于 <会话id>/subagents/，旧布局在项目根目录
      const agentFilePath = resolveAgentTranscriptPath(projectDir, providerSessionId, agentId);
      if (!fs.existsSync(agentFilePath)) {
        continue;
      }

      const { tools } = await parseAgentFile(agentFilePath);
      agentToolsCache.set(agentId, tools);
    }

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const agentTools = agentToolsCache.get(String(agentId));
      if (agentTools && agentTools.length > 0) {
        message.subagentTools = agentTools;
      }
    }

    const sortedMessages = messages.sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 *
 * Skill bodies belong in the first group. When a skill is invoked, Claude
 * injects the entire SKILL.md as a synthetic user turn. Persisted transcripts
 * tag it `isMeta: true`, but the live SDK stream does not, so without a
 * content-level check the same payload renders as a huge user bubble during the
 * run and then vanishes on reload. The skill is already represented by the
 * `Skill` tool call, so it is never user-visible content.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * Claude local-command stdout may contain ANSI styling codes because it was
 * captured from the terminal. The web chat should receive readable plain text.
 */
function stripAnsiFormatting(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Extracts the display text of a tool_result content payload. Text blocks are
 * joined; payloads without text fall back to JSON so nothing is silently lost.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const textParts = (content as AnyRecord[])
      .filter((part) => part?.type === 'text' && part.text)
      .map((part) => String(part.text));
    if (textParts.length > 0) {
      return textParts.join('\n');
    }
  }
  return JSON.stringify(content);
}

/**
 * Extracts inline images from a tool_result content payload as data URLs.
 *
 * MCP tools can return `image` blocks next to text (e.g. the Browser MCP
 * screenshot tools); the chat renders them as pictures, so they must survive
 * normalization instead of being flattened into the text content.
 */
export function extractToolResultImages(content: unknown): Array<{ data: string }> | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const images: Array<{ data: string }> = [];
  for (const part of content as AnyRecord[]) {
    if (part?.type !== 'image') {
      continue;
    }
    const source = part.source as AnyRecord | undefined;
    if (source?.type === 'base64' && typeof source.data === 'string') {
      const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      images.push({ data: `data:${mediaType};base64,${source.data}` });
    } else if (typeof part.data === 'string') {
      // Tolerate flat `{ type: 'image', data, mimeType }` blocks.
      const mediaType = typeof part.mimeType === 'string' ? part.mimeType : 'image/png';
      images.push({ data: `data:${mediaType};base64,${part.data}` });
    }
  }
  return images.length > 0 ? images : undefined;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    if (raw.type === 'content_block_delta' && raw.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: raw.delta.text, sessionId, provider: PROVIDER })];
    }
    if (raw.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {
      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;
        let filesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: toolResultText(part.content),
              images: extractToolResultImages(part.content),
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            const parsedFiles = parseFilesInputTag(text);
            if (
              (parsedFiles.text || parsedFiles.attachments.length > 0)
              && !isInternalContent(parsedFiles.text)
            ) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: parsedFiles.text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
                files: !filesAttached && parsedFiles.attachments.length > 0
                  ? parsedFiles.attachments
                  : undefined,
              }));
              imagesAttached = true;
              filesAttached = filesAttached || parsedFiles.attachments.length > 0;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiFormatting(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        const parsedFiles = parseFilesInputTag(text);
        if (
          (parsedFiles.text || parsedFiles.attachments.length > 0)
          && !isInternalContent(parsedFiles.text)
        ) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: parsedFiles.text,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    /**
     * 本地命令被拒或无法执行时（如 /compact 压缩空间不足），CLI 以
     * system/local_command 行给出说明。转成普通文本下发，否则点压缩按钮
     * 「没有任何反应」，用户看不到失败原因。
     */
    if (raw.type === 'system' && raw.subtype === 'local_command') {
      const stdout = typeof raw.content === 'string'
        ? extractTaggedContent(raw.content, 'local-command-stdout')
        : null;
      if (stdout !== null) {
        const stdoutText = stripAnsiFormatting(stdout).trim();
        if (stdoutText) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: stdoutText,
            isLocalCommandStdout: true,
          }));
        }
      }
      return messages;
    }

    return messages;
  }

  /**
   * Enumerates the session's subagents for the Agents panel. Always resolves —
   * missing transcripts or parse failures yield an empty list.
   */
  async listSubagents(
    sessionId: string,
    options: FetchSubagentsOptions = {},
  ): Promise<SubagentSummary[]> {
    try {
      const row = sessionsDb.getSessionById(sessionId);
      const jsonlPath = row?.jsonl_path;
      if (!jsonlPath) {
        return [];
      }
      const providerSessionId = options.providerSessionId ?? row?.provider_session_id ?? sessionId;
      return await listSubagentsForSession(jsonlPath, providerSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to list subagents for ${sessionId}:`, message);
      return [];
    }
  }

  /**
   * Loads one subagent's full conversation. Returns null when the transcript
   * is missing or the id is malformed.
   */
  async fetchSubagentConversation(
    sessionId: string,
    taskId: string,
    options: FetchSubagentsOptions = {},
  ): Promise<SubagentConversation | null> {
    try {
      // 白名单：taskId 直接拼文件名，禁止路径字符
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(taskId)) {
        return null;
      }
      const row = sessionsDb.getSessionById(sessionId);
      const jsonlPath = row?.jsonl_path;
      if (!jsonlPath) {
        return null;
      }
      const providerSessionId = options.providerSessionId ?? row?.provider_session_id ?? sessionId;
      return await getSubagentConversationForSession(sessionId, taskId, jsonlPath, providerSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load subagent conversation for ${sessionId}:`, message);
      return null;
    }
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, providerSessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    // Aborted runs wind down gracefully and flush their nearly complete turn
    // into the transcript AFTER the abort. Prune that post-abort window so the
    // interrupted output cannot resurface on the next refresh (see
    // aborted-turns.ts). No-op for sessions without recorded aborts.
    const servedMessages = filterPostAbortTranscriptEntries(
      rawMessages,
      getAbortedTurnTimestamps(sessionId),
    );

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of servedMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const normalized: NormalizedMessage[] = [];
    for (const raw of servedMessages) {
      normalized.push(...this.normalizeMessage(raw, sessionId));
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: toolResultText(toolResult.content),
          isError: toolResult.isError,
          images: extractToolResultImages(toolResult.content),
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
      }
    }

    let total = 0;
    for (const msg of normalized) {
      if (msg.kind !== 'tool_result') {
        total += 1;
      }
    }
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
