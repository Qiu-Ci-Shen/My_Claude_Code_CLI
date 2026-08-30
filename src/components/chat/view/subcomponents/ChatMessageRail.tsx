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
  preview: string;
  timeText: string;
};

const PREVIEW_CHARS = 120;
/** 均匀分布时的理想间距/最挤间距，对齐 ZCode 的密排细杠观感 */
const IDEAL_GAP_PX = 13;
const MIN_GAP_PX = 5;
const RAIL_PADDING_PX = 8;

/**
 * 聊天区左侧的「提问点」导航轨：每条用户消息一根小细杠，按消息序号均匀
 * 紧凑排列（ZCode 同款密排标尺观感，不随内容长度拉开间距）。滚动时当前
 * 视口覆盖的区间以高亮色带指示；悬停浮出内容预览与时间；点击平滑跳转并
 * 把该消息对齐到视口顶部。
 */
function ChatMessageRail({ containerRef, messages }: ChatMessageRailProps) {
  const [marks, setMarks] = useState<UserMark[]>([]);
  const [scrollable, setScrollable] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [viewRange, setViewRange] = useState<{ first: number; last: number }>({ first: -1, last: -1 });
  const [hoverIdx, setHoverIdx] = useState(-1);

  // 回调经 ref 转发，供只挂载一次的 ResizeObserver/scroll 监听使用
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const measureRef = useRef<() => void>(() => {});

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
      const top = rect.top - containerRect.top + container.scrollTop;
      const message = userMessages[i];
      const text = String(message?.content || '').trim();
      const preview = text
        ? (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text)
        : (message?.images?.length ? '[图片消息]' : '[文件消息]');
      const ts = message?.timestamp;
      const timeText = ts
        ? new Date(ts).toLocaleString(undefined, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
        : '';
      next.push({ top, preview, timeText });
    });
    setMarks(next);
    setScrollable(container.scrollHeight - container.clientHeight > 80);
    setRailHeight(container.clientHeight);
  }, [containerRef]);

  measureRef.current = measure;

  const updateActive = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    let first = -1;
    let last = -1;
    for (let i = 0; i < marks.length; i++) {
      // 消息起点稍微进入视口就算覆盖
      if (marks[i].top + 60 >= viewTop && marks[i].top <= viewBottom) {
        if (first < 0) first = i;
        last = i;
      }
    }
    setViewRange({ first, last });
  }, [containerRef, marks]);

  const updateActiveRef = useRef(updateActive);
  updateActiveRef.current = updateActive;

  // 只挂载一次的监听：内容高度变化（流式输出/分页加载/图片）→ 重新测量；
  // 滚动 → 更新视口区间高亮
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureRef.current();
        updateActiveRef.current();
      });
    };

    const inner = container.lastElementChild;
    const observer = inner instanceof Element ? new ResizeObserver(schedule) : null;
    if (inner instanceof Element && observer) observer.observe(inner);

    container.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);

    // 首帧渲染完成后再量一次
    schedule();

    return () => {
      observer?.disconnect();
      container.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef]);

  // 消息列表变化（发消息/切会话/加载更早消息）→ 立即重测
  useEffect(() => {
    measure();
    updateActive();
  }, [messages, measure, updateActive]);

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

  const jumpTo = useCallback((mark: UserMark) => {
    const container = containerRef.current;
    if (!container) return;
    container.scrollTo({ top: Math.max(0, mark.top - 8), behavior: 'smooth' });
  }, [containerRef]);

  if (!scrollable || marks.length < 2 || railHeight <= 0) {
    return null;
  }

  const bandVisible = viewRange.first >= 0 && viewRange.last >= 0;
  const bandTop = bandVisible ? positions[viewRange.first] - 3 : 0;
  const bandBottom = bandVisible ? positions[viewRange.last] + 3 : 0;

  return (
    <div className="pointer-events-none absolute bottom-2 left-1 top-2 z-20 w-5">
      {bandVisible && (
        <div
          className="absolute left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-primary/25 transition-all duration-150"
          style={{ top: bandTop, height: Math.max(6, bandBottom - bandTop) }}
        />
      )}
      {marks.map((mark, i) => {
        const inView = i >= viewRange.first && i <= viewRange.last && viewRange.first >= 0;
        const highlighted = inView || i === hoverIdx;
        return (
          <button
            key={`${mark.top}-${i}`}
            type="button"
            onClick={() => jumpTo(mark)}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(-1)}
            aria-label={mark.timeText ? `跳转到 ${mark.timeText} 的消息` : '跳转到消息'}
            className="pointer-events-auto absolute left-1/2 flex h-3 w-4 -translate-x-1/2 cursor-pointer items-center justify-center"
            style={{ top: positions[i] - 6 }}
          >
            <span
              className={`block h-[2px] rounded-full transition-all duration-150 ${
                highlighted
                  ? 'w-3 bg-primary'
                  : 'w-2 bg-muted-foreground/30 hover:bg-muted-foreground/60'
              }`}
            />
          </button>
        );
      })}
      {hoverIdx >= 0 && marks[hoverIdx] && (
        <div
          className="pointer-events-auto absolute left-6 z-30 max-w-xs rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
          style={{
            top: Math.min(
              Math.max(0, positions[hoverIdx] - 12),
              Math.max(0, railHeight - 90),
            ),
          }}
        >
          <div className="mb-1 text-[10px] text-muted-foreground">{marks[hoverIdx].timeText}</div>
          <div
            className="break-words whitespace-pre-wrap"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {marks[hoverIdx].preview}
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatMessageRail;
