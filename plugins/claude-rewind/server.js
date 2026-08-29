/**
 * Claude Rewind 插件后端
 * ======================
 * 职责：
 *   1. 从转录 jsonl 定位目标用户消息（timestamp+内容前缀 匹配，取后代最多者=活跃分支）
 *   2. 截断转录：丢弃目标消息及其所有后代，保留其祖先链（原子写入，先备份）
 *   3. 文件恢复：按 file-history-snapshot / file-history-delta 记录重建目标时刻的
 *      文件状态并还原（后来新建的文件删除）
 *
 * RPC 端点（经宿主 /api/plugins/claude-rewind/rpc/* 代理，带 JWT）：
 *   POST /locate   { sessionId, timestamp, textPrefix } → { found, uuid, ... }
 *   POST /rewind   { sessionId, targetUuid, restoreFiles } → 统计结果
 *
 * 数据来源（均已实测验证，见 docs/修复指南.md）：
 *   - 转录路径：~/.cloudcli/auth.db sessions 表 jsonl_path 列
 *   - 快照备份：~/.claude/file-history/<sessionId>/<hash>@v<N>
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// 宿主以 `node server.js` 启动（plugin-process.service.ts），argv[1] 即本文件；
// 测试/其他模块 import 纯函数时不应启动 HTTP 监听。
const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

const HOST_DB = path.join(os.homedir(), '.cloudcli', 'auth.db');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// ---------------------------------------------------------------------------
// better-sqlite3 从宿主 node_modules 加载（原生模块，插件目录没有自己的
// node_modules）。宿主安装位置变化时改 resolveHostNodeModules() 即可。
// ---------------------------------------------------------------------------
function resolveHostNodeModules() {
  return path.join('D:', 'Claude_Tools', 'claudecodeui', 'node_modules');
}

function readSessionRow(appSessionId) {
  const Database = require(path.join(resolveHostNodeModules(), 'better-sqlite3'));
  const db = new Database(HOST_DB, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare('SELECT session_id, provider_session_id, jsonl_path FROM sessions WHERE session_id = ? OR provider_session_id = ?')
      .get(appSessionId, appSessionId);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 转录解析
// ---------------------------------------------------------------------------
async function readTranscript(jsonlPath) {
  const raw = await fsp.readFile(jsonlPath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 并发写入可能产生残行，跳过 */
    }
  }
  return entries;
}

/** 构建父链索引：uuid -> parentUuid */
function buildParentMap(entries) {
  const parents = new Map();
  for (const e of entries) {
    if (e.uuid) parents.set(e.uuid, e.parentUuid || null);
  }
  return parents;
}

/**
 * 归一化文本用于宽松比对：去掉 markdown 标记符号并折叠空白。
 * 前端气泡 textContent 是 markdown 渲染后的产物（**bold**→bold、`code`→code、
 * 列表符丢失等），与转录原文直接 startsWith 会失配——这是「找不到这条消息」的
 * 根因，故两侧都归一化后再比。
 */
