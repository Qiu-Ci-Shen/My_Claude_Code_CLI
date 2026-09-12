import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { NormalizedMessage, SubagentEventPayload } from '../../../stores/useSessionStore';

import {
  appendAgentMessage as reduceAppendMessage,
  applyHistoryConversation,
  applySubagentEvent as reduceApplyEvent,
  createSessionState,
  markHistoryFailed,
  markHistoryLoading,
  mergeHistory,
  selectAgent as reduceSelectAgent,
  setPanelOpen as reduceSetPanelOpen,
} from './agentsReducer';
import type { AgentConversationDto, AgentSummaryDto, AgentsSessionState } from './types';

/**
 * Agents 面板状态仓库（按会话键控，模式对齐 useSessionStore）。
 *
 * 高频的子代理流式消息先入待发队列，按 ~120ms 节流合并后一次性入账，
 * 避免每个 token 都触发一轮 ChatInterface 重渲染（同主聊天流式节流思路）。
 */
const MESSAGE_FLUSH_INTERVAL_MS = 120;

export type AgentsStoreApi = {
  getSessionState(sessionId: string | null): AgentsSessionState;
  applySubagentEvent(sessionId: string, payload: SubagentEventPayload | null | undefined): void;
  appendAgentMessage(sessionId: string, toolUseId: string, message: NormalizedMessage): void;
  setPanelOpen(sessionId: string, open: boolean): void;
  selectAgent(sessionId: string, taskId: string | null): void;
  /** 拉取历史 agent 列表（每次会话打开后调用一次；已载入则跳过） */
  loadSession(sessionId: string): Promise<void>;
  /** 拉取某 agent 的完整对话（点开详情时调用） */
  loadConversation(sessionId: string, taskId: string): Promise<void>;
};

const EMPTY_STATE = createSessionState();

export function useAgentsStore(): AgentsStoreApi {
  const [, setVersion] = useState(0);
  const statesRef = useRef(new Map<string, AgentsSessionState>());
  const pendingMessagesRef = useRef(new Map<string, Array<{ toolUseId: string; message: NormalizedMessage }>>());
  const flushTimerRef = useRef<number | null>(null);

  const bump = useCallback(() => {
    setVersion((version) => version + 1);
  }, []);

  const getState = useCallback((sessionId: string | null): AgentsSessionState => {
    if (!sessionId) {
      return EMPTY_STATE;
    }
    let state = statesRef.current.get(sessionId);
    if (!state) {
      state = createSessionState();
      statesRef.current.set(sessionId, state);
    }
    return state;
  }, []);

  const mutate = useCallback(
    (sessionId: string, updater: (state: AgentsSessionState) => AgentsSessionState) => {
      const previous = getState(sessionId);
      const next = updater(previous);
      if (next !== previous) {
        statesRef.current.set(sessionId, next);
        bump();
      }
    },
    [getState, bump],
  );

  const flushPendingMessages = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingMessagesRef.current;
    if (pending.size === 0) {
      return;
    }
    pendingMessagesRef.current = new Map();
    for (const [sessionId, entries] of pending) {
      let state = getState(sessionId);
      for (const entry of entries) {
        state = reduceAppendMessage(state, entry.toolUseId, entry.message);
      }
      statesRef.current.set(sessionId, state);
    }
    bump();
  }, [getState, bump]);

  const appendAgentMessage = useCallback(
    (sessionId: string, toolUseId: string, message: NormalizedMessage) => {
      const list = pendingMessagesRef.current.get(sessionId) ?? [];
      list.push({ toolUseId, message });
      pendingMessagesRef.current.set(sessionId, list);
      if (flushTimerRef.current === null) {
        flushTimerRef.current = window.setTimeout(flushPendingMessages, MESSAGE_FLUSH_INTERVAL_MS);
      }
    },
    [flushPendingMessages],
  );

  const applySubagentEvent = useCallback(
    (sessionId: string, payload: SubagentEventPayload | null | undefined) => {
      mutate(sessionId, (state) => reduceApplyEvent(state, payload));
    },
    [mutate],
  );

  const setPanelOpen = useCallback(
    (sessionId: string, open: boolean) => {
      mutate(sessionId, (state) => reduceSetPanelOpen(state, open));
    },
    [mutate],
  );

  const selectAgent = useCallback(
    (sessionId: string, taskId: string | null) => {
      mutate(sessionId, (state) => reduceSelectAgent(state, taskId));
    },
    [mutate],
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      const current = getState(sessionId);
      if (current.historyLoaded || current.historyLoading) {
        return;
      }
      mutate(sessionId, markHistoryLoading);
      try {
        const response = await authenticatedFetch(
          `/api/providers/sessions/${encodeURIComponent(sessionId)}/subagents`,
        );
        const body = await response.json();
        const summaries: AgentSummaryDto[] = Array.isArray(body?.data?.subagents)
          ? (body.data.subagents as AgentSummaryDto[])
          : [];
        mutate(sessionId, (state) => mergeHistory(state, summaries));
      } catch (error) {
        console.error('[agents] Failed to load subagent list:', error);
        mutate(sessionId, markHistoryFailed);
      }
    },
    [getState, mutate],
  );

  const loadConversation = useCallback(
    async (sessionId: string, taskId: string) => {
      const agent = getState(sessionId).agents[taskId];
      // 实时消息已完整跟随时不再回读历史；已载入过也不重复拉
      if (!agent || agent.historyLoaded || agent.messages.length > 0) {
        return;
      }
      try {
        const response = await authenticatedFetch(
          `/api/providers/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(taskId)}/messages`,
        );
        if (!response.ok) {
          mutate(sessionId, (state) => {
            const current = state.agents[taskId];
            if (!current) {
              return state;
            }
            return { ...state, agents: { ...state.agents, [taskId]: { ...current, historyLoaded: true } } };
          });
          return;
        }
        const body = await response.json();
        const data = body?.data as AgentConversationDto | undefined;
        const messages: NormalizedMessage[] = Array.isArray(data?.messages) ? data.messages : [];
        mutate(sessionId, (state) => applyHistoryConversation(state, taskId, messages));
      } catch (error) {
        console.error('[agents] Failed to load subagent conversation:', error);
      }
    },
    [getState, mutate],
  );

  return useMemo(
    () => ({
      getSessionState: getState,
      applySubagentEvent,
      appendAgentMessage,
      setPanelOpen,
      selectAgent,
      loadSession,
      loadConversation,
    }),
    [getState, applySubagentEvent, appendAgentMessage, setPanelOpen, selectAgent, loadSession, loadConversation],
  );
}
