/**
 * 上下文读数抖动抑制单测（tsx --test，随 npm test 运行）
 *
 * 语义（2026-09-11 实测反转录）：
 *   - 中转/代理偶发上报「先掉近一半、下一条又弹回」的瞬时低值，
 *     每次都发生在回合首条请求（真实样本：322622 → 177225 → 322622）
 *   - 真实收缩只来自压缩/回退且会连续出现低值——单条低值先压住，
 *     下一条仍低才认定真实收缩；弹回则丢弃低值
 *   - 压缩边界（compact_boundary）直接重置基线，低值立即生效
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptContextUsageSample,
  resetContextUsageStabilizer,
} from '../claude-runtime.provider.js';

test('首条样本直接接受', () => {
  assert.equal(acceptContextUsageSample('stab-first', 56664), true);
});

test('正常爬升全部接受', () => {
  assert.equal(acceptContextUsageSample('stab-climb', 100000), true);
  assert.equal(acceptContextUsageSample('stab-climb', 105000), true);
  assert.equal(acceptContextUsageSample('stab-climb', 110000), true);
});

test('无会话键（拿不到 provider id）不抑制', () => {
  assert.equal(acceptContextUsageSample(null, 100000), true);
  assert.equal(acceptContextUsageSample(null, 1000), true);
});

test('真实蹦极形态：低值压住，弹回后接受新值', () => {
  assert.equal(acceptContextUsageSample('stab-bungee', 322622), true);
  // 回合首条请求上报的低值 → 压住
  assert.equal(acceptContextUsageSample('stab-bungee', 177225), false);
  // 下一条弹回 → 接受弹回值（低值不呈现）
  assert.equal(acceptContextUsageSample('stab-bungee', 323424), true);
});

test('连续两条低值 → 认定真实收缩并接受', () => {
  assert.equal(acceptContextUsageSample('stab-real-drop', 400000), true);
  assert.equal(acceptContextUsageSample('stab-real-drop', 20000), false);
  // 仍低 → 确认收缩
  assert.equal(acceptContextUsageSample('stab-real-drop', 21000), true);
  // 之后从低基线正常爬升
  assert.equal(acceptContextUsageSample('stab-real-drop', 25000), true);
});

test('压缩后重置基线，低值立即生效', () => {
  assert.equal(acceptContextUsageSample('stab-compact', 46676), true);
  resetContextUsageStabilizer('stab-compact');
  assert.equal(acceptContextUsageSample('stab-compact', 1660), true);
});

test('未弹回也不误伤：低值后的更低值同样确认真实收缩', () => {
  assert.equal(acceptContextUsageSample('stab-lower', 300000), true);
  assert.equal(acceptContextUsageSample('stab-lower', 150000), false);
  assert.equal(acceptContextUsageSample('stab-lower', 140000), true);
});
