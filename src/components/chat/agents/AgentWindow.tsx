import { useEffect, useMemo, useRef, useState } from 'react';

import { CollapsibleSection } from '../tools/components/CollapsibleSection';
import { Markdown } from '../view/subcomponents/Markdown';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import type { ChatMessage } from '../types/types';

import type { AgentDisplayStatus, AgentRuntime } from './types';
import { compactToolArg, elapsedSince, formatDurationMs, formatTokens } from './format';

const STATUS_DOT: Record<AgentDisplayStatus, string> = {
  running: 'bg-purple-500 dark:bg-purple-400 animate-pulse',
  completed: 'bg-green-500 dark:bg-green-400',
  failed: 'bg-red-500 dark:bg-red-400',
  stopped: 'bg-gray-400 dark:bg-gray-500',
  interrupted: 'bg-gray-300 dark:bg-gray-600',
};

const STATUS_LABEL: Record<AgentDisplayStatus, string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
  interrupted: '已中断',
};

/** 展开态单条消息的渲染（工具折叠、思考灰字、正文走 Markdown） */
function AgentMessageRow({ message }: { message: ChatMessage }) {
  if (message.isToolUse) {
    const arg = compactToolArg(message.toolName || '', message.toolInput);
    const result = message.toolResult;
    const images = Array.isArray(result?.images) ? result.images : [];
    return (
      <CollapsibleSection title={arg ? `${message.toolName} · ${arg}` : String(message.toolName || '工具')} className="text-[12px]">
        <div className="mt-1 space-y-1">
          {typeof message.toolInput === 'string' && message.toolInput.trim() && message.toolInput.trim() !== '{}' ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">
              {message.toolInput}
            </pre>
          ) : null}
          {result ? (
            <pre
              className={`max-h-60 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-[11px] ${
                result.isError
                  ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                  : 'bg-muted/30 text-muted-foreground'
              }`}
            >
              {String(result.content ?? '') || '(空结果)'}
            </pre>
          ) : null}
          {images.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {images.map((image, index) =>
                image.data ? (
                  <img
                    key={index}
                    src={image.data}
                    alt={image.name || '工具结果图片'}
                    className="max-h-40 rounded border border-border"
                  />
                ) : (
                  <span key={index} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {image.name || image.path || '附件'}
                  </span>
                ),
              )}
            </div>
          ) : null}
        </div>
      </CollapsibleSection>
    );
  }

  if (message.isThinking) {
    return (
      <CollapsibleSection title="思考" className="text-[12px]">
        <div className="mt-1 whitespace-pre-wrap break-words text-[11.5px] italic text-muted-foreground">
          {String(message.content ?? '')}
        </div>
      </CollapsibleSection>
    );
  }

  if (message.type === 'user') {
    return (
      <div className="rounded-lg bg-muted/60 px-2.5 py-1.5 text-[12.5px] text-foreground">
        <Markdown breaks>{message.content as string}</Markdown>
      </div>
    );
  }

  if (!message.content) {
    return null;
  }
  return (
    <div className="text-[12.5px] leading-relaxed text-foreground">
      <Markdown>{message.content as string}</Markdown>
    </div>
  );
}

type MiniRow = { key: string; kind: 'user' | 'assistant' | 'tool'; text: string; isError?: boolean; pending?: boolean };

/** 小窗预览：只抽取最近几行最有信息量的内容（工具一行、正文两三行，思考省去） */
function buildMiniRows(messages: ChatMessage[]): MiniRow[] {
  const rows: MiniRow[] = [];
  for (let index = messages.length - 1; index >= 0 && rows.length < 8; index -= 1) {
    const message = messages[index];
    const key = String((message as { id?: string }).id || `row_${index}`);
    if (message.isToolUse) {
      const arg = compactToolArg(message.toolName || '', message.toolInput);
      rows.push({
        key,
        kind: 'tool',
        text: `${message.toolName || '工具'}${arg ? ` · ${arg}` : ''}`,
        isError: Boolean(message.toolResult?.isError),
        pending: !message.toolResult,
      });
    } else if (message.isThinking) {
      continue;
    } else {
      const text = String(message.content ?? '').trim();
      if (!text) {
        continue;
      }
      rows.push({ key, kind: message.type === 'user' ? 'user' : 'assistant', text });
    }
  }
  return rows.reverse();
}

