import type { NormalizedMessage, SubagentEventPayload } from '../../../stores/useSessionStore';

import {
  AGENT_MESSAGE_LIMIT,
  type AgentRuntime,
  type AgentStatus,
  type AgentSummaryDto,
  type AgentUsage,
  type AgentsSessionState,
} from './types';

/**
 * Agents 面板纯函数状态机（可单测）。
 * 所有函数返回新对象引用；无变化时返回原引用以便跳过重渲染。
 */

export function createSessionState(): AgentsSessionState {
  return {
    agents: {},
    order: [],
    orphans: {},
    panelOpen: false,
    userClosed: false,
    selectedTaskId: null,
    historyLoaded: false,
    historyLoading: false,
  };
}

export function createAgentRuntime(taskId: string): AgentRuntime {
  return {
    taskId,
    toolUseId: null,
    agentType: null,
    description: null,
    name: null,
    prompt: null,
    status: 'running',
    liveSeen: false,
    isBackgrounded: false,
    spawnDepth: null,
    startedAt: null,
    endedAt: null,
    usage: null,
    lastToolName: null,
    activity: null,
    summary: null,
    messages: [],
    isHistoryConversation: false,
    historyLoaded: false,
  };
}

/** 服务端/SDK 状态字串 → 本地面板状态；running/pending/paused 等保持现状 */
function mapTerminalStatus(status: string | null | undefined): AgentStatus | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return null;
  }
}

function normalizeUsage(usage: SubagentEventPayload['usage'] | null | undefined): AgentUsage | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return {
    totalTokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0,
    toolUses: Number.isFinite(usage.toolUses) ? usage.toolUses : 0,
    durationMs: Number.isFinite(usage.durationMs) ? usage.durationMs : 0,
  };
}

/** 按 id 去重追加，超过上限从头截断 */
function appendMessages(existing: NormalizedMessage[], incoming: NormalizedMessage[]): NormalizedMessage[] {
  const seen = new Set(existing.map((message) => message.id));
  const merged = [...existing];
  for (const message of incoming) {
    if (message.id && seen.has(message.id)) {
      continue;
    }
    if (message.id) {
      seen.add(message.id);
    }
    merged.push(message);
  }
  if (merged.length > AGENT_MESSAGE_LIMIT) {
    merged.splice(0, merged.length - AGENT_MESSAGE_LIMIT);
  }
  return merged;
}

/** 补丁式更新（不存在则创建）；有 orphan 暂存且此刻拿到 toolUseId 时归位 */
function patchAgent(state: AgentsSessionState, taskId: string, patch: Partial<AgentRuntime>): AgentsSessionState {
  const existing = state.agents[taskId];
  const nextAgent: AgentRuntime = { ...(existing ?? createAgentRuntime(taskId)), ...patch };

  let orphans = state.orphans;
  const orphanKey = nextAgent.toolUseId;
  if (!existing && orphanKey && orphans[orphanKey]) {
    const { [orphanKey]: drained, ...rest } = orphans;
    nextAgent.messages = appendMessages(nextAgent.messages, drained);
    orphans = rest;
  }

  const agents = { ...state.agents, [taskId]: nextAgent };
  const order = existing ? state.order : [...state.order, taskId];
  return { ...state, agents, order, orphans };
}

/** 没有运行中的 agent 时，解除「用户手动关闭过」的封印 */
function settleUserClosed(state: AgentsSessionState): AgentsSessionState {
  if (!state.userClosed) {
    return state;
  }
  const anyRunning = state.order.some((taskId) => state.agents[taskId]?.status === 'running');
  return anyRunning ? state : { ...state, userClosed: false };
}

export function applySubagentEvent(
  state: AgentsSessionState,
  payload: SubagentEventPayload | null | undefined,
): AgentsSessionState {
  if (!payload || payload.ambient) {
    return state;
  }
  const taskId = typeof payload.taskId === 'string' && payload.taskId ? payload.taskId : null;
  if (!taskId) {
    return state;
  }
  const nowIso = new Date().toISOString();

  switch (payload.event) {
    case 'started': {
      let next = patchAgent(state, taskId, {
        liveSeen: true,
        ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
        agentType: payload.subagentType ?? null,
        description: payload.description ?? null,
        prompt: payload.prompt ?? null,
        isBackgrounded: Boolean(payload.isBackgrounded),
        spawnDepth: typeof payload.spawnDepth === 'number' ? payload.spawnDepth : null,
        startedAt: state.agents[taskId]?.startedAt ?? nowIso,
      });
      // 自动开面板：用户本赛季手动关过就不打扰
      if (!next.userClosed && !next.panelOpen) {
        next = { ...next, panelOpen: true };
      }
      return next;
    }
    case 'progress': {
      return patchAgent(state, taskId, {
        liveSeen: true,
        // task_progress.description 是活动文案（如「Running Read typecheck
        // output」），只进 activity——description 是身份（lead 派活时的描述），
        // 被活动短语覆盖会让卡片墙看上去像单个 agent 的流水（2026-09-12）
        ...(payload.description ? { activity: payload.description } : {}),
        ...(payload.lastToolName ? { lastToolName: payload.lastToolName } : {}),
        ...(payload.summary ? { summary: payload.summary } : {}),
        ...(normalizeUsage(payload.usage) ? { usage: normalizeUsage(payload.usage) } : {}),
      });
    }
    case 'updated': {
      const mapped = mapTerminalStatus(payload.status);
      const next = patchAgent(state, taskId, {
        liveSeen: true,
        ...(mapped ? { status: mapped } : {}),
        ...(typeof payload.endTime === 'number' ? { endedAt: new Date(payload.endTime).toISOString() } : {}),
        ...(typeof payload.isBackgrounded === 'boolean' ? { isBackgrounded: payload.isBackgrounded } : {}),
      });
      return settleUserClosed(next);
    }
    case 'finished': {
      const mapped = mapTerminalStatus(payload.status) ?? 'completed';
      const next = patchAgent(state, taskId, {
        liveSeen: true,
        ...(payload.toolUseId ? { toolUseId: payload.toolUseId } : {}),
        status: mapped,
        ...(normalizeUsage(payload.usage) ? { usage: normalizeUsage(payload.usage) } : {}),
        ...(payload.summary ? { summary: payload.summary } : {}),
        endedAt: state.agents[taskId]?.endedAt ?? nowIso,
      });
      return settleUserClosed(next);
    }
    default:
      return state;
  }
}

