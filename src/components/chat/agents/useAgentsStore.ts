import { useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { NormalizedMessage, SubagentEventPayload } from '../../../stores/useSessionStore';

import {
  appendAgentMessage as reduceAppendMessage,
  applyHistoryConversation,
  applySubagentEvent as reduceApplyEvent,
  createSessionState,
  dismissAgent as reduceDismissAgent,
  hidePill as reduceHidePill,
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

const VIEW_STORAGE_PREFIX = 'qiu-agents-view:';

/** localStorage 中的会话视图偏好（删除过的条目 / 胶囊是否收起） */
function readPersistedView(sessionId: string): { pillHidden: boolean; dismissed: Record<string, true> } {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_PREFIX + sessionId);
    if (!raw) {
      return { pillHidden: false, dismissed: {} };
    }
    const parsed = JSON.parse(raw) as { pillHidden?: unknown; dismissed?: unknown };
    const dismissed: Record<string, true> = {};
    if (Array.isArray(parsed.dismissed)) {
      for (const id of parsed.dismissed) {
        if (typeof id === 'string' && id) {
          dismissed[id] = true;
        }
      }
    }
    return { pillHidden: parsed.pillHidden === true, dismissed };
  } catch {
    return { pillHidden: false, dismissed: {} };
  }
}

function persistView(sessionId: string, state: AgentsSessionState): void {
  try {
    window.localStorage.setItem(
      VIEW_STORAGE_PREFIX + sessionId,
      JSON.stringify({ pillHidden: state.pillHidden, dismissed: Object.keys(state.dismissed) }),
    );
  } catch {
    // localStorage 不可用（隐私模式/配额）：视图偏好降级为内存态
  }
}

export type AgentsStoreApi = {
  getSessionState(sessionId: string | null): AgentsSessionState;
  applySubagentEvent(sessionId: string, payload: SubagentEventPayload | null | undefined): void;
  appendAgentMessage(sessionId: string, toolUseId: string, message: NormalizedMessage): void;
  setPanelOpen(sessionId: string, open: boolean): void;
  selectAgent(sessionId: string, taskId: string | null): void;
  /** 删除一个已停止的条目（运行中拒绝） */
  dismissAgent(sessionId: string, taskId: string, sessionActive: boolean): void;
  /** 空闲时关闭浮动胶囊（运行中拒绝） */
  hidePill(sessionId: string, sessionActive: boolean): void;
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
        if (next.pillHidden !== previous.pillHidden || next.dismissed !== previous.dismissed) {
          persistView(sessionId, next);
        }
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

  const dismissAgent = useCallback(
    (sessionId: string, taskId: string, sessionActive: boolean) => {
      mutate(sessionId, (state) => reduceDismissAgent(state, taskId, sessionActive));
    },
    [mutate],
  );

  const hidePill = useCallback(
    (sessionId: string, sessionActive: boolean) => {
      mutate(sessionId, (state) => reduceHidePill(state, sessionActive));
    },
    [mutate],
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      const current = getState(sessionId);
      if (current.historyLoaded || current.historyLoading) {
        return;
      }
      // 视图偏好（删除过的条目 / 胶囊隐藏）先于历史合并恢复，历史中对不上号的条目会被过滤
      const persisted = readPersistedView(sessionId);
      if (persisted.pillHidden || Object.keys(persisted.dismissed).length > 0) {
        mutate(sessionId, (state) => ({
          ...state,
          pillHidden: state.pillHidden || persisted.pillHidden,
          dismissed: { ...persisted.dismissed, ...state.dismissed },
        }));
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
      dismissAgent,
      hidePill,
      loadSession,
      loadConversation,
    }),
    [getState, applySubagentEvent, appendAgentMessage, setPanelOpen, selectAgent, dismissAgent, hidePill, loadSession, loadConversation],
  );
}
