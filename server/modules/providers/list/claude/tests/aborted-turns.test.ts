/**
 * aborted-turns 单测（tsx --test，随 npm test 运行）
 *
 * 语义（2026-09-05 修复「打断后仍回读复活完整输出」，见知识库）：
 *   - 打断后 CLI 仍会优雅收尾，把已生成的近乎完整回合回灌进 JSONL 转录
 *   - fetchHistory 服务历史时必须剪掉「打断时刻之后、下一个真实用户回合之前」
 *     的回灌条目——这正是收尾回灌的窗口
 *   - 打断之前已落盘的条目（用户打断前就看到的内容）一律保留
 *   - 无时间戳的条目无法归属，fail-safe 保留
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearAbortedTurns,
  filterPostAbortTranscriptEntries,
  getAbortedTurnTimestamps,
  markAbortedTurn,
} from '../aborted-turns.js';

function iso(ts: number) {
  return new Date(ts).toISOString();
}

function userEntry(ts: number, text = '帮我写个脚本') {
  return {
    type: 'user',
    timestamp: iso(ts),
    uuid: `u-${ts}`,
    message: { role: 'user', content: text },
  };
}

function assistantEntry(ts: number, text = '好的，我来写：') {
  return {
    type: 'assistant',
    timestamp: iso(ts),
    uuid: `a-${ts}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function toolResultEntry(ts: number) {
  return {
    type: 'user',
    timestamp: iso(ts),
    uuid: `tr-${ts}`,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  };
}

function systemEntry(ts: number) {
  return { type: 'system', timestamp: iso(ts), uuid: `s-${ts}`, content: 'wind-down' };
}

function texts(entries: Array<Record<string, unknown>>) {
  return entries.map((entry) => (entry.uuid as string) ?? JSON.stringify(entry));
}

test('无打断标记 → 原样返回', () => {
  const entries = [userEntry(1000), assistantEntry(1100)];
  assert.equal(filterPostAbortTranscriptEntries(entries, []), entries);
});

test('打断后 CLI 回灌的收尾条目被剪除，打断前条目与用户消息保留', () => {
  const entries = [
    userEntry(1000),        // 被打断回合的用户消息
    assistantEntry(1100),   // 打断前已生成（用户已看到）
    assistantEntry(1200),   // 收尾回灌的“近乎完整”输出
    systemEntry(1250),      // 收尾系统条目
  ];
  const served = filterPostAbortTranscriptEntries(entries, [1150]);
  assert.deepEqual(texts(served), ['u-1000', 'a-1100']);
});

test('下一个真实用户回合开始后停止剪除，新回合内容不受影响', () => {
  const entries = [
    userEntry(1000),
    assistantEntry(1100),
    assistantEntry(1200),   // 回灌
    userEntry(2000),        // 打断后的新提问
    assistantEntry(2100),   // 新回合的正常回答
  ];
  const served = filterPostAbortTranscriptEntries(entries, [1150]);
  assert.deepEqual(texts(served), ['u-1000', 'a-1100', 'u-2000', 'a-2100']);
});

test('图片-only 用户消息也算回合开始，其后内容不被误剪', () => {
  const imageOnlyUser = {
    type: 'user',
    timestamp: iso(2000),
    uuid: 'u-img',
    message: { role: 'user', content: [{ type: 'image', source: { type: 'base64' } }] },
  };
  const entries = [
    userEntry(1000),
    assistantEntry(1100),
    assistantEntry(1200),   // 回灌
    imageOnlyUser,          // 打断后发出的纯图片提问
    assistantEntry(2100),   // 新回合的正常回答
  ];
  const served = filterPostAbortTranscriptEntries(entries, [1150]);
  assert.deepEqual(texts(served), ['u-1000', 'a-1100', 'u-img', 'a-2100']);
});

test('窗口内的 tool_result user 条目剪除（不视为回合开始）', () => {
  const entries = [
    userEntry(1000),
    assistantEntry(1100),
    toolResultEntry(1180),  // 回灌窗口内的工具结果
    assistantEntry(1200),   // 回灌
  ];
  const served = filterPostAbortTranscriptEntries(entries, [1150]);
  assert.deepEqual(texts(served), ['u-1000', 'a-1100']);
});

test('无时间戳条目 fail-safe 保留', () => {
  const undated = { type: 'assistant', uuid: 'a-undated', message: { role: 'assistant', content: [{ type: 'text', text: '?' }] } };
  const entries = [userEntry(1000), undated, assistantEntry(1200)];
  const served = filterPostAbortTranscriptEntries(entries, [1150]);
  assert.deepEqual(texts(served), ['u-1000', 'a-undated']);
});

test('同一会话多次打断：各回灌窗口分别剪除，正常内容保留', () => {
  const entries = [
    userEntry(1000),
    assistantEntry(1100),
    assistantEntry(1200),   // 第一次打断的回灌
    userEntry(2000),
    assistantEntry(2100),
    assistantEntry(2200),   // 第二次打断的回灌
  ];
  const served = filterPostAbortTranscriptEntries(entries, [1150, 2150]);
  assert.deepEqual(texts(served), ['u-1000', 'a-1100', 'u-2000', 'a-2100']);
});

test('标记注册表：mark → get → clear 往返', () => {
  clearAbortedTurns('sess-1');
  assert.deepEqual(getAbortedTurnTimestamps('sess-1'), []);
  markAbortedTurn('sess-1', 1000);
  markAbortedTurn('sess-1', 2000);
  assert.deepEqual(getAbortedTurnTimestamps('sess-1'), [1000, 2000]);
  clearAbortedTurns('sess-1');
  assert.deepEqual(getAbortedTurnTimestamps('sess-1'), []);
  // 空会话 id 不应写入
  markAbortedTurn('', 3000);
  assert.deepEqual(getAbortedTurnTimestamps(''), []);
});
