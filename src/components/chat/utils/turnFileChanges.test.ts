/**
 * collectTurnFileChanges 单测（tsx --test，随 npm run test:client 运行）
 *
 * 语义（2026-09-06 复刻官方「N 个文件已更改」折叠条）：
 *   - 回合 = 一条用户消息到下一条用户消息之前；Map 以回合最后一条消息对象为键
 *   - 聚合 Edit/Write/MultiEdit/NotebookEdit 的 tool_use（含子代理容器内的同类子工具）
 *   - 失败的工具调用（isError）不计入
 *   - +X = new_string 行数、-Y = old_string 行数（Write 按新增全文计）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ChatMessage } from '../types/types';

import { collectTurnFileChanges } from './turnFileChanges';

function user(content: string): ChatMessage {
  return { type: 'user', content, timestamp: '2026-09-06T10:00:00.000Z' } as ChatMessage;
}

function toolUse(toolName: string, toolInput: unknown, opts: { isError?: boolean; childTools?: Array<{ toolName: string; toolInput: unknown; toolResult?: { isError?: boolean } | null }> } = {}): ChatMessage {
  return {
    type: 'assistant',
    content: '',
    timestamp: '2026-09-06T10:00:01.000Z',
    isToolUse: true,
    toolName,
    toolInput,
    toolResult: { content: 'ok', isError: opts.isError ?? false },
    isSubagentContainer: opts.childTools ? true : undefined,
    subagentState: opts.childTools
      ? { childTools: opts.childTools as never, currentToolIndex: 0, isComplete: true }
      : undefined,
  } as unknown as ChatMessage;
}

function text(content: string): ChatMessage {
  return { type: 'assistant', content, timestamp: '2026-09-06T10:00:02.000Z' } as ChatMessage;
}

test('单回合 Edit+Write 聚合：键为回合最后一条消息，行数求和', () => {
  const u = user('改一下');
  const t1 = toolUse('Edit', { file_path: 'D:/p/a.ts', old_string: 'const a = 1;', new_string: 'const a = 1;\nconst b = 2;\nconst c = 3;' });
  const t2 = toolUse('Write', { file_path: 'D:/p/b.md', content: '# t\n\nx' });
  const tail = text('完成');
  const messages = [u, t1, t2, tail];

  const map = collectTurnFileChanges(messages);
  assert.equal(map.size, 1);
  const changes = map.get(tail)!;
  assert.ok(changes);
  assert.equal(changes.files.length, 2);
  assert.equal(changes.totalAdded, 2 + 3);
  assert.equal(changes.totalRemoved, 0);
  const editFile = changes.files.find((f) => f.filePath === 'D:/p/a.ts')!;
  assert.deepEqual(editFile.lastDiff, { old_string: 'const a = 1;', new_string: 'const a = 1;\nconst b = 2;\nconst c = 3;' });
});

test('MultiEdit 各 edit 求和，lastDiff 取最后一次', () => {
  const u = user('multi');
  const tail = toolUse('MultiEdit', {
    file_path: 'D:/p/c.ts',
    edits: [
      { old_string: 'one', new_string: 'one\ntwo' },
      { old_string: 'three\nfour', new_string: 'three' },
    ],
  });
  const map = collectTurnFileChanges([u, tail]);
  const changes = map.get(tail)!;
  assert.equal(changes.totalAdded, 1 + 0);
  assert.equal(changes.totalRemoved, 0 + 1);
  assert.deepEqual(changes.files[0].lastDiff, { old_string: 'three\nfour', new_string: 'three' });
});

test('失败的工具调用（isError）不计入', () => {
  const u = user('x');
  const failed = toolUse('Edit', { file_path: 'D:/p/a.ts', old_string: 'a', new_string: 'b' }, { isError: true });
  const tail = text('失败重试');
  const map = collectTurnFileChanges([u, failed, tail]);
  assert.equal(map.size, 0);
});

test('跨回合独立聚合，各自以回合最后一条消息为键', () => {
  const u1 = user('第一回合');
  const tail1 = toolUse('Edit', { file_path: 'D:/p/a.ts', old_string: 'a', new_string: 'a\nb' });
  const u2 = user('第二回合');
  const tail2 = toolUse('Write', { file_path: 'D:/p/d.txt', content: 'hello\nworld' });
  const map = collectTurnFileChanges([u1, tail1, u2, tail2]);
  assert.equal(map.size, 2);
  assert.equal(map.get(tail1)!.totalAdded, 1);
  assert.equal(map.get(tail2)!.totalAdded, 2);
  assert.ok(!map.has(u2 as never));
});

test('子代理容器内的 Edit 一并计入', () => {
  const u = user('委托子代理');
  const tail = toolUse('Task', { prompt: 'x' }, {
    childTools: [
      { toolName: 'Edit', toolInput: { file_path: 'D:/p/sub.ts', old_string: 'x', new_string: 'x\ny\nz' } },
    ],
  });
  const map = collectTurnFileChanges([u, tail]);
  const changes = map.get(tail)!;
  assert.equal(changes.files.length, 1);
  assert.equal(changes.totalAdded, 2);
});

test('toolInput 为 JSON 字符串（转录形态）时正常解析', () => {
  const u = user('json input');
  const tail = toolUse('Edit', JSON.stringify({ file_path: 'D:/p/e.ts', old_string: 'a', new_string: 'a\nb' }));
  const map = collectTurnFileChanges([u, tail]);
  assert.equal(map.get(tail)!.totalAdded, 1);
});

test('无文件更改的回合不产生条目；同回合同文件多工具合并', () => {
  const u1 = user('只聊天');
  const tail1 = text('好');
  const u2 = user('再改');
  const e1 = toolUse('Edit', { file_path: 'D:/p/f.ts', old_string: 'a', new_string: 'a\nb' });
  const e2 = toolUse('Edit', { file_path: 'D:/p/f.ts', old_string: 'b', new_string: 'b\nc\nd' });
  const map = collectTurnFileChanges([u1, tail1, u2, e1, e2]);
  assert.equal(map.size, 1);
  const changes = map.get(e2)!;
  assert.equal(changes.files.length, 1);
  assert.equal(changes.totalAdded, 1 + 2);
  assert.equal(changes.totalRemoved, 0);
});
