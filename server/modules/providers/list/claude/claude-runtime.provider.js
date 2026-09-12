/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs, existsSync, createReadStream } from 'fs';
import readline from 'node:readline';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { markAbortedTurn } from '@/modules/providers/list/claude/aborted-turns.js';
import { createBackgroundWorkTracker } from '@/modules/providers/list/claude/background-work.js';
import { readClaudeSettingsContextWindow } from '@/shared/claude-context-window.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyBackgroundWorkCompleted,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();
// Query instances interrupted because a newer run took over their session id
// (see addSession). Their run loops must stay silent on wind-down: the map
// entry, the abort flag, and all client-facing events belong to the new run.
const supersededInstances = new WeakSet();
// Query instances killed via abort. interrupt() stops the CLI from *generating*,
// but everything it already generated (often the whole turn, buffered) still
// streams out of the generator afterwards — and the registry already sent the
// terminal `complete`. The run loop must swallow those leftovers, otherwise
// aborted content pops into the UI seconds after the user pressed stop.
const abortedInstances = new WeakSet();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

// interrupt() is a cooperative control request that can never settle when the
// CLI is wedged mid-API-call (agent-sdk-typescript #425); waiting forever on
// it would leave the abort handler hanging and the run generating. After this
// long the run is hard-killed via its AbortController instead.
const INTERRUPT_SETTLE_TIMEOUT_MS = 4000;

// How long background work is allowed to keep running after a turn ends. This drives
// two halves of the same behaviour:
//
//  1. Passed to the spawned CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, which is how
//     long it waits for still-running background *agents* before killing them.
//  2. A backstop on how long we hold the SDK's stdin open after a turn's `result`.
//     The SDK closes stdin as soon as a turn ends, and the CLI reads that EOF as
//     "print wind-down" — killing background *shells* after a short grace period,
//     which the ceiling above does not cover. Holding stdin open also lets the CLI
//     push follow-up turns (background-task completions, Monitor notifications,
//     scheduled wake-ups).
//
// The hold normally ends long before this: a turn with nothing outstanding closes
// stdin immediately, background work releases it as soon as it reports back or is
// stopped via TaskStop (the lifecycle tracker sees both), and a new turn supersedes
// the previous hold. This ceiling only catches background work that never reports
// at all, so an abandoned session cannot leak a CLI process forever. The timer
// resets on every message, so it measures silence, not total time.
const BG_WAIT_CEILING_MS = 30 * 60 * 1000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_PREDEFINED_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Cancels every still-pending tool approval owned by a session. Used when the
// run is aborted or winds down: an unanswered approval would otherwise park
// the SDK's canUseTool callback forever — holding the CLI process open,
// keeping the registry run alive, and serving ghost prompts to every
// reconnecting client via getPendingApprovalsForSession.
function cancelPendingApprovalsForSession(sessionId) {
  if (!sessionId) {
    return;
  }
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      resolver({ cancelled: true });
    }
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    // Token-boundary check: `Bash(ls:*)` must match bare `ls` and `ls -la`,
    // but not `lsblk` — a raw prefix match would let lookalike commands slip
    // through allow rules (and dodge deny rules) with no whitespace between.
    return command === allowedPrefix
      || (command.startsWith(allowedPrefix) && /\s/.test(command.charAt(allowedPrefix.length)));
  }

  return false;
}

/**
 * Rewind / 编辑重发会把转录截断到第一条消息之前——截空后的转录没有
 * 任何对话条目，resume 它 CLI 会报 "No conversation found with session ID"。
 * 检测这种状态，让本次运行降级为全新 CLI 会话（同一个应用会话继续）。
 * 没有转录文件时（新会话预分配流程）返回 true，保持原有 resume 行为。
 */
