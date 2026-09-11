/**
 * extractCompactTokenBudget 单测（tsx --test，随 npm test 运行）
 *
 * 语义：
 *   - 压缩边界消息（system/compact_boundary）自带 compact_metadata.post_tokens，
 *     即压缩后对话内容的 token 数——边界到达时立即下发，让 UI 的 Context 条
 *     在压缩完成瞬间收缩，而不是等下一回合第一条 assistant 消息带 usage 刷新
 *   - post_tokens 缺失（旧版 CLI，或仅含 compact_result 的状态消息）→ null，
 *     回退到「下一回合刷新」的旧行为
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCompactTokenBudget } from '../claude-runtime.provider.js';

test('非法输入 → null', () => {
  assert.equal(extractCompactTokenBudget(null), null);
  assert.equal(extractCompactTokenBudget(undefined), null);
  assert.equal(extractCompactTokenBudget('hello'), null);
  assert.equal(extractCompactTokenBudget(42), null);
  assert.equal(extractCompactTokenBudget({}), null);
});

test('snake_case 边界消息（SDK 流格式）解析 post_tokens', () => {
  const result = extractCompactTokenBudget({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 633918, post_tokens: 12720, duration_ms: 35428 },
  });
  assert.ok(result, '应返回预算对象');
  assert.ok(result.total > 0, 'context window 应解析出正值');
  assert.equal(result.used, 12720);
  assert.equal(result.inputTokens, 12720);
  assert.equal(result.contextPercent, Math.min(100, Math.max(0, Math.round((12720 / result.total) * 100))));
});

test('camelCase 别名（transcript 落盘格式）同样生效', () => {
  const result = extractCompactTokenBudget({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'manual', preTokens: 633918, postTokens: 5000 },
  });
  assert.ok(result);
  assert.equal(result.used, 5000);
});

test('无 post_tokens（旧版 CLI / 仅状态消息）→ null，回退旧行为', () => {
  assert.equal(extractCompactTokenBudget({ subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 100 } }), null);
  assert.equal(extractCompactTokenBudget({ subtype: 'compact_boundary', compact_metadata: { post_tokens: 0 } }), null);
  assert.equal(extractCompactTokenBudget({ subtype: 'status', compact_result: 'success' }), null);
});

test('百分比夹取：极端占用不越界', () => {
  const result = extractCompactTokenBudget({
    compact_metadata: { post_tokens: 1e15 },
  });
  assert.ok(result);
  assert.ok(result.contextPercent >= 0 && result.contextPercent <= 100);
});
