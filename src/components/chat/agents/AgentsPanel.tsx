import { useEffect, useState } from 'react';

import AgentWindow from './AgentWindow';
import { resolveDisplayStatus, type AgentRuntime, type AgentsSessionState } from './types';

type AgentsPanelProps = {
  isMobile: boolean;
  state: AgentsSessionState;
  /** 所属会话是否正在运行（用于把历史遗留 running 显示为中断） */
  sessionActive: boolean;
  onClose: () => void;
  onSelect: (taskId: string | null) => void;
  onStop: (agent: AgentRuntime) => void;
  onRelay: (agent: AgentRuntime, text: string) => void;
  onRequestConversation: (taskId: string) => void;
};

/**
 * Agents 面板（右侧竖列 / 手机端抽屉）：一面实时窗口墙。
 * 每个子代理一个小窗（带实时对话预览）——所有 agent 同时可见；
 * 点开任意小窗就地升为主窗（完整对话 + 停止 + 转达），其余小窗保留。
 */
export default function AgentsPanel({
  isMobile,
  state,
  sessionActive,
  onClose,
  onSelect,
  onStop,
  onRelay,
  onRequestConversation,
}: AgentsPanelProps) {
  const agents = state.order
    .map((taskId) => state.agents[taskId])
    .filter((agent): agent is AgentRuntime => Boolean(agent));
  const runningCount = agents.filter((agent) => agent.status === 'running').length;

  // 心跳：有运行中的 agent 时每秒刷新耗时显示
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (runningCount === 0) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningCount]);

  const body = (
    <div className="flex-1 space-y-1.5 overflow-y-auto px-2 py-2">
      {agents.map((agent) => (
        <AgentWindow
          key={agent.taskId}
          agent={agent}
          displayStatus={resolveDisplayStatus(agent, sessionActive)}
          now={now}
          expanded={state.selectedTaskId === agent.taskId}
          onExpand={onSelect}
          onCollapse={() => onSelect(null)}
          onStop={onStop}
          onRelay={onRelay}
          onRequestConversation={onRequestConversation}
        />
      ))}
      {agents.length === 0 ? (
        <div className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
          {state.historyLoading ? '正在读取子代理记录…' : (
            <>
              暂无子代理。
              <br />
              当 lead 派发子任务（Agent / Task）时会实时出现在这里。
            </>
          )}
        </div>
      ) : null}
    </div>
  );

  const header = (
    <div className="flex min-w-0 items-center gap-2 border-b border-border/70 px-3 py-2">
      <span className="truncate text-[13px] font-semibold text-foreground">Agents</span>
      {agents.length > 0 ? (
        <span className="flex-shrink-0 rounded bg-purple-500/15 px-1.5 text-[10.5px] leading-4 text-purple-600 dark:text-purple-300">
          {runningCount > 0 ? `${runningCount} 运行中` : `${agents.length} 个`}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        className="ml-auto flex-shrink-0 rounded px-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        aria-label="关闭面板"
      >
        ✕
      </button>
    </div>
  );

  if (isMobile) {
    return (
      <div
        className="fixed inset-0 z-[95] flex justify-end bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      >
        <aside
          className="flex h-full w-[min(21rem,92vw)] min-w-0 flex-col border-l border-border bg-background shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          {header}
          {body}
        </aside>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[21rem] min-w-0 flex-shrink-0 flex-col border-l border-border bg-background">
      {header}
      {body}
    </aside>
  );
}
