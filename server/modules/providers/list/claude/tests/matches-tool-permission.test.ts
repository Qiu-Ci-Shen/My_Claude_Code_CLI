/**
 * matchesToolPermission 单测（tsx --test，随 npm test 运行）
 *
 * 语义（2026-09-05 修复前缀边界，见知识库）：
 *   - Bash(command:*) 规则匹配「command 本身」或「command + 空白开头」的命令
 *   - 裸前缀匹配会让形近命令漏网：Bash(ls:*) 命中 lsblk、Bash(npm:*) 命中
 *     npm x——allow 规则放行不该放的，deny 规则拦不住该拦的
 *   - 该函数同时服务于 allowedTools 与 disallowedTools，语义必须对称
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchesToolPermission } from '../claude-runtime.provider.js';

test('工具名精确匹配', () => {
  assert.equal(matchesToolPermission('Read', 'Read', {}), true);
  assert.equal(matchesToolPermission('Read', 'Write', {}), false);
});

test('Bash(ls:*) 命中裸命令与带参命令', () => {
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: 'ls' }), true);
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: 'ls -la' }), true);
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: 'ls  -la /tmp' }), true);
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: '  ls -la  ' }), true);
});

test('Bash(ls:*) 不命中形近命令（裸前缀漏洞回归）', () => {
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: 'lsblk' }), false);
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: 'lsof -i' }), false);
  assert.equal(matchesToolPermission('Bash(npm:*)', 'Bash', { command: 'npmx install' }), false);
});

test('多词规则同样要求空白边界', () => {
  assert.equal(matchesToolPermission('Bash(npm run:*)', 'Bash', { command: 'npm run build' }), true);
  assert.equal(matchesToolPermission('Bash(npm run:*)', 'Bash', { command: 'npm runX' }), false);
  assert.equal(matchesToolPermission('Bash(npm run:*)', 'Bash', { command: 'npm-run-all build' }), false);
});

test('命令即规则本身（无 :* 的裸条目）不受影响', () => {
  assert.equal(matchesToolPermission('Bash', 'Bash', { command: 'anything' }), true);
});

test('输入既可以是字符串也可以是 {command} 对象', () => {
  assert.equal(matchesToolPermission('Bash(git:*)', 'Bash', 'git status'), true);
  assert.equal(matchesToolPermission('Bash(git:*)', 'Bash', { command: 'git status' }), true);
  assert.equal(matchesToolPermission('Bash(git:*)', 'Bash', { command: 'gitk' }), false);
});

test('非 Bash 工具不吃 Bash 规则，空命令直接拒绝', () => {
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Read', {}), false);
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', { command: '   ' }), false);
  assert.equal(matchesToolPermission('Bash(ls:*)', 'Bash', ''), false);
});
