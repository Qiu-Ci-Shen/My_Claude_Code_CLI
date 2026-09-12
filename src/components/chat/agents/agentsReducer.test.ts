/**
 * agentsReducer 单测（tsx --test，随 npm run test:client 运行）
 *
 * 语义（Agents 面板 · 双源分工）：
 *   - 实时：subagent_event 生命周期 + parentToolUseId 子消息（先节流合并再入账）
 *   - 历史：列表合并「实时优先，只补空字段」；状态仅在本地未见实时时采纳
 *   - 面板自动打开 / 用户手动关闭封印 / 全部落定后解除
 *   - 子消息按 toolUseId 归组；task_started 未到时先进 orphan 暂存
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NormalizedMessage, SubagentEventPayload } from '../../../stores/useSessionStore';

import {
  appendAgentMessage,
  applyHistoryConversation,
  applySubagentEvent,
  createSessionState,
  mergeHistory,
  selectAgent,
  setPanelOpen,
} from './agentsReducer';
import { resolveDisplayStatus, type AgentSummaryDto } from './types';

function event(payload: Partial<SubagentEventPayload> & Pick<SubagentEventPayload, 'event' | 'taskId'>): SubagentEventPayload {
  return { ...payload };
}

function message(id: string, content = ''): NormalizedMessage {
  return {
    id,
    sessionId: 's1',
    timestamp: '2026-09-12T00:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    content,
  };
}

function summary(overrides: Partial<AgentSummaryDto> & Pick<AgentSummaryDto, 'taskId'>): AgentSummaryDto {
  return {
    toolUseId: null,
    agentType: null,
    description: null,
    name: null,
    prompt: null,
    status: 'running',
    isBackgrounded: false,
    spawnDepth: null,
    startedAt: null,
    endedAt: null,
    usage: null,
    hasConversation: true,
    ...overrides,
  };
}

test('started：建条目、自动开面板、标记 liveSeen', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1', subagentType: 'Explore', description: '侦察', prompt: 'p', isBackgrounded: true }));
  const agent = state.agents.t1!;
  assert.equal(agent.status, 'running');
  assert.equal(agent.liveSeen, true);
  assert.equal(agent.agentType, 'Explore');
  assert.equal(agent.toolUseId, 'call_1');
  assert.equal(agent.isBackgrounded, true);
  assert.ok(agent.startedAt);
  assert.equal(state.panelOpen, true);
});

test('started：ambient 与空 taskId 忽略', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', ambient: true }));
  state = applySubagentEvent(state, event({ event: 'started', taskId: null }));
  state = applySubagentEvent(state, null);
  assert.equal(state.order.length, 0);
  assert.equal(state.panelOpen, false);
});

test('progress / updated / finished：字段合并与终态', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1' }));
  state = applySubagentEvent(state, event({ event: 'progress', taskId: 't1', lastToolName: 'Bash', usage: { totalTokens: 120, toolUses: 2, durationMs: 3000 } }));
  assert.equal(state.agents.t1!.lastToolName, 'Bash');
  assert.equal(state.agents.t1!.usage!.totalTokens, 120);

  state = applySubagentEvent(state, event({ event: 'updated', taskId: 't1', status: 'completed', endTime: 1789200000000 }));
  assert.equal(state.agents.t1!.status, 'completed');
  assert.equal(state.agents.t1!.endedAt, new Date(1789200000000).toISOString());

  // 二次 finished 覆盖（同一 task 恢复后再次通知的场景）
  state = applySubagentEvent(state, event({ event: 'finished', taskId: 't1', status: 'stopped', usage: { totalTokens: 200, toolUses: 3, durationMs: 5000 } }));
  assert.equal(state.agents.t1!.status, 'stopped');
  assert.equal(state.agents.t1!.usage!.totalTokens, 200);
});

test('progress 的活动文案只进 activity，不覆盖身份 description（截图事故回归）', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1', description: '服务端改动独立审核' }));
  // CLI 的 task_progress.description 是活动短语（如「Running Read typecheck output」）
  state = applySubagentEvent(state, event({ event: 'progress', taskId: 't1', description: 'Running Read typecheck output' }));
  assert.equal(state.agents.t1!.description, '服务端改动独立审核');
  assert.equal(state.agents.t1!.activity, 'Running Read typecheck output');

  // 后续 progress 只刷新活动文案，身份不动
  state = applySubagentEvent(state, event({ event: 'progress', taskId: 't1', description: 'Reading bmy0ewod0' }));
  assert.equal(state.agents.t1!.activity, 'Reading bmy0ewod0');
  assert.equal(state.agents.t1!.description, '服务端改动独立审核');
});

test('面板开关：用户关闭后不自动重开，全部落定后封印解除', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1' }));
  assert.equal(state.panelOpen, true);

  state = setPanelOpen(state, false);
  assert.equal(state.panelOpen, false);
  assert.equal(state.userClosed, true);

  // 新一轮 agent 启动：不打扰
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't2' }));
  assert.equal(state.panelOpen, false);

  // 全部落定 → 封印解除 → 下一个 started 重新自动开
  state = applySubagentEvent(state, event({ event: 'finished', taskId: 't1', status: 'completed' }));
  state = applySubagentEvent(state, event({ event: 'finished', taskId: 't2', status: 'completed' }));
  assert.equal(state.userClosed, false);
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't3' }));
  assert.equal(state.panelOpen, true);
});

test('子消息归组：按 toolUseId 找到归属；未到时 orphan 暂存，started 后归位', () => {
  let state = createSessionState();
  // 先到消息（started 还在路上）
  state = appendAgentMessage(state, 'call_1', message('m1', 'hello'));
  state = appendAgentMessage(state, 'call_1', message('m1', 'hello')); // 去重
  assert.equal(state.orphans.call_1?.length, 1);

  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1' }));
  assert.equal(state.agents.t1!.messages.length, 1);
  assert.equal(state.orphans.call_1, undefined);

  state = appendAgentMessage(state, 'call_1', message('m2', 'world'));
  assert.equal(state.agents.t1!.messages.length, 2);
});

test('子消息上限：超过 400 条从头截断', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1' }));
  for (let index = 0; index < 450; index += 1) {
    state = appendAgentMessage(state, 'call_1', message(`m${index}`));
  }
  assert.equal(state.agents.t1!.messages.length, 400);
  assert.equal(state.agents.t1!.messages[0]!.id, 'm50');
});

test('历史合并：实时优先补空字段；本地已见实时的状态不被历史覆盖', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1', description: '来自实时' }));
  state = applySubagentEvent(state, event({ event: 'finished', taskId: 't1', status: 'completed' }));

  state = mergeHistory(state, [
    summary({ taskId: 't1', description: '来自历史', status: 'failed', endedAt: '2026-09-12T02:00:00.000Z', usage: { totalTokens: 9, toolUses: 1, durationMs: 500 } }),
    summary({ taskId: 't2', description: '纯历史', status: 'completed', startedAt: '2026-09-12T01:00:00.000Z' }),
  ]);

  // t1：描述保留实时值；状态保留实时 completed（历史说 failed 不采纳）
  assert.equal(state.agents.t1!.description, '来自实时');
  assert.equal(state.agents.t1!.status, 'completed');
  // 实时已有结束时间，不被历史的 endedAt 覆盖
  assert.ok(state.agents.t1!.endedAt);
  assert.notEqual(state.agents.t1!.endedAt, '2026-09-12T02:00:00.000Z');
  // t2：纯历史条目
  assert.equal(state.agents.t2!.description, '纯历史');
  assert.equal(state.agents.t2!.status, 'completed');
  assert.equal(state.agents.t2!.liveSeen, false);
  assert.equal(state.historyLoaded, true);
});

test('显示状态：历史 running 且会话未运行且无实时 → 中断', () => {
  let state = createSessionState();
  state = mergeHistory(state, [summary({ taskId: 't1', status: 'running' })]);
  const agent = state.agents.t1!;
  assert.equal(resolveDisplayStatus(agent, false), 'interrupted');
  assert.equal(resolveDisplayStatus(agent, true), 'running');

  let live = createSessionState();
  live = applySubagentEvent(live, event({ event: 'started', taskId: 't1' }));
  // 见过实时的 running 条目即便会话空闲也按运行中显示（后台任务尾随期）
  assert.equal(resolveDisplayStatus(live.agents.t1!, false), 'running');
});

test('历史对话：空则铺底；已有实时消息则历史打底 + 实时去重续接', () => {
  let state = createSessionState();
  state = applySubagentEvent(state, event({ event: 'started', taskId: 't1', toolUseId: 'call_1' }));
  // 有实时消息的场景
  state = appendAgentMessage(state, 'call_1', message('m2', 'live'));
  state = applyHistoryConversation(state, 't1', [message('m1', 'hist'), message('m2', 'live')]);
  assert.deepEqual(state.agents.t1!.messages.map((entry) => entry.id), ['m1', 'm2']);
  assert.equal(state.agents.t1!.historyLoaded, true);
  assert.equal(state.agents.t1!.isHistoryConversation, false);
});

test('选中态：selectAgent 设置与清除', () => {
  let state = createSessionState();
  state = selectAgent(state, 't1');
  assert.equal(state.selectedTaskId, 't1');
  state = selectAgent(state, null);
  assert.equal(state.selectedTaskId, null);
});
