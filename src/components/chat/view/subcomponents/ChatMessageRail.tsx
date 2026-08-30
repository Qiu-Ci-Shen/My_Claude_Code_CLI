import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { ChatMessage } from '../../types/types';

type ChatMessageRailProps = {
  /** 聊天滚动容器（ChatMessagesPane 根节点） */
  containerRef: RefObject<HTMLDivElement | null>;
  /** 当前渲染的消息列表（与 DOM 中的 .chat-message.user 顺序一一对应） */
  messages: ChatMessage[];
};

type UserMark = {
  /** 消息在滚动内容坐标系里的 y 像素 */
  top: number;
  question: string;
};

const QUESTION_CHARS = 120;
const ANSWER_CHARS = 100;
/** 均匀分布时的理想间距/最挤间距，对齐 ZCode 的密排细杠观感 */
const IDEAL_GAP_PX = 13;
const MIN_GAP_PX = 5;
const RAIL_PADDING_PX = 8;

/** 波浪动效：离视口中心越近横杠越长，第 3 根起恢复基准长度 */
const BASE_WIDTH_PX = 8;
const waveWidth = (distance: number): number => {
  if (distance <= 0) return 17;
  if (distance === 1) return 13;
  if (distance === 2) return 10;
  return BASE_WIDTH_PX;
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 聊天区左侧的「提问点」导航轨：每条用户消息一根小细杠，按消息序号均匀
 * 紧凑排列，整排在竖轨内垂直居中。滚动时有波浪动效——视口中心的横杠最长，
 * 相邻两根渐短，第三根起恢复基准长度，滑动时呈现流动感。悬停浮出该条提问
 * 与其后 AI 回复的摘要；点击平滑跳转并把该消息对齐到视口顶部。
 */
function ChatMessageRail({ containerRef, messages }: ChatMessageRailProps) {
  const [marks, setMarks] = useState<UserMark[]>([]);
  const [scrollable, setScrollable] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [centerIdx, setCenterIdx] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(-1);

  // 回调经 ref 转发，供只挂载一次的 ResizeObserver/scroll 监听使用
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const measureRef = useRef<() => void>(() => {});
  const updateCenterRef = useRef<() => void>(() => {});

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const elements = container.querySelectorAll<HTMLElement>('.chat-message.user');
    const userMessages = messagesRef.current.filter((m) => m.type === 'user');
    // DOM 与消息数组必须一一对应，否则预览文本会张冠李戴
    if (elements.length !== userMessages.length) {
      setMarks((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const next: UserMark[] = [];
    elements.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      const message = userMessages[i];
      const text = message ? String(message.content || '').trim() : '';
      next.push({
        top: rect.top - containerRect.top + container.scrollTop,
        question: truncate(
          text || (message?.images?.length ? '[图片消息]' : '[文件消息]'),
          QUESTION_CHARS,
        ),
      });
    });
    setMarks(next);
    setScrollable(container.scrollHeight - container.clientHeight > 80);
    setRailHeight(container.clientHeight);
  }, [containerRef]);

  measureRef.current = measure;

  /** 视口中心对准的那条提问 = 波峰横杠 */
  const updateCenter = useCallback(() => {
    const container = containerRef.current;
    if (!container || marks.length === 0) return;
    const viewCenter = container.scrollTop + container.clientHeight / 2;
    let idx = 0;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].top <= viewCenter) idx = i;
      else break;
    }
    setCenterIdx(idx);
  }, [containerRef, marks]);

  updateCenterRef.current = updateCenter;

  // 只挂载一次的监听：滚动 → 更新波峰位置（rAF 节流）；
  // 内容高度变化（流式输出/分页加载/图片/窗口缩放）→ 重新测量
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureRef.current();
        updateCenterRef.current();
      });
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateCenterRef.current();
      });
    };

    const inner = container.lastElementChild;
    const observer = inner instanceof Element ? new ResizeObserver(schedule) : null;
    if (inner instanceof Element && observer) observer.observe(inner);
    container.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', schedule);

    // 首帧渲染完成后再量一次
    schedule();

    return () => {
      observer?.disconnect();
      container.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef]);

  // 消息列表变化（发消息/切会话/加载更早消息）→ 立即重测
  useEffect(() => {
    measure();
    updateCenter();
  }, [messages, measure, updateCenter]);

  // 轨道像素位置：按消息序号均匀排列；消息多时收缩间距，少时保持密排，
  // 且整排横杠在竖轨里垂直居中（不挤在顶部留一大段空轨）
  const positions = useMemo(() => {
    const n = marks.length;
    if (n === 0 || railHeight <= 0) return [];
    const usable = Math.max(0, railHeight - RAIL_PADDING_PX * 2);
    const gap = n > 1 ? Math.max(MIN_GAP_PX, Math.min(IDEAL_GAP_PX, usable / (n - 1))) : 0;
    const stackHeight = (n - 1) * gap;
    const start = Math.max(RAIL_PADDING_PX, (railHeight - stackHeight) / 2);
    return marks.map((_, i) => start + i * gap);
  }, [marks, railHeight]);

  // 每条提问后第一条非空 AI 回复，用于悬停摘要
  const answers = useMemo(() => {
    const result: string[] = [];
    let pending = -1;
    for (const m of messages) {
      if (m.type === 'user') {
        result.push('');
        pending = result.length - 1;
      } else if (m.type === 'assistant' && pending >= 0 && !result[pending]) {
        const text = String(m.content || m.displayText || '').trim();
        if (text) result[pending] = truncate(text, ANSWER_CHARS);
      }
    }
    return result;
  }, [messages]);

  const jumpTo = useCallback((mark: UserMark) => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({ top: Math.max(0, mark.top - 8), behavior: 'smooth' });
  }, [containerRef]);

  if (!scrollable || marks.length < 2 || railHeight <= 0) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute bottom-2 left-1 top-2 z-20 w-5">
      {marks.map((mark, i) => {
        const hovered = i === hoverIdx;
        const distance = Math.abs(i - centerIdx);
        const width = hovered ? 17 : waveWidth(distance);
        const emphasized = hovered || distance === 0;
        return (
          <button
            key={`${mark.top}-${i}`}
            type="button"
            onClick={() => jumpTo(mark)}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(-1)}
            aria-label={`跳转到第 ${i + 1} 条消息`}
            className="pointer-events-auto absolute left-1/2 flex h-3 -translate-x-1/2 cursor-pointer items-center justify-center"
            style={{ top: positions[i] - 6, width: 18 }}
          >
            <span
              className="block h-[2px] rounded-full transition-all duration-200 ease-out"
              style={{
                width,
                backgroundColor: emphasized
                  ? 'hsl(var(--primary))'
                  : distance === 1
                    ? 'hsl(var(--muted-foreground) / 0.6)'
                    : 'hsl(var(--muted-foreground) / 0.3)',
              }}
            />
          </button>
        );
      })}
      {hoverIdx >= 0 && marks[hoverIdx] && (
        <div
          className="pointer-events-auto absolute left-6 z-30 w-[17.5rem] max-w-[calc(100vw-6rem)] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
          style={{
            top: Math.min(
              Math.max(0, positions[hoverIdx] - 12),
              Math.max(0, railHeight - 150),
            ),
          }}
        >
          <div
            className="break-words whitespace-pre-wrap"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {hoverIdx < answers.length && marks[hoverIdx].question}
          </div>
          {answers[hoverIdx] && (
            <div
              className="mt-1 break-words whitespace-pre-wrap border-t border-border/40 pt-1 text-muted-foreground"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {answers[hoverIdx]}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatMessageRail;
