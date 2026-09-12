import type { NormalizedMessage } from '../../../stores/useSessionStore';

/**
 * Agents 面板（子 agent 对话面板墙）前端状态模型。
 *
 * 数据来源（双源分工）：
 *  - 实时：`subagent_event` 生命周期事件 + 带 `parentToolUseId` 的子代理消息
 *  - 历史：GET /api/providers/sessions/:id/subagents（列表 + 对话）
 */

export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** 渲染用状态：历史遗留的 running 且本会话不在运行 → 中断 */
export type AgentDisplayStatus = AgentStatus | 'interrupted';

export type AgentUsage = { totalTokens: number; toolUses: number; durationMs: number };

/** 单个子代理的运行时条目 */
export type AgentRuntime = {
  taskId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  /** Agent 工具的 name 参数（teammate 可寻址名），历史列表暂不提供 */
  name: string | null;
  prompt: string | null;
  status: AgentStatus;
  /** 本条目由实时事件建立/更新过（历史列表载入的为 false） */
  liveSeen: boolean;
  isBackgrounded: boolean;
  spawnDepth: number | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: AgentUsage | null;
  lastToolName: string | null;
  /** CLI 任务系统的实时活动文案（task_progress.description），仅展示用 */
  activity: string | null;
  summary: string | null;
  /** 子代理对话消息（实时 + 历史合并，长度上限 AGENT_MESSAGE_LIMIT） */
  messages: NormalizedMessage[];
  isHistoryConversation: boolean;
  historyLoaded: boolean;
};

/** 单个会话的 Agents 面板状态 */
export type AgentsSessionState = {
  agents: Record<string, AgentRuntime>;
  /** taskId 顺序（spawn 顺序，历史刷新时保持稳定） */
  order: string[];
  /** task_started 未到时先到的子消息，按 toolUseId 暂存，agent 建立后归位 */
  orphans: Record<string, NormalizedMessage[]>;
  panelOpen: boolean;
  /** 本「运行轮」用户手动关过面板：不自动重开，直到全部 agent 落定 */
  userClosed: boolean;
  selectedTaskId: string | null;
  historyLoaded: boolean;
  historyLoading: boolean;
};

/** 与服务端 SubagentSummary 对齐（server/shared/types.ts） */
export type AgentSummaryDto = {
  taskId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  name: string | null;
  prompt: string | null;
  status: string;
  isBackgrounded: boolean;
  spawnDepth: number | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: AgentUsage | null;
  hasConversation: boolean;
};

/** 与服务端 SubagentConversation 对齐 */
export type AgentConversationDto = {
  taskId: string;
  agentType: string | null;
  description: string | null;
  messages: NormalizedMessage[];
};

export const AGENT_MESSAGE_LIMIT = 400;

/**
 * 渲染状态：历史载入的 running 条目，若本条目没见过实时事件、且所属会话
 * 也不在运行，则显示「已中断」（进程死掉后被遗留的条目）。
 */
export function resolveDisplayStatus(agent: AgentRuntime, sessionActive: boolean): AgentDisplayStatus {
  if (agent.status === 'running' && !agent.liveSeen && !sessionActive) {
    return 'interrupted';
  }
  return agent.status;
}