export function normalizeForMatch(text) {
  return String(text || '')
    .replace(/[*_`~[\]()#>|-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
export function locateTargetMessage(entries, { timestamp, textPrefix }) {
  const collect = (contentMatcher) => {
    const found = [];
    for (const e of entries) {
      if (e.type !== 'user' || !e.uuid || e.isSidechain === true) continue;
      if (e.timestamp !== timestamp) continue;
      const content = typeof e.message?.content === 'string'
        ? e.message.content
        : JSON.stringify(e.message?.content || '');
      if (contentMatcher && !contentMatcher(content)) continue;
      found.push(e);
    }
    return found;
  };

  const pickMostDescendants = (candidates) => {
    if (candidates.length === 0) return null;
    const parents = buildParentMap(entries);
    const descendantCount = (uuid) => {
      let count = 0;
      for (const e of entries) {
        let cur = e.uuid;
        const seen = new Set();
        while (cur && !seen.has(cur)) {
          if (cur === uuid) { count++; break; }
          seen.add(cur);
          cur = parents.get(cur);
        }
      }
      return count;
    };
    candidates.sort((a, b) => descendantCount(b.uuid) - descendantCount(a.uuid));
    return candidates[0];
  };

  // 第一级：时间戳 + 归一化前缀
  const prefix = normalizeForMatch(textPrefix).slice(0, 50);
  if (prefix) {
    const strict = collect((content) => normalizeForMatch(content).startsWith(prefix));
    const hit = pickMostDescendants(strict);
    if (hit) return hit;
  }

  // 第二级：仅时间戳兜底
  return pickMostDescendants(collect(null));
}

/** 目标的后代集合（含自身）——截断时要丢弃的全部条目 */
function collectDescendants(entries, targetUuid) {
  const parents = buildParentMap(entries);
  const dropped = [];
  for (const e of entries) {
    let cur = e.uuid;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (cur === targetUuid) { dropped.push(e); break; }
      seen.add(cur);
      cur = parents.get(cur);
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// 截断
// ---------------------------------------------------------------------------
async function truncateTranscript(jsonlPath, entries, targetUuid) {
  const dropSet = new Set(collectDescendants(entries, targetUuid).map((e) => entries.indexOf(e)));
  const keptLines = [];
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
 * 快照语义（2026-08-26 用真实转录逆向确认，见 docs/修复指南.md）：
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
export function buildRestorePlan(entries, targetUuid, checkpointDir, body = {}) {
  const tIdx = entries.findIndex((e) => e.uuid === targetUuid);
  if (tIdx < 0) return { restore: [], remove: [] };

  // 目标回合的结束位置：下一个非 sidechain 的 user 消息
  let turnEnd = entries.length;
  for (let i = tIdx + 1; i < entries.length; i++) {
    if (entries[i].type === 'user' && entries[i].isSidechain !== true) { turnEnd = i; break; }
  }

  const state = new Map(); // path -> backupFileName | null

  // 规则 1：回合内的第一个 snapshot
  let foundSnapshot = false;
  for (let i = tIdx; i < turnEnd; i++) {
    const e = entries[i];
    if (e.type === 'file-history-snapshot' && e.snapshot) {
      for (const [k, v] of Object.entries(e.snapshot.trackedFileBackups || {})) {
        state.set(k, v.backupFileName || null);
      }
      foundSnapshot = true;
      break;
    }
  }

  // 规则 2：回合内无 snapshot → 前置最后 snapshot + 其后 deltas
  if (!foundSnapshot) {
    let baseIdx = -1;
    for (let i = tIdx; i >= 0; i--) {
      if (entries[i].type === 'file-history-snapshot' && entries[i].snapshot) { baseIdx = i; break; }
    }
    if (baseIdx >= 0) {
      for (const [k, v] of Object.entries(entries[baseIdx].snapshot.trackedFileBackups || {})) {
        state.set(k, v.backupFileName || null);
      }
      for (let i = baseIdx + 1; i <= tIdx; i++) {
        const e = entries[i];
        if (e.type === 'file-history-delta' && e.trackingPath) {
          state.set(e.trackingPath, e.backup ? (e.backup.backupFileName || null) : null);
        }
      }
    }
    // baseIdx<0：整个转录无任何快照 → 空状态，仅靠 laterPaths 删新建文件
  }

  // 规则 4：目标之后出现的跟踪路径 = 之后新建 → 删除
  const laterPaths = new Set();
  for (let i = tIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'file-history-snapshot' && e.snapshot) {
      for (const p of Object.keys(e.snapshot.trackedFileBackups || {})) laterPaths.add(p);
    } else if (e.type === 'file-history-delta' && e.trackingPath) {
      laterPaths.add(e.trackingPath);
    }
  }

  const restore = [];
  const remove = [];
  // 相对路径（如 .claude\settings.local.json）以会话工作目录为基准解析
  const cwd = body.cwd || undefined;
  const resolvePath = (p) => (path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p));
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

async function applyRestorePlan(plan) {
  const result = { restored: [], removed: [], errors: [] };
  for (const item of plan.restore) {
    try {
      await fsp.copyFile(item.backupPath, item.filePath);
      result.restored.push(item.filePath);
    } catch (err) {
      result.errors.push(`${item.filePath}: ${err.message}`);
    }
  }
  for (const item of plan.remove) {
    try {
      await fsp.unlink(item.filePath);
      result.removed.push(item.filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') result.errors.push(`${item.filePath}: ${err.message}`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// RPC 处理
// ---------------------------------------------------------------------------
async function handleLocate(body) {
  const row = readSessionRow(body.sessionId);
  if (!row || !row.jsonl_path) return { found: false, error: 'session not found' };
  const entries = await readTranscript(row.jsonl_path);
  const target = locateTargetMessage(entries, body);
  if (!target) return { found: false };
  return {
    found: true,
    uuid: target.uuid,
    timestamp: target.timestamp,
    checkpointDir: path.join(CLAUDE_DIR, 'file-history', row.provider_session_id),
  };
}

async function handleRewind(body) {
  const row = readSessionRow(body.sessionId);
  if (!row || !row.jsonl_path) return { ok: false, error: 'session not found in DB' };

  const entries = await readTranscript(row.jsonl_path);
  const target = body.targetUuid
    ? entries.find((e) => e.uuid === body.targetUuid)
    : locateTargetMessage(entries, body);
  if (!target) return { ok: false, error: 'target message not found in transcript' };

  // 会话工作目录：优先客户端传入，否则取转录里该会话条目的 cwd 字段
  let cwd = body.cwd || null;
  if (!cwd) {
    for (const e of entries) {
      if (e.cwd && e.sessionId === row.provider_session_id) { cwd = e.cwd; break; }
    }
  }

  // 1. 截断
  const truncation = await truncateTranscript(row.jsonl_path, entries, target.uuid);

  // 2. 文件恢复（可选）
  let files = { restored: [], removed: [], errors: [] };
  if (body.restoreFiles !== false) {
    const checkpointDir = path.join(CLAUDE_DIR, 'file-history', row.provider_session_id);
    if (fs.existsSync(checkpointDir)) {
      const plan = buildRestorePlan(entries, target.uuid, checkpointDir, { cwd });
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

// ---------------------------------------------------------------------------
// HTTP 服务（宿主协议：stdout 打印 {"ready":true,"port":N}）
// ---------------------------------------------------------------------------
if (IS_MAIN) {
  const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const sendJson = (code, data) => { res.statusCode = code; res.end(JSON.stringify(data)); };

  const url = (req.url || '/').split('?')[0];
  if (url === '/health') return sendJson(200, { ok: true });
  if (req.method !== 'POST') return sendJson(405, { error: 'POST only' });

  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch { return sendJson(400, { error: 'bad json' }); }

  try {
    if (url === '/locate') return sendJson(200, await handleLocate(parsed));
    if (url === '/rewind') return sendJson(200, await handleRewind(parsed));
    return sendJson(404, { error: 'unknown route' });
  } catch (err) {
    console.error('[claude-rewind]', err);
    return sendJson(500, { error: err.message });
  }
});

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    process.stdout.write(JSON.stringify({ ready: true, port }) + '\n');
  });
}