/** 小窗里的实时对话尾巴（始终贴底，像一块正在滚动的监视器） */
function MiniPreview({ agent }: { agent: AgentRuntime }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatMessages = useMemo(() => normalizedToChatMessages(agent.messages), [agent.messages]);
  const rows = useMemo(() => buildMiniRows(chatMessages), [chatMessages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rows.length]);

  const fallback = agent.activity || agent.summary || (agent.status === 'running' ? '思考中…' : null);

  return (
    <div ref={scrollRef} className="h-[74px] space-y-1 overflow-y-auto px-2 py-1.5">
      {rows.length === 0 ? (
        <div className="text-[11px] leading-relaxed text-muted-foreground">{fallback || '点击展开对话'}</div>
      ) : (
        rows.map((row) =>
          row.kind === 'tool' ? (
            <div key={row.key} className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
              <span
                className={
                  row.isError ? 'text-red-500' : row.pending ? 'text-purple-500' : 'text-green-600 dark:text-green-400'
                }
              >
                {row.isError ? '✗' : row.pending ? '…' : '✓'}
              </span>
              <span className="truncate">{row.text}</span>
            </div>
          ) : (
            <div
              key={row.key}
              className={
                row.kind === 'user'
                  ? 'line-clamp-2 whitespace-pre-wrap break-words rounded bg-muted/60 px-1.5 py-1 text-[11px] text-foreground'
                  : 'line-clamp-3 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-foreground'
              }
            >
              {row.text}
            </div>
          ),
        )
      )}
    </div>
  );
}

type AgentWindowProps = {
  agent: AgentRuntime;
  displayStatus: AgentDisplayStatus;
  now: number;
  expanded: boolean;
  onExpand: (taskId: string) => void;
  onCollapse: () => void;
  onStop: (agent: AgentRuntime) => void;
  onRelay: (agent: AgentRuntime, text: string) => void;
  onRequestConversation: (taskId: string) => void;
};

/**
 * 单个子代理的窗口（面板墙的一块）。
 * 小窗：状态头 + 实时对话预览（点击升为主窗）。
 * 主窗：就地展开的完整对话 + 停止 + 转达，其余小窗保留不动。
 */
