/**
 * 后台工作生命周期追踪单测（tsx --test，随 npm test 运行）
 *
 * 背景：回合结束后服务端会挂住 CLI 进程，等后台任务回报（follow-up 回合）——
 * 但被 TaskStop 停掉的任务永远不会回报，挂起会一直持续到 30 分钟上限，
 * 客户端「Background task running」指示器残留、必须手动打断。追踪器让服务端
 * 看见「停掉」这一事实并立即放行。测试锁死 id 解析、停止配对与保守降级。
 *
 * 2026-09-12 补充：TaskStop 只是结束途径之一——外部 kill / 自然退出只会通过
 * task_notification（completed/failed/stopped）或 task_updated 终态 patch 落定，
 * 它们同样必须销账，否则被 kill 的任务令回合白白挂起到天顶（实案回归见下）。
 *
 * 2026-09-12 二审：入账侧补 task_started（is_backgrounded && !ambient）——
 * 后端子代理此前完全不入账，回合结束误判「无后台工作」释放 stdin，面板的
 * 「停止」从此永久 8s 超时（实案回归见下）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBackgroundWorkTracker } from '../background-work.js';

const assistant = (blocks: unknown[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks },
});

const toolResult = (toolUseId: string, content: string, isError = false) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  },
});

const bashStart = (toolUseId: string) => ({
  type: 'tool_use',
  id: toolUseId,
  name: 'Bash',
  input: { command: 'node server.js', run_in_background: true },
});

test('启动后台 Bash：算启动，任务 id 解析后视为存活', () => {
  const t = createBackgroundWorkTracker();
  assert.equal(t.track(assistant([bashStart('call_1')])), true);
  assert.equal(t.hasLiveWork(), true); // 结果未到，保守视为存活
  assert.equal(
    t.track(toolResult('call_1', 'Command running in background with ID: bf7q1. Output is being written to: C:\\tmp')),
    false,
  );
  assert.equal(t.hasLiveWork(), true);
});

test('TaskStop 成功后任务退役：不再视为存活', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_a. Output is being written to: x'));
  t.track(assistant([{ type: 'tool_use', id: 'call_2', name: 'TaskStop', input: { task_id: 'task_a' } }]));
  assert.equal(t.hasLiveWork(), true); // 停止结果未到，先保守
  t.track(toolResult('call_2', '{"message":"Successfully stopped task: task_a (node server.js)"}'));
  assert.equal(t.hasLiveWork(), false);
});

test('两个后台任务只停一个：仍存活', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1'), bashStart('call_2')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_a. Output is being written to: x'));
  t.track(toolResult('call_2', 'Command running in background with ID: task_b. Output is being written to: y'));
  t.track(assistant([{ type: 'tool_use', id: 'call_3', name: 'TaskStop', input: { task_id: 'task_a' } }]));
  t.track(toolResult('call_3', '{"message":"Successfully stopped task: task_a (x)"}'));
  assert.equal(t.hasLiveWork(), true);
  t.track(assistant([{ type: 'tool_use', id: 'call_4', name: 'TaskStop', input: { task_id: 'task_b' } }]));
  t.track(toolResult('call_4', '{"message":"Successfully stopped task: task_b (y)"}'));
  assert.equal(t.hasLiveWork(), false);
});

test('TaskStop 失败（结果无成功字样）：任务仍存活', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_a. Output is being written to: x'));
  t.track(assistant([{ type: 'tool_use', id: 'call_2', name: 'TaskStop', input: { task_id: 'task_a' } }]));
  t.track(toolResult('call_2', 'No task found with ID: task_a', true));
  assert.equal(t.hasLiveWork(), true);
});

test('仅 TaskStop 的回合：不算启动后台工作', () => {
  const t = createBackgroundWorkTracker();
  const started = t.track(assistant([{ type: 'tool_use', id: 'call_9', name: 'TaskStop', input: { task_id: 'x' } }]));
  assert.equal(started, false);
  assert.equal(t.hasLiveWork(), false);
});

test('task_notification 落定即销账：被外部 kill 的任务不再视为存活（2026-09-12 实案回归）', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_ext. Output is being written to: x'));
  assert.equal(t.hasLiveWork(), true);
  // 外部 kill（如 taskkill）：CLI 以 failed 通知落定，从不经过 TaskStop
  assert.equal(
    t.track({ type: 'system', subtype: 'task_notification', task_id: 'task_ext', status: 'failed' }),
    false,
  );
  assert.equal(t.hasLiveWork(), false);
});

test('task_notification completed / stopped 同样销账', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1'), bashStart('call_2')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_a. Output is being written to: x'));
  t.track(toolResult('call_2', 'Command running in background with ID: task_b. Output is being written to: y'));
  t.track({ type: 'system', subtype: 'task_notification', task_id: 'task_a', status: 'completed' });
  assert.equal(t.hasLiveWork(), true);
  t.track({ type: 'system', subtype: 'task_notification', task_id: 'task_b', status: 'stopped' });
  assert.equal(t.hasLiveWork(), false);
});

test('task_updated 终态 patch 销账；中间态不销账', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_u. Output is being written to: x'));
  t.track({ type: 'system', subtype: 'task_updated', task_id: 'task_u', patch: { status: 'running' } });
  assert.equal(t.hasLiveWork(), true);
  t.track({ type: 'system', subtype: 'task_updated', task_id: 'task_u', patch: { status: 'killed' } });
  assert.equal(t.hasLiveWork(), false);
});

test('后端子代理 task_started 入账：算启动、视为存活；落定通知即销账（2026-09-12 实案回归）', () => {
  const t = createBackgroundWorkTracker();
  const started = t.track({
    type: 'system',
    subtype: 'task_started',
    task_id: 'agent_task_1',
    tool_use_id: 'call_a',
    is_backgrounded: true,
    subagent_type: 'general-purpose',
    task_type: 'local_agent',
  });
  assert.equal(started, true);
  assert.equal(t.hasLiveWork(), true);
  t.track({ type: 'system', subtype: 'task_notification', task_id: 'agent_task_1', status: 'stopped' });
  assert.equal(t.hasLiveWork(), false);
});

test('前台子代理（is_backgrounded:false）与 ambient 任务：不入账', () => {
  const t = createBackgroundWorkTracker();
  assert.equal(
    t.track({ type: 'system', subtype: 'task_started', task_id: 'fg_1', is_backgrounded: false }),
    false,
  );
  assert.equal(
    t.track({ type: 'system', subtype: 'task_started', task_id: 'amb_1', is_backgrounded: true, ambient: true }),
    false,
  );
  assert.equal(t.hasLiveWork(), false);
});

test('仅 Agent 工具块、task_started 未到：不算启动（入账信号是事件，不是块名）', () => {
  const t = createBackgroundWorkTracker();
  const started = t.track(
    assistant([{ type: 'tool_use', id: 'call_a', name: 'Agent', input: { run_in_background: true, description: 'x' } }]),
  );
  assert.equal(started, false);
  assert.equal(t.hasLiveWork(), false);
});

test('后端子代理回合内快速完成：started 后终态落定，不多挂', () => {
  const t = createBackgroundWorkTracker();
  t.track({ type: 'system', subtype: 'task_started', task_id: 'agent_fast', is_backgrounded: true });
  t.track({ type: 'system', subtype: 'task_updated', task_id: 'agent_fast', patch: { status: 'completed' } });
  assert.equal(t.hasLiveWork(), false);
});

test('后台 Bash 双路入账（task_started + tool_result）：幂等，落定后清空', () => {
  const t = createBackgroundWorkTracker();
  t.track({
    type: 'system', subtype: 'task_started', task_id: 'bash_t1',
    tool_use_id: 'call_1', is_backgrounded: true, task_type: 'local_bash',
  });
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command running in background with ID: bash_t1. Output is being written to: x'));
  assert.equal(t.hasLiveWork(), true);
  t.track({ type: 'system', subtype: 'task_notification', task_id: 'bash_t1', status: 'completed' });
  assert.equal(t.hasLiveWork(), false);
});

test('未知任务 id 的通知：不抛错、不影响存量、不算启动', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command running in background with ID: task_a. Output is being written to: x'));
  const started = t.track({ type: 'system', subtype: 'task_notification', task_id: 'other_task', status: 'completed' });
  assert.equal(started, false);
  assert.equal(t.hasLiveWork(), true);
});

test('启动结果未带 id 且非报错：保守视为存活', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Started in the background (no id in this result)'));
  assert.equal(t.hasLiveWork(), true);
});

test('启动即失败（is_error）：不视为存活', () => {
  const t = createBackgroundWorkTracker();
  t.track(assistant([bashStart('call_1')]));
  t.track(toolResult('call_1', 'Command failed to start', true));
  assert.equal(t.hasLiveWork(), false);
});

test('Monitor 类工具计入未跟踪工作（无任务 id 可停）', () => {
  const t = createBackgroundWorkTracker();
  assert.equal(t.track(assistant([{ type: 'tool_use', id: 'c', name: 'Monitor', input: {} }])), true);
  assert.equal(t.hasLiveWork(), true);
});

test('无关与畸形消息：不抛错、不算启动、不算存活', () => {
  const t = createBackgroundWorkTracker();
  assert.equal(t.track(null), false);
  assert.equal(t.track({}), false);
  assert.equal(t.track({ message: { content: 'plain text' } }), false);
  assert.equal(t.track(assistant([null as unknown as Record<string, unknown>, { type: 'nope' }])), false);
  assert.equal(t.track(toolResult('call_unrelated', 'normal output')), false);
  assert.equal(t.hasLiveWork(), false);
});