async function isTranscriptResumable(appSessionId) {
  try {
    const row = sessionsDb.getSessionById(appSessionId);
    if (!row?.jsonl_path || !existsSync(row.jsonl_path)) {
      return true;
    }
    // 只需确认「存在至少一条 user/assistant 条目」：流式逐行读、命中即退。
    // 原实现 readFileSync 全量 + 全行 JSON.parse 是同步阻塞——多 MB 转录时
    // 每次发消息都把事件循环卡住数百毫秒。
    const rl = readline.createInterface({
      input: createReadStream(row.jsonl_path, 'utf8'),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && (entry.type === 'user' || entry.type === 'assistant')) {
            return true;
          }
        } catch {
          return false;
        }
      }
      return false;
    } finally {
      rl.close();
    }
  } catch {
    return true;
  }
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(BG_WAIT_CEILING_MS) };

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  // [claude-rewind plugin] Enable file checkpointing so the rewind plugin can
  // restore files to any user message's state via ~/.claude/file-history.
  sdkOptions.enableFileCheckpointing = true;

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_PREDEFINED_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_PREDEFINED_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  if (providerSessionId) {
    sdkOptions.resume = providerSessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 * @param {Function} releaseInput - Closes the held stdin stream so the CLI can exit
 * @param {AbortController} abortController - Caller-owned hard-kill lever for this run
 */
function addSession(sessionId, queryInstance, writer = null, releaseInput = null, abortController = null) {
  const existing = activeSessions.get(sessionId);
  // A different live instance under the same key means an earlier run was
  // superseded without being stopped (e.g. an abort that raced run setup and
  // found nothing to interrupt). Overwriting it here would strand its
  // generator forever — this map entry is the only handle for interrupting
  // it. Stop it directly rather than via abortClaudeSDKSession, whose
  // session-keyed abortedSessionIds flag would be consumed by the new run
  // and suppress its terminal `complete`.
  const superseding = Boolean(
    existing && existing.status === 'active' && existing.instance && existing.instance !== queryInstance
  );
  if (superseding) {
    supersededInstances.add(existing.instance);
    Promise.resolve()
      .then(() => existing.instance.interrupt())
      .catch((error) => {
        console.error(`Error interrupting superseded run for session ${sessionId}:`, error?.message || error);
      });
    existing.abortController?.abort();
    existing.releaseInput?.();
  }
  const carried = superseding ? null : existing;
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: carried?.startTime || Date.now(),
    status: 'active',
    writer,
    // Re-registered mid-run once the provider session id lands; keep the closer.
    releaseInput: releaseInput || carried?.releaseInput || null,
    abortController: abortController || carried?.abortController || null
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

/**
 * Maps SDK task lifecycle system messages to the `subagent_event` payload the
 * Agents panel consumes. Returns null for every non-task message so callers
 * can forward unconditionally.
 */
function mapTaskEventToSubagentEvent(sdkMessage) {
  if (!sdkMessage || sdkMessage.type !== 'system') {
    return null;
  }
  const mapUsage = (usage) => (usage && typeof usage === 'object' ? {
    totalTokens: readNumber(usage.total_tokens),
    toolUses: readNumber(usage.tool_uses),
    durationMs: readNumber(usage.duration_ms)
  } : null);
  switch (sdkMessage.subtype) {
    case 'task_started':
      return {
        event: 'started',
        taskId: sdkMessage.task_id || null,
        toolUseId: sdkMessage.tool_use_id || null,
        description: sdkMessage.description || null,
        subagentType: sdkMessage.subagent_type || null,
        isBackgrounded: Boolean(sdkMessage.is_backgrounded),
        spawnDepth: typeof sdkMessage.spawn_depth === 'number' ? sdkMessage.spawn_depth : null,
        taskType: sdkMessage.task_type || null,
        prompt: typeof sdkMessage.prompt === 'string' ? sdkMessage.prompt : null,
        ambient: Boolean(sdkMessage.ambient),
        skipTranscript: Boolean(sdkMessage.skip_transcript)
      };
    case 'task_progress':
      return {
        event: 'progress',
        taskId: sdkMessage.task_id || null,
        toolUseId: sdkMessage.tool_use_id || null,
        description: sdkMessage.description || null,
        subagentType: sdkMessage.subagent_type || null,
        usage: mapUsage(sdkMessage.usage),
        lastToolName: sdkMessage.last_tool_name || null,
        summary: typeof sdkMessage.summary === 'string' ? sdkMessage.summary : null,
        ambient: Boolean(sdkMessage.ambient)
      };
    case 'task_updated':
      return {
        event: 'updated',
        taskId: sdkMessage.task_id || null,
        status: sdkMessage.patch?.status || null,
        endTime: typeof sdkMessage.patch?.end_time === 'number' ? sdkMessage.patch.end_time : null,
        isBackgrounded: typeof sdkMessage.patch?.is_backgrounded === 'boolean' ? sdkMessage.patch.is_backgrounded : null,
        description: sdkMessage.patch?.description || null
      };
    case 'task_notification':
      return {
        event: 'finished',
        taskId: sdkMessage.task_id || null,
        toolUseId: sdkMessage.tool_use_id || null,
        status: sdkMessage.status || null,
        usage: mapUsage(sdkMessage.usage),
        summary: typeof sdkMessage.summary === 'string' ? sdkMessage.summary : null,
        ambient: Boolean(sdkMessage.ambient)
      };
    default:
      return null;
  }
}

// 任务系统的任务是全会话可见的：lead 或子代理启动的后台命令也会以任务事件
// 形式出现在流里（task_type 'local_bash'，子代理名下的还带
// owned_by_subagent），但它们不属于 Agents 面板——面板只呈现真正的子代理
// （task_type 'local_agent'）。2026-09-12 实案：审核子代理跑的 npm test /
// typecheck 被渲染成三张"agent 卡片"，面板看上去像单个 agent 的活动流水。
const NON_AGENT_TASK_TYPES = new Set(['local_bash']);

/**
 * 决定一条 subagent_event 是否转发给 Agents 面板，并把 taskId 的分类记入
 * 调用方持有的集合（按运行实例隔离）。
 *
 * 进程内事件有序：task_started 是每个任务的第一个事件，分类在那里一次完成；
 * 其余事件凭 taskId 归属。未分类的罕见事件保守丢弃（缺 started 的兜底：
 * 事件自带 subagent_type 时可即时补认为子代理）。
 *
 * @param {Object|null|undefined} subagentEvent - mapTaskEventToSubagentEvent 的输出
 * @param {Set<string>} agentTaskIds - 已确认的子代理任务
 * @param {Set<string>} nonAgentTaskIds - 已确认的非子代理任务
 * @returns {boolean} 是否应转发
 */
function classifySubagentEvent(subagentEvent, agentTaskIds, nonAgentTaskIds) {
  const taskId = subagentEvent?.taskId;
  if (!taskId) {
    return false;
  }
  if (nonAgentTaskIds.has(taskId)) {
    return false;
  }
  if (agentTaskIds.has(taskId)) {
    return true;
  }
  if (subagentEvent.taskType) {
    if (NON_AGENT_TASK_TYPES.has(subagentEvent.taskType)) {
      nonAgentTaskIds.add(taskId);
      return false;
    }
    agentTaskIds.add(taskId);
    return true;
  }
  if (subagentEvent.subagentType) {
    agentTaskIds.add(taskId);
    return true;
  }
  return false;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolves the effective context window for a message: SDK-reported model
 * capacity first, then a `[1m]`/`[200k]`-style model-id suffix, then the
 * configured CONTEXT_WINDOW, so the context percent is never nonsense.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {number} Context window size in tokens
 */
function resolveContextWindow(sdkMessage) {
  // Prefer the SDK-reported model context window (real model capacity). Falls
  // back to a `[1m]`/`[200k]`-style suffix on the model id, then to the
  // configured CONTEXT_WINDOW so the context percent is never nonsense.
  const modelUsage = sdkMessage?.modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    const modelKey = Object.keys(modelUsage)[0] || '';
    const modelData = modelUsage[modelKey];
    const reportedWindow = readNumber(modelData?.contextWindow);
    if (reportedWindow > 0) {
      return reportedWindow;
    }
    const millionMatch = /\[([0-9]+)m\]/.exec(modelKey);
    if (millionMatch) {
      return parseInt(millionMatch[1], 10) * 1_000_000;
    }
    const kiloMatch = /\[([0-9]+)k\]/.exec(modelKey);
    if (kiloMatch) {
      return parseInt(kiloMatch[1], 10) * 1_000;
    }
  }
  // Proxies rewrite model ids, so the suffix may be missing while
  // settings.json still records what the user actually selected.
  const settingsWindow = readClaudeSettingsContextWindow();
  if (settingsWindow > 0) {
    return settingsWindow;
  }
  return parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;
}

/**
 * @typedef {Object} TokenBudget
 * @property {number} used
 * @property {number} total
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} cacheTokens
 * @property {number} contextWindow
 * @property {number} contextPercent
 * @property {{input: number, output: number}} breakdown
 */

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {unknown} sdkMessage - SDK stream message
 * @returns {TokenBudget|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  // `result` 的 usage 是整个回合所有 API 调用的总和（费用口径），不是当前
  // 上下文占用。回合结束时用它刷新进度条就会虚高爆满，下一回合第一条
  // assistant 消息又把数值打回真实值——正是「莫名其妙爆满然后过一会恢复」。
  if (sdkMessage.type === 'result') {
    return null;
  }

  // 子代理（Task sidechain）的 usage 是它自己那条小上下文，混进来会让
  // 进度条无故回落后又跳回主线程真实值。
  if (sdkMessage.parent_tool_use_id) {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    // Context occupancy = what the next request will re-send: direct input
    // plus cached content. output_tokens is generation volume for THIS turn,
    // not context — counting it inflated the bar every turn.
    const inputTokens = directInputTokens + cacheTokens;
    const totalUsed = inputTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    // SDK placeholder assistant messages carry a zeroed usage snapshot while the
    // real numbers only arrive on the result message. Ignore zero snapshots so
    // they don't overwrite a previously shown real budget with 0.
    if (totalUsed <= 0) {
      return null;
    }
    const contextWindow = resolveContextWindow(sdkMessage);
    const contextPercent = Math.min(100, Math.max(0, Math.round((totalUsed / contextWindow) * 100)));

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      contextWindow,
      contextPercent,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage. modelUsage totals
  // are CUMULATIVE across turns, so they must never be presented as current
  // context occupancy — that made the bar creep toward full the longer the
  // session ran ("莫名爆满"). Report the window only when nothing better
  // exists is wrong; instead derive from the largest single-model context
  // window and refuse to fabricate a used figure we cannot trust.
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  return null;
}

// ===============================
// 会话级缓存命中统计（看板用）
// ===============================
// 按 provider 会话累计三个互不相交的输入桶：直连（未缓存）/ 缓存读 / 缓存写。
// 键是 provider 会话 id，进程生命周期内常驻——desktop 场景服务随应用重启，
// 每个条目只有三个数字，不主动清理也不会膨胀。应用重启或 resume 到新
// provider 会话时从零累计，口径是「本进程看到的该会话」。
// 防假 100 原则对齐 DSH 的 cacheHitPercent：只要存在未命中输入，
// 显示值封顶 99.9（一位小数口径），「100」严格保留给真·全命中。
const sessionCacheUsage = new Map();

/**
 * 把单次请求的 usage 累加进会话桶。三桶不相交（inputTokens = 直连 + 读 + 写），
 * 直接相加不重不漏；直连部分用差值还原并钳到非负，防上游报数异常把桶打负。
 * @param {{uncached: number, read: number, write: number}} acc 会话累计桶
 * @param {{inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number}} usage 单次请求快照
 */
function accumulateCacheUsage(acc, usage) {
  acc.uncached += Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheCreationTokens);
  acc.read += usage.cacheReadTokens;
  acc.write += usage.cacheCreationTokens;
}

/**
 * 会话累计缓存命中率（百分比，一位小数口径）。
 * @param {{uncached: number, read: number, write: number}} acc 会话累计桶
 * @returns {number|null} 命中率；尚无任何计费输入时为 null
 */
function computeSessionCacheHitPercent(acc) {
  const denominator = acc.uncached + acc.read + acc.write;
  if (denominator <= 0) return null;
  const missed = acc.uncached + acc.write;
  if (missed <= 0) return 100;
  const hit = (acc.read / denominator) * 100;
  // 舍入到一位小数后可能虚到 100.0（如 99.96%），此时压回 99.9
  return Math.min(99.9, Math.round(hit * 10) / 10);
}

// ===============================
// 上下文读数抖动抑制
// ===============================
// 中转/代理上游偶发上报「先掉近一半、下一条又弹回」的瞬时低值（实测
// 2026-09-11 的 DeepSeek 中转：322k → 177k → 323k，每次都发生在回合首条
// 请求），直接下发会让 Context 条来回蹦极。真实收缩只可能来自压缩/回退，
// 且必然连续出现低值——所以单条低值先压住不下发，下一条仍低才认定真实
// 收缩（压缩后由 resetContextUsageStabilizer 放行）；弹回则丢弃那条假低值。
const contextUsageStabilizers = new Map();

/**
 * 判定一条上下文占用样本是否可信、可下发。
 * @param {string|null} usageKey 会话键（provider 会话 id）
 * @param {number} used 新样本的上下文占用
 * @returns {boolean} true = 可信可发；false = 疑似抖动，本次压住
 */
function acceptContextUsageSample(usageKey, used) {
  if (!usageKey) {
    return true;
  }
  let state = contextUsageStabilizers.get(usageKey);
  if (!state) {
    state = { accepted: 0, pendingDrop: null };
    contextUsageStabilizers.set(usageKey, state);
  }
  if (state.pendingDrop !== null) {
    // 上一条低值之后仍低 → 真实收缩（压缩/回退），确认并接受；
    // 弹回则丢弃低值，直接接受新值。
    state.pendingDrop = null;
    state.accepted = used;
    return true;
  }
  if (state.accepted > 0 && used < state.accepted) {
    state.pendingDrop = used;
    return false;
  }
  state.accepted = used;
  return true;
}

/**
 * 压缩发生后调用：重置基线，让压缩后的低占用立即生效。
 * @param {string|null} usageKey 会话键（provider 会话 id）
 */
function resetContextUsageStabilizer(usageKey) {
  if (usageKey) {
    contextUsageStabilizers.delete(usageKey);
  }
}

/**
 * 是否压缩边界事件（上下文真实收缩的信号，绕开抑制直接放行）。
 * @param {Object} sdkMessage - SDK stream message
 * @returns {boolean}
 */
function isCompactBoundaryMessage(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return false;
  }
  return sdkMessage.subtype === 'compact_boundary' || sdkMessage.compact_result === 'success';
}

/**
 * 从压缩边界消息提取压缩后的上下文占用。
 * `compact_metadata.post_tokens` 是压缩后对话内容的 token 数，随边界消息一起
 * 到达——立即下发让 UI 的 Context 条在压缩完成瞬间收缩；缺了这一步就要等
 * 下一回合第一条 assistant 消息带 usage 才刷新，压缩完成后仍挂着旧高值。
 * post_tokens 缺失（旧版 CLI，或仅含 compact_result 的状态消息）时返回 null，
 * 调用方自然回退到下一回合刷新的旧行为。
 * @param {unknown} sdkMessage - SDK compact_boundary 消息
 * @returns {TokenBudget|null} 预算快照，或 null
 */
function extractCompactTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }
  const metadata = sdkMessage.compact_metadata || sdkMessage.compactMetadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const postTokens = readNumber(metadata.post_tokens ?? metadata.postTokens);
  if (postTokens <= 0) {
    return null;
  }
  const contextWindow = resolveContextWindow(sdkMessage);
  const contextPercent = Math.min(100, Math.max(0, Math.round((postTokens / contextWindow) * 100)));

  return {
    used: postTokens,
    total: contextWindow,
    inputTokens: postTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheTokens: 0,
    contextWindow,
    contextPercent,
    breakdown: {
      input: postTokens,
      output: 0,
    },
  };
}

