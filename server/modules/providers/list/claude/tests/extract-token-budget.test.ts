/**
 * extractTokenBudget 单测（tsx --test，随 npm test 运行）
 *
 * 语义（2026-08-26 实测逆向，见知识库）：
 *   - 上下文占用 = 下一请求会重发的部分 = input_tokens + cache_read + cache_creation
 *   - output_tokens 是本回合生成量，不是上下文——计入会让进度条每回合膨胀
 *   - modelUsage 是跨轮【累计值】，绝不能当当前占用——这就是「莫名爆满」的根因
 *   - SDK 占位 assistant 消息带零值 usage 快照——忽略，防「清零」
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTokenBudget } from '../claude-runtime.provider.js';

function expectTotalContext(result) {
  assert.ok(result.total > 0, 'context window 应解析出正值');
}

test('非法输入 → null', () => {
  assert.equal(extractTokenBudget(null), null);
  assert.equal(extractTokenBudget(undefined), null);
  assert.equal(extractTokenBudget('hello'), null);
  assert.equal(extractTokenBudget(42), null);
  assert.equal(extractTokenBudget({}), null);
});

test('message.usage（SDK snake_case）计算上下文占用', () => {
  const result = extractTokenBudget({
    message: {
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 25,
        output_tokens: 40,
      },
    },
  });
  assert.ok(result, '应返回预算对象');
  expectTotalContext(result);
  // used = 直接输入 + 缓存（输出不计入）
  assert.equal(result.used, 175);
  assert.equal(result.inputTokens, 175);
  assert.equal(result.outputTokens, 40);
  assert.equal(result.cacheReadTokens, 25);
  assert.equal(result.cacheCreationTokens, 50);
  assert.equal(result.cacheTokens, 75);
  assert.deepEqual(result.breakdown, { input: 175, output: 40 });
  assert.equal(result.contextPercent, Math.round((175 / result.total) * 100));
});

test('顶层 usage（无 message 包裹）同样生效', () => {
  const result = extractTokenBudget({
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0, output_tokens: 99 },
  });
  assert.ok(result);
  assert.equal(result.used, 15);
  assert.equal(result.outputTokens, 99);
});

test('camelCase 别名（SDK 部分版本用驼峰）', () => {
  const result = extractTokenBudget({
    usage: {
      inputTokens: 20,
      cacheCreationTokens: 3,
      cacheReadTokens: 7,
      outputTokens: 100,
    },
  });
  assert.ok(result);
  assert.equal(result.used, 30);
  assert.equal(result.cacheTokens, 10);
});

test('message.usage 优先于顶层 usage', () => {
  const result = extractTokenBudget({
    message: { usage: { input_tokens: 5 } },
    usage: { input_tokens: 999, cache_creation_input_tokens: 999, cache_read_input_tokens: 999 },
  });
  assert.equal(result.used, 5);
});

test('零值 usage 快照 → null（占位消息，防进度条清零）', () => {
  assert.equal(extractTokenBudget({ message: { usage: { input_tokens: 0 } } }), null);
  assert.equal(extractTokenBudget({ usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }), null);
  // 只有 output 有值也算零占用 → null
  assert.equal(extractTokenBudget({ usage: { output_tokens: 123 } }), null);
});

test('仅 modelUsage（累计值）→ null（防「莫名爆满」回归）', () => {
  // modelUsage 总数随会话增长，永远不能当作当前占用
  const result = extractTokenBudget({
    modelUsage: {
      'claude-sonnet-4-6': { input_tokens: 999999, output_tokens: 888888 },
    },
  });
  assert.equal(result, null);
});

test('百分比夹取：极端占用不越界', () => {
  const result = extractTokenBudget({
    message: { usage: { input_tokens: 1e15, cache_read_input_tokens: 1e15, cache_creation_input_tokens: 0 } },
  });
  assert.ok(result);
  assert.ok(result.contextPercent >= 0 && result.contextPercent <= 100);
});

test('百分比与 total 一致（当前环境 contextWindow 下）', () => {
  const result = extractTokenBudget({
    message: { usage: { input_tokens: 80000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 } },
  });
  assert.ok(result);
  assert.equal(result.contextPercent, Math.round((100000 / result.total) * 100));
  assert.equal(result.used, 100000);
});