/** 实时子代理消息（带 parentToolUseId）入面板；无归属时按 toolUseId 暂存 */
export function appendAgentMessage(
  state: AgentsSessionState,
  toolUseId: string,
  message: NormalizedMessage,
): AgentsSessionState {
  let ownerId: string | null = null;
  for (const taskId of state.order) {
    if (state.agents[taskId]?.toolUseId === toolUseId) {
      ownerId = taskId;
      break;
    }
  }

  if (!ownerId) {
    const pending = state.orphans[toolUseId] ?? [];
    if (message.id && pending.some((existing) => existing.id === message.id)) {
      return state;
    }
    return {
      ...state,
      orphans: { ...state.orphans, [toolUseId]: appendMessages(pending, [message]) },
    };
  }

  const agent = state.agents[ownerId];
  if (!agent) {
    return state;
  }
  if (message.id && agent.messages.some((existing) => existing.id === message.id)) {
    return state;
  }
  return {
    ...state,
    agents: {
      ...state.agents,
      [ownerId]: { ...agent, messages: appendMessages(agent.messages, [message]) },
    },
  };
}

/** 历史列表合并：实时数据优先，只补空字段；状态仅在本地未见实时时采纳 */
export function mergeHistory(state: AgentsSessionState, summaries: AgentSummaryDto[]): AgentsSessionState {
  const agents = { ...state.agents };
  const order = [...state.order];

  for (const summary of summaries) {
    const taskId = summary.taskId;
    const existing = agents[taskId];

    if (existing) {
      agents[taskId] = {
        ...existing,
        toolUseId: existing.toolUseId ?? summary.toolUseId,
        agentType: existing.agentType ?? summary.agentType,
        description: existing.description ?? summary.description,
        name: existing.name ?? summary.name,
        prompt: existing.prompt ?? summary.prompt,
        spawnDepth: existing.spawnDepth ?? summary.spawnDepth,
        isBackgrounded: existing.isBackgrounded || summary.isBackgrounded,
        startedAt: existing.startedAt ?? summary.startedAt,
        endedAt: existing.endedAt ?? summary.endedAt,
        usage: existing.usage ?? summary.usage,
        status: existing.liveSeen ? existing.status : (mapTerminalStatus(summary.status) ?? existing.status),
      };
    } else {
      agents[taskId] = {
        ...createAgentRuntime(taskId),
        toolUseId: summary.toolUseId,
        agentType: summary.agentType,
        description: summary.description,
        name: summary.name,
        prompt: summary.prompt,
        status: mapTerminalStatus(summary.status) ?? 'running',
        isBackgrounded: summary.isBackgrounded,
        spawnDepth: summary.spawnDepth,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        usage: summary.usage,
      };
      order.push(taskId);
    }
  }

  return settleUserClosed({ ...state, agents, order, historyLoaded: true, historyLoading: false });
}

/** 历史对话到达：空则直接铺底；已有实时消息则历史打底、实时按 id 去重续接 */
export function applyHistoryConversation(
  state: AgentsSessionState,
  taskId: string,
  messages: NormalizedMessage[],
): AgentsSessionState {
  const agent = state.agents[taskId];
  if (!agent) {
    return state;
  }
  const hadLiveMessages = agent.messages.length > 0;
  const merged = hadLiveMessages
    ? appendMessages(messages.slice(-AGENT_MESSAGE_LIMIT), agent.messages)
    : messages.slice(-AGENT_MESSAGE_LIMIT);
  return {
    ...state,
    agents: {
      ...state.agents,
      [taskId]: {
        ...agent,
        messages: merged,
        isHistoryConversation: !hadLiveMessages,
        historyLoaded: true,
      },
    },
  };
}

export function setPanelOpen(state: AgentsSessionState, open: boolean): AgentsSessionState {
  if (state.panelOpen === open && (open || state.userClosed)) {
    return state;
  }
  return { ...state, panelOpen: open, userClosed: open ? false : true };
}

export function selectAgent(state: AgentsSessionState, taskId: string | null): AgentsSessionState {
  if (state.selectedTaskId === taskId) {
    return state;
  }
  return { ...state, selectedTaskId: taskId };
}

export function markHistoryLoading(state: AgentsSessionState): AgentsSessionState {
  if (state.historyLoading || state.historyLoaded) {
    return state;
  }
  return { ...state, historyLoading: true };
}

export function markHistoryFailed(state: AgentsSessionState): AgentsSessionState {
  if (!state.historyLoading) {
    return state;
  }
  return { ...state, historyLoading: false };
}
