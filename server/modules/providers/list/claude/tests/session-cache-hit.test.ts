/**
 * 会话累计缓存命中率单测（tsx --test，随 npm test 运行）
 *
 * 语义对齐 DSH 的 cacheHitPercent：
 *   - 三个不相交计费桶：uncached + read + write 为分母，read 为分子
 *   - 防假 100：存在未命中输入（uncached + write > 0）时封顶 99.9，
 *     「100」严格保留给真·全命中
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateCacheUsage,
  computeSessionCacheHitPercent
} from '../claude-runtime.provider.js';

type UsageAccumulator = { uncached: number; read: number; write: number };
type UsageSample = { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

const newAcc = (): UsageAccumulator => ({ uncached: 0, read: 0, write: 0 });

test('空桶 → null（尚无计费输入）', () => {
  assert.equal(computeSessionCacheHitPercent(newAcc()), null);
});

test('真·全命中（无直连无写入）→ 100', () => {
  const acc = newAcc();
  accumulateCacheUsage(acc, { inputTokens: 1000, cacheReadTokens: 1000, cacheCreationTokens: 0 });
  assert.equal(computeSessionCacheHitPercent(acc), 100);
});

test('存在直连输入时永不显示 100（99.9 封顶）', () => {
  const acc = newAcc();
  // 99900 read + 100 direct = 99.9%
  accumulateCacheUsage(acc, { inputTokens: 100000, cacheReadTokens: 99900, cacheCreationTokens: 0 });
  assert.equal(computeSessionCacheHitPercent(acc), 99.9);
});

test('舍入会虚到 100 但 missed > 0 → 压回 99.9', () => {
  const acc = newAcc();
  // read=99999, uncached=1 → 99.999% → 一位小数舍入 100.0 → 必须 99.9
  accumulateCacheUsage(acc, { inputTokens: 100000, cacheReadTokens: 99999, cacheCreationTokens: 0 });
  assert.equal(computeSessionCacheHitPercent(acc), 99.9);
});

test('跨请求累积：多回合按会话累加三桶', () => {
  const acc = newAcc();
  accumulateCacheUsage(acc, { inputTokens: 60000, cacheReadTokens: 50000, cacheCreationTokens: 0 });
  accumulateCacheUsage(acc, { inputTokens: 62000, cacheReadTokens: 61000, cacheCreationTokens: 800 });
  // 桶：uncached=10200, read=111000, write=800 → 111000/122000 = 90.98% → 91.0
  assert.equal(computeSessionCacheHitPercent(acc), 91.0);
});

test('常规比例按一位小数舍入', () => {
  const acc = newAcc();
  accumulateCacheUsage(acc, { inputTokens: 1000, cacheReadTokens: 872, cacheCreationTokens: 0 });
  assert.equal(computeSessionCacheHitPercent(acc), 87.2);
});

test('直连差值为负（上游报数异常）时钳到 0，不让桶变负', () => {
  const acc = newAcc();
  accumulateCacheUsage(acc, { inputTokens: 500, cacheReadTokens: 600, cacheCreationTokens: 0 });
  assert.equal(acc.uncached, 0);
  assert.equal(acc.read, 600);
  const hit = computeSessionCacheHitPercent(acc);
  assert.ok(hit !== null && hit > 0);
});
