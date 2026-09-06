/**
 * Rewind 服务（内置，原 plugins/claude-rewind 后端移植）
 * =====================================================
 * 职责：
 *   1. 从转录 jsonl 定位目标用户消息（timestamp+内容前缀 匹配，取后代最多者=活跃分支）
 *   2. 截断转录：丢弃目标消息及其所有后代，保留其祖先链（原子写入，先备份）
 *   3. 文件恢复：按 file-history-snapshot / file-history-delta 记录重建目标时刻的
 *      文件状态并还原（后来新建的文件删除）
 *
 * 数据来源（均已实测验证，见 plugins/claude-rewind/docs/修复指南.md 的 git 历史）：
 *   - 转录路径：sessionsDb 会话行 jsonl_path 列
 *   - 快照备份：~/.claude/file-history/<provider_session_id>/<hash>@v<N>
 *
 * 纯函数（定位/匹配/恢复计划）与 IO（读转录/写截断/还原文件）分离，
 * 纯函数随 tests/rewind.service.test.ts 覆盖。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type TranscriptEntry = {
  [key: string]: unknown;
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  timestamp?: unknown;
  isSidechain?: boolean;
  sessionId?: string;
  cwd?: string;
  message?: { content?: unknown } | null;
  snapshot?: { trackedFileBackups?: Record<string, { backupFileName?: string | null } | undefined> } | null;
  trackingPath?: string;
  backup?: { backupFileName?: string | null } | null;
};

export type SessionRow = {
  session_id: string;
  provider_session_id: string | null;
  jsonl_path: string | null;
};

export type LocateParams = { timestamp: unknown; textPrefix: unknown };
export type RestorePlan = {
  restore: { filePath: string; backupPath: string }[];
  remove: { filePath: string }[];
};

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------
// 转录解析
// ---------------------------------------------------------------------------
export async function readTranscript(jsonlPath: string): Promise<TranscriptEntry[]> {
  const raw = await fsp.readFile(jsonlPath, 'utf8');
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      /* 并发写入可能产生残行，跳过 */
    }
  }
  return entries;
}

/** 构建父链索引：uuid -> parentUuid */
function buildParentMap(entries: TranscriptEntry[]): Map<string, string | null> {
  const parents = new Map<string, string | null>();
  for (const e of entries) {
    if (e.uuid) parents.set(e.uuid, e.parentUuid || null);
  }
  return parents;
}

/**
 * 归一化文本用于宽松比对：去掉标签/markdown 标记符号并折叠空白。
 * 前端气泡 textContent 是 markdown 渲染后的产物（**bold**→bold、`code`→code、
 * 列表符丢失等），且会剥离 <files> 等包裹标签，与转录原文直接 startsWith 会
 * 失配——这是「找不到这条消息」的根因，故两侧都归一化后再比。
 */