/**
 * Builds the SDK user messages for one turn.
 *
 * Always returns SDKUserMessage records rather than a bare string: a string
 * prompt makes the SDK flag the query as single-turn and close stdin the moment
 * the turn's `result` arrives, which kills the CLI's background tasks. Plain
 * text turns carry string content; turns with image attachments carry the
 * prompt text plus one base64 `image` block per attachment (read from the
 * global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<Array<Object>>} SDKUserMessage records for the turn
 */
async function buildPromptMessages(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return [{
    type: 'user',
    message: {
      role: 'user',
      content
    },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString()
  }];
}

/**
 * Wraps prompt messages in an async iterable that yields them and then parks.
 *
 * The SDK closes the CLI's stdin as soon as its input iterable is exhausted (and
 * immediately on `result` for string prompts). The CLI reads that EOF as the end
 * of the run and kills anything still going in the background, so the iterable
 * has to stay pending until we actually want the process gone.
 *
 * @param {Array<Object>} messages - SDKUserMessage records to send
 * @returns {{ stream: AsyncIterable, release: () => void }} Stream plus its closer
 */
function createHeldPromptStream(messages) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });

  const stream = (async function* () {
    for (const message of messages) {
      yield message;
    }
    // Keeps stdin open — the CLI stays alive until release() is called.
    await held;
  })();

  return { stream, release };
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Provider-native id as the SDK reports it (starts as the resume id, or is
  // captured from the stream for brand-new sessions).
  let capturedSessionId = providerSessionId;
  let sessionCreatedSent = false;
  // Agents 面板的事件分类（见 classifySubagentEvent），仅本次运行有效
  const agentTaskIds = new Set();
  const nonAgentTaskIds = new Set();
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || capturedSessionId || null;

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  // Closes the held stdin stream so the CLI can wind down. Replaced once the
  // stream exists; the finally block calls it no matter how the run ends.
  let releasePromptStream = () => {};
  let idleReleaseTimer = null;
  // The client is told the turn is over as soon as `result` lands, even though
  // the process lingers, so the UI never waits out the idle hold.
  let turnCompleteSent = false;
  // Set when a turn starts background work, cleared when the next `result`
  // arrives — only turns with work still outstanding hold their process open.
  let backgroundWorkPending = false;
  // True while the process is being held open for background work, so a later
  // `result` can be recognised as that work reporting back.
  let heldForBackgroundWork = false;

  // Follows the background tasks this run started (start tool_use → task id in
  // the tool_result → TaskStop results) so the result branch below only keeps
  // the process held open while something can actually still report back.
  const backgroundWork = createBackgroundWorkTracker();

  // A new turn supersedes any earlier one still holding this session's process
  // open, so held runs cannot stack up across a conversation.
  if (sessionKey()) {
    getSession(sessionKey())?.releaseInput?.();
  }

  // Arms (or re-arms) the idle countdown that eventually closes stdin.
  const scheduleRelease = () => {
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      // 后台工作静默达上限：CLI 即将放行。若主回合的 complete 已发（带
      // backgroundHold、未终结 run），先补发一次收尾 complete——否则客户端
      // 的「Background task running」指示会永久残留（CLI 退出时的尾部兜底
      // 因 turnCompleteSent 已置位而不会再补）。
      if (heldForBackgroundWork && turnCompleteSent) {
        heldForBackgroundWork = false;
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      releasePromptStream();
    }, BG_WAIT_CEILING_MS);
    // Never let the hold keep the server process alive on its own.
    idleReleaseTimer.unref?.();
  };

  // Hoisted above the try so the catch's cleanup can tell whether this run
  // still owns the activeSessions entry (or was superseded by a newer run).
  let queryInstance = null;
  // Hoisted so the catch can hard-kill the subprocess on unexpected throws:
  // a wedged CLI may ignore stdin close and outlive the run indefinitely.
  let runAbortController = null;

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_PREDEFINED_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    // Rewind / 编辑重发可能把转录截断到第一条消息之前——清空后的转录没有
    // 对话条目，resume 它 CLI 会报 "No conversation found"。检测到就放弃
    // resume，以全新 CLI 会话继续同一个应用会话（新 id 回写数据库映射）。
    const resumeSkipped =
      Boolean(providerSessionId) && !(await isTranscriptResumable(sessionId));
    if (resumeSkipped) {
      console.warn(
        `[claude] transcript of ${providerSessionId} has no resumable conversation; starting a fresh conversation for app session ${sessionId}`
      );
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId: resumeSkipped ? null : providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Hard-kill lever for aborts. The SDK's internally-forwarded transport
    // signal only fires after its graceful-close path; the caller-owned
    // controller aborts immediately and tears the subprocess down for good.
    runAbortController = new AbortController();
    sdkOptions.abortController = runAbortController;

    // Every turn uses streaming input so stdin stays open past the turn's
    // `result`. The message list is reusable, but each query attempt needs its
    // own stream because an async generator cannot be replayed once consumed.
    const promptMessages = await buildPromptMessages(command, options.images, options.files, options.cwd);

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${sessionId || capturedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${sessionId || capturedSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: sessionId || capturedSessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    let heldPrompt = createHeldPromptStream(promptMessages);
    releasePromptStream = heldPrompt.release;
    try {
      queryInstance = query({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      // Discard the abandoned stream and build a fresh one for the retry.
      heldPrompt.release();
      heldPrompt = createHeldPromptStream(promptMessages);
      releasePromptStream = heldPrompt.release;
      queryInstance = query({
        prompt: heldPrompt.stream,
        options: sdkOptions
      });
    }

    // Track the query instance for abort capability
    if (sessionKey()) {
      addSession(sessionKey(), queryInstance, ws, releasePromptStream, runAbortController);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    for await (const message of queryInstance) {
      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(sessionKey(), queryInstance, ws, releasePromptStream, runAbortController);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for sessions with nothing to resume
        if (!providerSessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else if (resumeSkipped && message.session_id && message.session_id !== capturedSessionId) {
        // 全新对话回落：CLI 生成了新的 provider 会话 id，回写应用会话映射
        capturedSessionId = message.session_id;
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }
        try {
          sessionsDb.assignProviderSessionId(sessionId, capturedSessionId);
        } catch (mapError) {
          console.warn('[claude] Failed to re-point app session to the new provider session:', mapError);
        }
      } else {
        // session_id already captured
      }

      // 已打断或被顶替的实例：生成器可能还在吐出旧运行已生成的内容，全部
      // 吞掉（打断的终止 complete 已由打断流程发出；被顶替运行的一切客户端
      // 事件归新运行所有），这里不得再向客户端转发任何事件
      if (abortedInstances.has(queryInstance) || supersededInstances.has(queryInstance)) {
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = context.normalizeMessage(transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // 子代理生命周期事件（task_started/progress/updated/notification）：
      // 转发给前端 Agents 面板（ambient 任务由前端忽略）。分类器把后台
      // Bash 等非子代理任务留在门外——任务系统对它们同样会发事件。
      const subagentEvent = mapTaskEventToSubagentEvent(message);
      if (subagentEvent && classifySubagentEvent(subagentEvent, agentTaskIds, nonAgentTaskIds)) {
        ws.send(createNormalizedMessage({
          kind: 'subagent_event',
          provider: 'claude',
          sessionId: sid,
          subagentEvent
        }));
      }

      // 压缩边界：上下文真实收缩。重置抑制基线让后续低值立即生效，并立即
      // 下发压缩后的上下文占用（post_tokens 就在边界消息里）——否则 UI 的
      // Context 条要等下一回合第一条 assistant 消息才刷新，压缩完成后一段
      // 时间里仍挂着压缩前的高值。
      if (isCompactBoundaryMessage(message)) {
        const usageKey = capturedSessionId || sessionId || null;
        resetContextUsageStabilizer(usageKey);
        const compactBudget = extractCompactTokenBudget(message);
        if (compactBudget && acceptContextUsageSample(usageKey, compactBudget.used)) {
          const acc = usageKey ? sessionCacheUsage.get(usageKey) : null;
          if (acc) {
            compactBudget.sessionCacheHitPercent = computeSessionCacheHitPercent(acc);
          }
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: compactBudget, sessionId: usageKey, provider: 'claude' }));
        }
      }

      // Extract and send token budget updates from assistant/result usage payloads
      const tokenBudgetData = extractTokenBudget(message);
      // 抖动抑制：单条可疑低值先不发（见 acceptContextUsageSample 注释）
      if (tokenBudgetData && acceptContextUsageSample(capturedSessionId || sessionId || null, tokenBudgetData.used)) {
        // 会话累计缓存命中：按 provider 会话累积三桶后随 token_budget 一起下发
        const usageKey = capturedSessionId || sessionId || null;
        if (usageKey) {
          let acc = sessionCacheUsage.get(usageKey);
          if (!acc) {
            acc = { uncached: 0, read: 0, write: 0 };
            sessionCacheUsage.set(usageKey, acc);
          }
          accumulateCacheUsage(acc, tokenBudgetData);
          tokenBudgetData.sessionCacheHitPercent = computeSessionCacheHitPercent(acc);
        }
        ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: tokenBudgetData, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      }

      // Every message feeds the tracker: starts arrive as tool_use blocks,
      // task ids and TaskStop outcomes as the later tool_results.
      if (backgroundWork.track(message)) {
        backgroundWorkPending = true;
      }

      if (message.type === 'result') {
        const abortPending = sessionKey() ? abortedSessionIds.has(sessionKey()) : false;
        if (!turnCompleteSent && !abortPending) {
          turnCompleteSent = true;
          // 回合的主回复结束：complete 照旧立即发出（完成通知不等待后台），
          // 但若本回合启动了后台工作（进程将被保留、CLI 稍后还会推 follow-up
          // 输出），带上 backgroundHold 标记——registry 借此保持 run 为
          // running，客户端随即收到 status 事件把活动指示重新立起，避免
          // 「仍在输出但指示器已消失」的空窗。
          ws.send({
            ...createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }),
            ...(backgroundWorkPending ? { backgroundHold: true } : {}),
          });
          if (backgroundWorkPending) {
            ws.send(createNormalizedMessage({
              kind: 'status',
              text: 'Background task running',
              canInterrupt: true,
              sessionId: capturedSessionId || sessionId || null,
              provider: 'claude',
            }));
          }
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
        } else if (heldForBackgroundWork && !abortPending) {
          // A result after the turn already reported complete means the work we
          // held the process open for has finished and pushed a follow-up turn.
          // 真正的收尾：补发一次无标记的 complete——客户端活动指示落下、
          // registry 翻 completed（此前主回合的 complete 带 backgroundHold，
          // 未被去重、也未终结 run）。
          ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
          notifyBackgroundWorkCompleted({
            userId: ws?.userId || null,
            provider: 'claude',
            sessionId: sessionId || capturedSessionId || null,
            sessionName: sessionSummary
          });
        }
        if (backgroundWorkPending && !backgroundWork.hasLiveWork()) {
          // Everything the turn backgrounded was already retired (TaskStop) or
          // never started — nothing will ever report back, and holding would
          // strand the "Background task running" indicator until the ceiling.
          // Release immediately instead.
          backgroundWorkPending = false;
        }
        if (backgroundWorkPending) {
          // Work started during this turn is still running. Hold the process
          // open so it can finish and report back in a follow-up turn; the
          // ceiling is only a backstop for work that never reports.
          backgroundWorkPending = false;
          heldForBackgroundWork = true;
          scheduleRelease();
        } else {
          // Either nothing was backgrounded, or the background work just
          // reported in — let the CLI exit now, as it always has.
          heldForBackgroundWork = false;
          releasePromptStream();
        }
      } else if (idleReleaseTimer) {
        // Background activity after the turn — push the countdown back out.
        scheduleRelease();
      }
    }

    // Clean up session on completion — only while this run still owns the map
    // entry. A superseding run may have replaced it, and deleting here would
    // strand that run.
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    // A superseded run winds down silently: the map entry, the abort flag,
    // and all client-facing events belong to the run that replaced it.
    const superseded = supersededInstances.has(queryInstance);

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session, and
    // for runs that already reported completion when their `result` arrived.
    const wasAborted = !superseded && sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!turnCompleteSent && !superseded) {
      turnCompleteSent = true;
      if (!wasAborted) {
        ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 0 }));
      }
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'claude',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: wasAborted ? 'aborted' : 'completed'
      });
    }
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);
    // The generator threw while the CLI may still be alive (wedged mid-call,
    // ignoring the stdin close below). Tear the subprocess down for good —
    // a leftover process keeps burning quota and holds its MCP servers open.
    runAbortController?.abort();

    // Clean up session on error — only while this run still owns the map entry
    // (a superseding run may have replaced it).
    if (sessionKey() && getSession(sessionKey())?.instance === queryInstance) {
      removeSession(sessionKey());
    }

    if (supersededInstances.has(queryInstance)) {
      // Interrupted because a newer run took over this session id; that run
      // owns the abort flag and all further client-facing events.
      return;
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete. A run that already
    // reported completion and then failed during its post-turn hold still
    // surfaces the error, but must not emit a second terminal complete.
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    if (!turnCompleteSent) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: capturedSessionId || sessionId || null, exitCode: 1 }));
    }
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  } finally {
    // Always close stdin — otherwise an aborted or failed run leaves the CLI
    // process (and its MCP servers) alive until the server exits.
    if (idleReleaseTimer) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
    releasePromptStream();
    // Approvals still pending at teardown are ghosts: the run can no longer
    // act on them, and leaving them in the map serves dead prompts to
    // reconnecting clients and parks the canUseTool callback forever.
    cancelPendingApprovalsForSession(sessionKey());
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    // Mark before interrupting so the run loop knows not to emit its own
    // terminal complete (the abort handler sends the aborted one).
    abortedSessionIds.add(sessionId);
    // Per-instance kill mark: the run loop checks this to swallow the
    // already-generated leftovers the generator still yields after interrupt.
    abortedInstances.add(session.instance);
    // Un-park any pending tool approval first: a waiting canUseTool callback
    // holds the SDK mid-tool-call and keeps the CLI alive even after the
    // interrupt lands.
    cancelPendingApprovalsForSession(sessionId);
    // The CLI writes what it already generated — often the nearly complete
    // turn — into its transcript during wind-down, after this instant.
    // fetchHistory prunes that window so the flushed output cannot resurface.
    markAbortedTurn(sessionId);

    // interrupt() is a cooperative control request: it resolves but does
    // nothing during CLI startup (agent-sdk #429) and never settles when the
    // CLI is wedged mid-API-call (#425). Race it with a timeout and hard-kill
    // the subprocess on timeout or failure — a killed CLI cannot keep
    // generating, and it cannot flush its wind-down output either.
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`interrupt() did not settle within ${INTERRUPT_SETTLE_TIMEOUT_MS}ms`)),
          INTERRUPT_SETTLE_TIMEOUT_MS
        );
        timer.unref?.();
        Promise.resolve(session.instance.interrupt()).then(resolve, reject);
      });
    } catch (interruptError) {
      console.error(`interrupt() failed for session ${sessionId}, closing query generator:`, interruptError?.message || interruptError);
      session.abortController?.abort();
      await session.instance.return?.();
    }

    // Release the held stdin stream; without this the CLI stays up for the rest
    // of the post-turn hold even though the user cancelled.
    session.releaseInput?.();

    // Update session status
    session.status = 'aborted';

    // Clean up the map entry only while this run still owns it: a newer run
    // may have registered under the same key during the interrupt wait, and
    // deleting its entry would strand its only abort handle.
    if (getSession(sessionId)?.instance === session.instance) {
      removeSession(sessionId);
    }

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
/**
 * Stops one running subagent task (Agents panel stop button). The CLI emits a
 * task_notification with status 'stopped' when the stop lands, which the run
 * loop forwards as a subagent_event for the panel to consume.
 *
 * @param {string} sessionId - App-facing session id of the owning run
 * @param {string} taskId - Task id from task_started/task_notification events
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
const STOP_SUBAGENT_TIMEOUT_MS = 8000;
async function stopClaudeSubagentTask(sessionId, taskId) {
  const session = getSession(sessionId);
  const instance = session?.instance;
  if (!instance || typeof instance.stopTask !== 'function') {
    return { ok: false, error: 'no-active-run' };
  }

  let timer = null;
  try {
    // 控制请求没有超时（SDK 已知问题 #425）：mid-call 的 stopTask 可能永不
    // settle，race 一个超时兜底，别把 WS 处理器钉死。
    await Promise.race([
      instance.stopTask(taskId),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('stop timeout')), STOP_SUBAGENT_TIMEOUT_MS);
      })
    ]);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  // True while the CLI subprocess is still held open (including the
  // post-turn background-work hold) even after the registry already flipped
  // the run to completed — the window where a rewind must stay rejected.
  hasActiveProcess: isClaudeSDKSessionActive,
  stopSubagentTask: stopClaudeSubagentTask,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  stopClaudeSubagentTask,
  isClaudeSDKSessionActive,
  mapTaskEventToSubagentEvent,
  classifySubagentEvent,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter,
  extractTokenBudget,
  extractCompactTokenBudget,
  accumulateCacheUsage,
  computeSessionCacheHitPercent,
  acceptContextUsageSample,
  resetContextUsageStabilizer,
  matchesToolPermission
};