export default function AgentWindow({
  agent,
  displayStatus,
  now,
  expanded,
  onExpand,
  onCollapse,
  onStop,
  onRelay,
  onRequestConversation,
}: AgentWindowProps) {
  const usage = agent.usage;
  const tokens = formatTokens(usage?.totalTokens);
  const duration = formatDurationMs(
    displayStatus === 'running'
      ? elapsedSince(agent.startedAt, null, now)
      : (usage?.durationMs || elapsedSince(agent.startedAt, agent.endedAt, now)),
  );

  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    setStopping(false);
  }, [agent.taskId, agent.status]);

  const handleStop = (event?: { stopPropagation: () => void }) => {
    event?.stopPropagation();
    if (stopping) {
      return;
    }
    setStopping(true);
    onStop(agent);
  };

  if (!expanded) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => onExpand(agent.taskId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onExpand(agent.taskId);
          }
        }}
        data-agent-window={agent.taskId}
        className="cursor-pointer overflow-hidden rounded-lg border border-border/70 bg-card transition-colors hover:border-purple-400/60 dark:hover:border-purple-500/50"
      >
        <div className="flex min-w-0 items-center gap-1.5 px-2 pt-1.5">
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${STATUS_DOT[displayStatus]}`} />
          <span className="truncate text-[12px] font-medium text-foreground">{agent.description || agent.taskId}</span>
          {agent.agentType ? (
            <span className="ml-auto flex-shrink-0 rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground">
              {agent.agentType}
            </span>
          ) : null}
          {displayStatus === 'running' ? (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopping}
              className="flex-shrink-0 rounded border border-red-400/60 px-1 text-[10px] leading-4 text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:border-red-500/50 dark:text-red-400"
              aria-label="停止该子代理"
            >
              {stopping ? '…' : '■'}
            </button>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 px-2 text-[10.5px] text-muted-foreground">
          <span className="truncate">
            {STATUS_LABEL[displayStatus]}
            {agent.name ? ` · ${agent.name}` : ''}
          </span>
          <span className="ml-auto flex flex-shrink-0 items-center gap-1.5">
            {tokens ? <span>{tokens}</span> : null}
            {duration ? <span>{duration}</span> : null}
          </span>
        </div>
        <MiniPreview agent={agent} />
      </div>
    );
  }

  return (
    <ExpandedWindow
      agent={agent}
      displayStatus={displayStatus}
      tokens={tokens}
      duration={duration}
      stopping={stopping}
      onStop={handleStop}
      onCollapse={onCollapse}
      onRelay={onRelay}
      onRequestConversation={onRequestConversation}
    />
  );
}

type ExpandedWindowProps = {
  agent: AgentRuntime;
  displayStatus: AgentDisplayStatus;
  tokens: string;
  duration: string;
  stopping: boolean;
  onStop: () => void;
  onCollapse: () => void;
  onRelay: (agent: AgentRuntime, text: string) => void;
  onRequestConversation: (taskId: string) => void;
};

/** 主窗：完整对话 + 任务提示词 + 转达（就地展开，不顶掉其余小窗） */
function ExpandedWindow({
  agent,
  displayStatus,
  tokens,
  duration,
  stopping,
  onStop,
  onCollapse,
  onRelay,
  onRequestConversation,
}: ExpandedWindowProps) {
  const [relayText, setRelayText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // 空对话且未载入过 → 拉历史
  useEffect(() => {
    if (!agent.historyLoaded && agent.messages.length === 0) {
      onRequestConversation(agent.taskId);
    }
  }, [agent.taskId, agent.historyLoaded, agent.messages.length, onRequestConversation]);

  // 跟随滚动：贴底时才自动滚
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const chatMessages = useMemo(() => normalizedToChatMessages(agent.messages), [agent.messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessages.length, agent.taskId]);

  const handleRelay = () => {
    const text = relayText.trim();
    if (!text) {
      return;
    }
    setRelayText('');
    onRelay(agent, text);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-purple-400/70 bg-card shadow-sm dark:border-purple-500/60">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          onClick={onCollapse}
          className="flex-shrink-0 rounded px-0.5 text-[13px] leading-none text-muted-foreground transition-colors hover:text-foreground"
          aria-label="收起"
        >
          ‹
        </button>
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${STATUS_DOT[displayStatus]}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-foreground">{agent.description || agent.taskId}</div>
          <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
            <span>{STATUS_LABEL[displayStatus]}</span>
            {agent.agentType ? <span>{agent.agentType}</span> : null}
            {agent.name ? <span>{agent.name}</span> : null}
            {tokens ? <span>{tokens}</span> : null}
            {duration ? <span>{duration}</span> : null}
          </div>
        </div>
        {displayStatus === 'running' ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            className="flex-shrink-0 rounded-md border border-red-400/60 px-2 py-0.5 text-[11px] text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:border-red-500/50 dark:text-red-400"
          >
            {stopping ? '停止中…' : '停止'}
          </button>
        ) : null}
      </div>

      <div ref={scrollRef} className="max-h-[52vh] min-h-[36vh] space-y-2 overflow-y-auto px-2.5 py-2">
        {agent.prompt ? (
          <details className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-[11.5px] text-muted-foreground">
            <summary className="cursor-pointer select-none text-[11px]">任务提示词</summary>
            <div className="mt-1 whitespace-pre-wrap break-words">{agent.prompt}</div>
          </details>
        ) : null}
        {chatMessages.map((message, index) => (
          <AgentMessageRow key={(message as { id?: string }).id || `${agent.taskId}_${index}`} message={message} />
        ))}
        {chatMessages.length === 0 && agent.historyLoaded ? (
          <div className="py-6 text-center text-[12px] text-muted-foreground">暂无对话记录</div>
        ) : null}
        {chatMessages.length === 0 && !agent.historyLoaded ? (
          <div className="py-6 text-center text-[12px] text-muted-foreground">正在载入对话…</div>
        ) : null}
      </div>

      <div className="border-t border-border/60 px-2.5 py-1.5">
        <div className="flex items-end gap-2">
          <textarea
            value={relayText}
            onChange={(event) => setRelayText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleRelay();
              }
            }}
            rows={2}
            placeholder="输入要转达给该 agent 的消息…"
            className="min-h-0 w-full flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={handleRelay}
            disabled={!relayText.trim()}
            className="flex-shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            转达
          </button>
        </div>
        <div className="mt-1 text-[10.5px] text-muted-foreground">
          经 lead 转达：内容将填入主输入框，由 lead 转发给该 agent（或队友），可自行编辑后发送
        </div>
      </div>
    </div>
  );
}