export function normalizeForMatch(text: unknown): string {
  return String(text || '')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/[*_`~[\]()#>|-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 时间戳归一为毫秒纪元。转录与前端可能是 ISO 字符串、Date 序列化串、
 * 秒/毫秒纪元数字，老版本前端还传过 NaN→null（必须判无效）。
 */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value; // 毫秒纪元
    if (value > 1e9) return value * 1000; // 秒纪元
    return null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function timestampsMatch(a: unknown, b: unknown): boolean {
  const ta = toEpochMs(a);
  const tb = toEpochMs(b);
  if (ta === null || tb === null) return false;
  return Math.abs(ta - tb) <= 2000;
}

/** 提取用户消息纯文本：content 可能是字符串，也可能是 [{type:'text',text}] 数组 */
function extractUserText(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * 目标候选 = 主链上 type==='user' 且 uuid 存在、时间戳与内容前缀匹配的消息。
 * 用户在 CLI 里编辑过消息会产生兄弟分支（同时间戳同文本），取「后代数量最多」
 * 的候选即当前活跃分支（已用真实转录验证）。
 *
 * 匹配策略（逐级放宽）：
 *   1. 时间戳精确 + 归一化内容前缀匹配
 *   2. 仅时间戳匹配（前端渲染差异过大时兜底；多候选仍按活跃分支挑）
 */
export function locateTargetMessage(entries: TranscriptEntry[], { timestamp, textPrefix }: LocateParams): TranscriptEntry | null {
  const candidates: TranscriptEntry[] = [];
  for (const e of entries) {
    if (e.type !== 'user' || !e.uuid || e.isSidechain === true) continue;
    candidates.push(e);
  }

  const pickMostDescendants = (candidatesSubset: TranscriptEntry[]): TranscriptEntry | null => {
    if (candidatesSubset.length === 0) return null;
    const parents = buildParentMap(entries);
    const descendantCount = (uuid: string): number => {
      let count = 0;
      for (const e of entries) {
        let cur: string | null | undefined = e.uuid;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          if (cur === uuid) {
            count++;
            break;
          }
          seen.add(cur);
          cur = parents.get(cur);
        }
      }
      return count;
    };
    candidatesSubset.sort((a, b) => descendantCount(b.uuid!) - descendantCount(a.uuid!));
    return candidatesSubset[0];
  };

  const hasTimestamp = timestamp !== null && timestamp !== undefined && timestamp !== '';
  const prefix = normalizeForMatch(textPrefix).slice(0, 50);

  // 第一级：时间戳（±2s 容差）+ 归一化内容前缀
  if (prefix && hasTimestamp) {
    const hit = pickMostDescendants(candidates.filter((e) =>
      timestampsMatch(e.timestamp, timestamp)
      && normalizeForMatch(extractUserText(e)).startsWith(prefix)));
    if (hit) return hit;
  }

  // 第二级：仅时间戳兜底（前端渲染差异过大时；多候选按活跃分支挑）
  if (hasTimestamp) {
    const hit = pickMostDescendants(candidates.filter((e) => timestampsMatch(e.timestamp, timestamp)));
    if (hit) return hit;
  }

  // 第三级：仅内容前缀兜底——只在查询时间戳本身无法解析时使用
  // （历史消息时间戳应可靠；时间戳有效却无匹配 → 判定不存在，绝不按前缀瞎猜，
  //   否则重复文本的消息会定位到错误回合并截断错内容）
  if (prefix && toEpochMs(timestamp) === null) {
    const hit = pickMostDescendants(candidates.filter((e) =>
      normalizeForMatch(extractUserText(e)).startsWith(prefix)));
    if (hit) return hit;
  }

  return null;
}

/** 目标的后代集合（含自身）——截断时要丢弃的全部条目 */
function collectDescendants(entries: TranscriptEntry[], targetUuid: string): TranscriptEntry[] {
  const parents = buildParentMap(entries);
  const dropped: TranscriptEntry[] = [];
  for (const e of entries) {
    let cur: string | null | undefined = e.uuid;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === targetUuid) {
        dropped.push(e);
        break;
      }
      seen.add(cur);
      cur = parents.get(cur);
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// 截断
// ---------------------------------------------------------------------------
export async function truncateTranscript(
  jsonlPath: string,
  entries: TranscriptEntry[],
  targetUuid: string,
): Promise<{ backupPath: string; dropped: number; kept: number }> {
  const dropSet = new Set(collectDescendants(entries, targetUuid).map((e) => entries.indexOf(e)));
  const keptLines: string[] = [];
  entries.forEach((e, idx) => {
    if (!dropSet.has(idx)) keptLines.push(JSON.stringify(e));
  });

  const backupPath = `${jsonlPath}.bak-rewind-${Date.now()}`;
  await fsp.copyFile(jsonlPath, backupPath);
  await fsp.writeFile(jsonlPath, keptLines.join('\n') + '\n', 'utf8');
  return { backupPath, dropped: dropSet.size, kept: keptLines.length };
}

// ---------------------------------------------------------------------------
// 文件恢复
// ---------------------------------------------------------------------------
/**
 * 重建「目标消息时刻」的文件跟踪表。
 *
 * 快照语义（2026-08-26 用真实转录逆向确认，见插件 docs/修复指南.md 的 git 历史）：
 *   - snapshot(M).trackedFileBackups = M 所在回合【开始前】的全量文件状态
 *     （物理写入位置在回合中部，但语义是回合起点）
 *   - backupFileName 有值 → 该时刻文件存在，备份在 file-history/<名字>
 *   - backupFileName null → 该时刻文件不存在（新建文件的记录方式）
 *   - delta(M, base=S, trackingPath) → 在快照 S 基础上单路径变更
 *
 * 恢复算法：
 *   1. 在目标回合内（targetIdx 到下一个 user 之间）找第一个 snapshot —— 它就是
 *      目标回合开始前的状态（最准）；
 *   2. 回合内没有 snapshot，则取 targetIdx 之前最后一个 snapshot 为基，
 *      再顺序应用其后的 delta；
 *   3. 表中路径：有备份→恢复；null→目标时刻不存在→现存则删除；
 *   4. 目标之后才出现的跟踪路径 → 目标之后新建 → 删除。
 */
export function buildRestorePlan(
  entries: TranscriptEntry[],
  targetUuid: string,
  checkpointDir: string,
  body: { cwd?: string } = {},
): RestorePlan {
  const tIdx = entries.findIndex((e) => e.uuid === targetUuid);
  if (tIdx < 0) return { restore: [], remove: [] };

  // 目标回合的结束位置：下一个非 sidechain 的 user 消息
  let turnEnd = entries.length;
  for (let i = tIdx + 1; i < entries.length; i++) {
    if (entries[i].type === 'user' && entries[i].isSidechain !== true) {
      turnEnd = i;
      break;
    }
  }

  const state = new Map<string, string | null>(); // path -> backupFileName | null

  // 规则 1：回合内的第一个 snapshot
  let foundSnapshot = false;
  for (let i = tIdx; i < turnEnd; i++) {
    const e = entries[i];
    if (e.type === 'file-history-snapshot' && e.snapshot) {
      for (const [k, v] of Object.entries(e.snapshot.trackedFileBackups || {})) {
        state.set(k, v?.backupFileName ?? null);
      }
      foundSnapshot = true;
      break;
    }
  }

  // 规则 2：回合内无 snapshot → 前置最后 snapshot + 其后 deltas
  if (!foundSnapshot) {
    let baseIdx = -1;
    for (let i = tIdx; i >= 0; i--) {
      if (entries[i].type === 'file-history-snapshot' && entries[i].snapshot) {
        baseIdx = i;
        break;
      }
    }
    if (baseIdx >= 0) {
      for (const [k, v] of Object.entries(entries[baseIdx].snapshot?.trackedFileBackups || {})) {
        state.set(k, v?.backupFileName ?? null);
      }
      for (let i = baseIdx + 1; i <= tIdx; i++) {
        const e = entries[i];
        if (e.type === 'file-history-delta' && e.trackingPath) {
          state.set(e.trackingPath, e.backup ? (e.backup.backupFileName ?? null) : null);
        }
      }
    }
    // baseIdx<0：整个转录无任何快照 → 空状态，仅靠 laterPaths 删新建文件
  }

  // 规则 4：目标之后出现的跟踪路径 = 之后新建 → 删除
  const laterPaths = new Set<string>();
  for (let i = tIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'file-history-snapshot' && e.snapshot) {
      for (const p of Object.keys(e.snapshot.trackedFileBackups || {})) laterPaths.add(p);
    } else if (e.type === 'file-history-delta' && e.trackingPath) {
      laterPaths.add(e.trackingPath);
    }
  }

  const restore: { filePath: string; backupPath: string }[] = [];
  const remove: { filePath: string }[] = [];
  // 相对路径（如 .claude\settings.local.json）以会话工作目录为基准解析
  const cwd = body.cwd || undefined;
  const resolvePath = (p: string) => (path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p));
  for (const [filePath, backupName] of state.entries()) {
    if (backupName) {
      restore.push({ filePath: resolvePath(filePath), backupPath: path.join(checkpointDir, backupName) });
    } else {
      remove.push({ filePath: resolvePath(filePath) }); // 目标时刻不存在 → 新建于其后 → 删除
    }
  }
  for (const p of laterPaths) {
    if (!state.has(p)) remove.push({ filePath: resolvePath(p) });
  }
  return { restore, remove };
}

export async function applyRestorePlan(plan: RestorePlan): Promise<{ restored: string[]; removed: string[]; errors: string[] }> {
  const result = { restored: [] as string[], removed: [] as string[], errors: [] as string[] };
  for (const item of plan.restore) {
    try {
      await fsp.copyFile(item.backupPath, item.filePath);
      result.restored.push(item.filePath);
    } catch (err) {
      result.errors.push(`${item.filePath}: ${(err as Error).message}`);
    }
  }
  for (const item of plan.remove) {
    try {
      await fsp.unlink(item.filePath);
      result.removed.push(item.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') result.errors.push(`${item.filePath}: ${(err as Error).message}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 会话级编排（路由层取会话行后调用；插件版 handleLocate/handleRewind 的移植）
// ---------------------------------------------------------------------------
export function checkpointDirFor(row: SessionRow): string {
  return path.join(CLAUDE_DIR, 'file-history', row.provider_session_id || '');
}

export async function locateInSession(
  row: SessionRow,
  params: LocateParams & { sessionId: string },
): Promise<{ found: boolean; uuid?: string; timestamp?: unknown; checkpointDir?: string; error?: string }> {
  if (!row.jsonl_path) return { found: false, error: 'session not found' };
  const entries = await readTranscript(row.jsonl_path);
  const target = locateTargetMessage(entries, params);
  if (!target) return { found: false };
  return {
    found: true,
    uuid: target.uuid,
    timestamp: target.timestamp,
    checkpointDir: checkpointDirFor(row),
  };
}

export type RewindResult = {
  ok: boolean;
  targetUuid?: string;
  truncated?: { backupPath: string; dropped: number; kept: number };
  files?: { restored: string[]; removed: string[]; errors: string[] };
  error?: string;
};

export async function rewindSession(
  row: SessionRow,
  body: { sessionId: string; targetUuid?: string; restoreFiles?: boolean; timestamp?: unknown; textPrefix?: unknown; cwd?: string },
): Promise<RewindResult> {
  if (!row.jsonl_path) return { ok: false, error: 'session not found in DB' };

  const entries = await readTranscript(row.jsonl_path);
  const target = body.targetUuid
    ? entries.find((e) => e.uuid === body.targetUuid)
    : locateTargetMessage(entries, body);
  if (!target || !target.uuid) return { ok: false, error: 'target message not found in transcript' };

  // 会话工作目录：优先客户端传入，否则取转录里该会话条目的 cwd 字段
  let cwd = body.cwd || null;
  if (!cwd) {
    for (const e of entries) {
      if (e.cwd && e.sessionId === row.provider_session_id) {
        cwd = e.cwd;
        break;
      }
    }
  }

  // 1. 截断
  const truncation = await truncateTranscript(row.jsonl_path, entries, target.uuid);

  // 2. 文件恢复（可选）
  let files = { restored: [] as string[], removed: [] as string[], errors: [] as string[] };
  if (body.restoreFiles !== false) {
    const checkpointDir = checkpointDirFor(row);
    if (fs.existsSync(checkpointDir)) {
      const plan = buildRestorePlan(entries, target.uuid, checkpointDir, { cwd: cwd || undefined });
      files = await applyRestorePlan(plan);
    }
  }

  return {
    ok: true,
    targetUuid: target.uuid,
    truncated: truncation,
    files,
  };
}
