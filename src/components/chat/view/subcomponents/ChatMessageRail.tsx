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
  /** top / scrollHeight，映射到轨道比例 */
  ratio: number;
  preview: string;
  timeText: string;
};

const MIN_GAP_PX = 10;
const PREVIEW_CHARS = 120;

/**
 * 聊天区左侧的「提问点」导航轨：每条用户消息一个小横杠，按其在会话中的
 * 实际位置纵向分布（minimap 滚动条）。滚动时当前视口对应的横杠高亮跟随；
 * 悬停浮出该消息的内容预览与时间；点击后平滑跳转并把该消息对齐到视口顶部。
 */
function ChatMessageRail({ containerRef, messages }: ChatMessageRailProps) {
  const [marks, setMarks] = useState<UserMark[]>([]);
  const [scrollable, setScrollable] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [activeIdx, setActiveIdx] = useState(-1);
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
      next.push({
        top,
        ratio: container.scrollHeight > 0 ? top / container.scrollHeight : 0,
        preview,
        timeText,
      });
    });
    setMarks(next);
    setScrollable(container.scrollHeight - container.clientHeight > 80);
    setRailHeight(container.clientHeight);
  }, [containerRef]);

  measureRef.current = measure;

  const updateActive = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // 视口顶部往下一点的位置算「当前所在」
    const viewportTop = container.scrollTop + 48;
    let idx = -1;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].top <= viewportTop) idx = i;
      else break;
    }
    setActiveIdx(idx);
  }, [containerRef, marks]);

  const updateActiveRef = useRef(updateActive);
  updateActiveRef.current = updateActive;

  // 只挂载一次的监听：内容高度变化（流式输出/分页加载/图片）→ 重新测量；
  // 滚动 → 更新高亮横杠
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

  // 轨道像素位置：按比例映射 + 最近邻最小间距（长会话密集处不至于重叠）
  const positions = useMemo(() => {
    let prev = -Infinity;
    return marks.map((mark) => {
      const raw = mark.ratio * railHeight;
      const pos = Math.min(Math.max(raw, prev + MIN_GAP_PX), Math.max(0, railHeight - 6));
      prev = pos;
      return pos;
    });
  }, [marks, railHeight]);

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
        const highlighted = i === activeIdx || i === hoverIdx;
        return (
          <button
            key={`${mark.top}-${i}`}
            type="button"
            onClick={() => jumpTo(mark)}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(-1)}
            aria-label={mark.timeText ? `跳转到 ${mark.timeText} 的消息` : '跳转到消息'}
            className={`pointer-events-auto absolute left-1/2 h-1.5 -translate-x-1/2 cursor-pointer rounded-full transition-all duration-150 ${
              highlighted
                ? 'w-3.5 bg-primary'
                : 'w-2.5 bg-muted-foreground/30 hover:bg-muted-foreground/60'
            }`}
            style={{ top: positions[i] - 3 }}
          />
        );
      })}
      {hoverIdx >= 0 && marks[hoverIdx] && (
        <div
          className="pointer-events-auto absolute left-5 z-30 max-w-xs rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
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
