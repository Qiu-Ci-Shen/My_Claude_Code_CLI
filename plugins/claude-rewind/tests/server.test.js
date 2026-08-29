/**
 * claude-rewind 纯函数单测（node --test，零依赖）
 * 运行：cd ~/.claude-code-ui/plugins/claude-rewind && node --test tests/
 *
 * 覆盖：
 *   - normalizeForMatch：markdown 符号去除 / 空白折叠 / 小写
 *   - locateTargetMessage：时间戳+归一化前缀、兄弟分支选活跃、仅时间戳兜底
 *   - buildRestorePlan：回合内快照优先、前置快照+delta、新建文件删除、laterPaths、
 *     相对路径 cwd 解析、未知目标
 *
 * 快照语义见 docs/修复指南.md（2026-08-26 真实转录逆向）：
 *   snapshot(M).trackedFileBackups = M 回合开始前状态；backupFileName null = 文件不存在
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeForMatch, locateTargetMessage, buildRestorePlan } from '../server.js';

const CWD = 'D:/work';
const CHK = 'C:/checkpoints';
const p = (rel) => path.join(CWD, rel);
const bk = (name) => path.join(CHK, name);

// ---- 构造器 ----------------------------------------------------------------

function user(uuid, parentUuid, timestamp, content, extra = {}) {
  return { type: 'user', uuid, parentUuid, timestamp, message: { content }, ...extra };
}

function snapshot(uuid, parentUuid, trackedFileBackups, extra = {}) {
  return { type: 'file-history-snapshot', uuid, parentUuid, snapshot: { trackedFileBackups }, ...extra };
}

function delta(uuid, parentUuid, trackingPath, backupFileName, extra = {}) {
  const entry = { type: 'file-history-delta', uuid, parentUuid, trackingPath, ...extra };
  if (backupFileName === null) entry.backup = null;
  else entry.backup = { backupFileName };
  return entry;
}

// ---- normalizeForMatch -----------------------------------------------------

test('normalizeForMatch 去除 markdown 符号', () => {
  assert.equal(
    normalizeForMatch('**bold** `code` [link](url) #h | x -y _em_ >quote'),
    'bold code linkurl h x y em quote',
  );
});

test('normalizeForMatch 折叠空白并小写', () => {
  assert.equal(normalizeForMatch('  多  空格\t缩进\n换行   '), '多 空格 缩进 换行');
  assert.equal(normalizeForMatch('Hello WORLD'), 'hello world');
});

test('normalizeForMatch 空输入', () => {
  assert.equal(normalizeForMatch(undefined), '');
  assert.equal(normalizeForMatch(null), '');
});

// ---- locateTargetMessage ---------------------------------------------------

test('locate: 时间戳+归一化前缀命中（markdown 渲染差异）', () => {
  const entries = [
    user('u1', null, '2026-08-27T10:00:00.000Z', '**Hello** world, install `npm -g`'),
    user('u2', 'u1', '2026-08-27T10:01:00.000Z', 'ok'),
  ];
  const hit = locateTargetMessage(entries, {
    timestamp: '2026-08-27T10:00:00.000Z',
    textPrefix: 'hello world install npm g',
  });
  assert.equal(hit?.uuid, 'u1');
});

test('locate: 内容完全对不上时仅时间戳兜底仍命中', () => {
  const entries = [
    user('u1', null, '2026-08-27T10:00:00.000Z', '完全不同的内容'),
    user('u2', 'u1', '2026-08-27T10:01:00.000Z', 'ok'),
  ];
  const hit = locateTargetMessage(entries, {
    timestamp: '2026-08-27T10:00:00.000Z',
    textPrefix: '前端渲染后完全不是原文的样子xyz',
  });
  assert.equal(hit?.uuid, 'u1');
});

test('locate: isSidechain 的用户消息被跳过', () => {
  const entries = [
    user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    user('sc1', 'u1', '2026-08-27T10:00:00.000Z', 'hello world', { isSidechain: true }),
  ];
  const hit = locateTargetMessage(entries, { timestamp: '2026-08-27T10:00:00.000Z', textPrefix: 'hello' });
  assert.equal(hit?.uuid, 'u1');
});

test('locate: 兄弟分支（同时间戳同文本）选后代最多的活跃分支', () => {
  // 用户编辑过消息 → 同时间戳同文本两个候选；活跃分支 u-a 有更长后代链
  const entries = [
    user('u-a', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    user('a1', 'u-a', '2026-08-27T10:01:00.000Z', 'first reply'),
    user('a2', 'a1', '2026-08-27T10:02:00.000Z', 'second reply'),
    user('u-b', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    user('b1', 'u-b', '2026-08-27T10:01:00.000Z', 'stale reply'),
  ];
  const hit = locateTargetMessage(entries, { timestamp: '2026-08-27T10:00:00.000Z', textPrefix: 'hello' });
  assert.equal(hit?.uuid, 'u-a');
});

test('locate: 无匹配返回 null', () => {
  const entries = [user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world')];
  assert.equal(locateTargetMessage(entries, { timestamp: '2099-01-01T00:00:00.000Z', textPrefix: 'hello' }), null);
});

// ---- buildRestorePlan ------------------------------------------------------

test('plan: 回合内快照优先于前置快照', () => {
  const entries = [
    snapshot('s0', null, { 'a.txt': { backupFileName: 'a@v1' } }),          // 更早的旧状态
    user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    snapshot('s1', 'u1', { 'a.txt': { backupFileName: 'a@v2' } }),          // 目标回合内 → 应优先
    user('u2', 's1', '2026-08-27T10:01:00.000Z', 'next turn'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, [{ filePath: p('a.txt'), backupPath: bk('a@v2') }]);
});

test('plan: backupFileName null 的路径进入 remove（目标时刻文件不存在）', () => {
  const entries = [
    user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    snapshot('s1', 'u1', { 'new.txt': { backupFileName: null } }),
    user('u2', 's1', '2026-08-27T10:01:00.000Z', 'next'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.remove, [{ filePath: p('new.txt') }]);
});

test('plan: 回合内无快照 → 前置最后快照 + 顺序应用 delta', () => {
  const entries = [
    snapshot('s0', null, { 'a.txt': { backupFileName: 'a@v1' } }),
    delta('d1', 's0', 'b.txt', 'b@v1'),
    delta('d2', 'd1', 'a.txt', 'a@v2'),                                     // a 被 delta 覆盖
    user('u1', 'd2', '2026-08-27T10:00:00.000Z', 'hello world'),
    user('u2', 'u1', '2026-08-27T10:01:00.000Z', 'next'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, [
    { filePath: p('a.txt'), backupPath: bk('a@v2') },
    { filePath: p('b.txt'), backupPath: bk('b@v1') },
  ]);
  assert.deepEqual(plan.remove, []);
});

test('plan: delta backup=null → 目标时刻该文件不存在 → remove', () => {
  const entries = [
    snapshot('s0', null, { 'a.txt': { backupFileName: 'a@v1' } }),
    delta('d1', 's0', 'gone.txt', null),                                    // 回合内删除了 gone.txt
    user('u1', 'd1', '2026-08-27T10:00:00.000Z', 'hello world'),
    user('u2', 'u1', '2026-08-27T10:01:00.000Z', 'next'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, [{ filePath: p('a.txt'), backupPath: bk('a@v1') }]);
  assert.deepEqual(plan.remove, [{ filePath: p('gone.txt') }]);
});

test('plan: 目标之后出现的跟踪路径（之后新建）→ remove', () => {
  const entries = [
    snapshot('s0', null, { 'a.txt': { backupFileName: 'a@v1' } }),
    user('u1', 's0', '2026-08-27T10:00:00.000Z', 'hello world'),            // 目标
    user('u2', 'u1', '2026-08-27T10:01:00.000Z', 'next turn'),
    // 以下都在目标回合之外（u2 之后）——目标时刻不存在 → 删除
    delta('d1', 'u2', 'later-new.txt', 'later@v1'),
    snapshot('s1', 'd1', { 'a.txt': { backupFileName: 'a@v2' }, 'in-snap.txt': { backupFileName: 's@v1' } }),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  const removed = plan.remove.map((r) => r.filePath);
  assert.ok(removed.includes(p('later-new.txt')));
  assert.ok(removed.includes(p('in-snap.txt')));
  // a.txt 在 state 里有（前置快照 s0），不因 laterPaths 重复删除
  assert.ok(!removed.includes(p('a.txt')));
  assert.deepEqual(plan.restore, [{ filePath: p('a.txt'), backupPath: bk('a@v1') }]);
});

test('plan: 相对路径按 body.cwd 解析，绝对路径不动', () => {
  const entries = [
    snapshot('s0', null, {
      '.claude/settings.local.json': { backupFileName: 's@v1' },
      'C:/abs/proj/file.txt': { backupFileName: 'a@v1' },
    }),
    user('u1', 's0', '2026-08-27T10:00:00.000Z', 'hello world'),
    user('u2', 'u1', '2026-08-27T10:01:00.000Z', 'next'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, [
    { filePath: p('.claude/settings.local.json'), backupPath: bk('s@v1') },
    { filePath: 'C:/abs/proj/file.txt', backupPath: bk('a@v1') }, // 绝对路径原样保留
  ]);
});

test('plan: 未知目标 uuid → 空计划', () => {
  const entries = [user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world')];
  assert.deepEqual(buildRestorePlan(entries, 'nope', CHK, { cwd: CWD }), { restore: [], remove: [] });
});

test('plan: 整个转录无快照 → 仅删除目标后出现的路径', () => {
  const entries = [
    user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    delta('d1', 'u1', 'created-after.txt', 'c@v1'),
    user('u2', 'd1', '2026-08-27T10:01:00.000Z', 'next'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, []);
  assert.deepEqual(plan.remove, [{ filePath: p('created-after.txt') }]);
});

test('plan: 回合边界在下一个非 sidechain user 处截止', () => {
  const entries = [
    user('u1', null, '2026-08-27T10:00:00.000Z', 'hello world'),
    user('sc1', 'u1', '2026-08-27T10:00:30.000Z', 'sidechain msg', { isSidechain: true }),
    // sidechain 消息之后的 snapshot 仍算「回合内」——代码以非 sidechain 的 user 为界
    snapshot('s1', 'sc1', { 'a.txt': { backupFileName: 'a@v1' } }),
    user('u2', 's1', '2026-08-27T10:01:00.000Z', 'next turn'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, [{ filePath: p('a.txt'), backupPath: bk('a@v1') }]);
});

test('plan: 目标为最后一条（回合内无下一 user）', () => {
  const entries = [
    snapshot('s0', null, { 'a.txt': { backupFileName: 'a@v1' } }),
    user('u1', 's0', '2026-08-27T10:00:00.000Z', 'hello world'),
  ];
  const plan = buildRestorePlan(entries, 'u1', CHK, { cwd: CWD });
  assert.deepEqual(plan.restore, [{ filePath: p('a.txt'), backupPath: bk('a@v1') }]);
});
