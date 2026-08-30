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
  answer: string;
};

const QUESTION_CHARS = 200;
const ANSWER_CHARS = 160;
/** 均匀分布时的理想间距/最挤间距，对齐 ZCode 的密排细杠观感 */
const IDEAL_GAP_PX = 13;
const MIN_GAP_PX = 5;
const RAIL_PADDING_PX = 8;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 聊天区左侧的「提问点」导航轨：每条用户消息一根小细杠，按消息序号均匀
 * 紧凑排列（ZCode 同款密排标尺观感），整排在竖轨内垂直居中。横杠是静态的；
 * 悬停浮出该条提问与其后 AI 回复的摘要；点击平滑跳转并把该消息对齐到视口
 * 顶部。
 */
function ChatMessageRail({ containerRef, messages }: ChatMessageRailProps) {
  const [marks, setMarks] = useState<UserMark[]>([]);
  const [scrollable, setScrollable] = useState(false);
  const [railHeight, setRailHeight] = useState(0);
  const [hoverIdx, setHoverIdx] = useState(-1);

  // 回调经 ref 转发，供只挂载一次的 ResizeObserver 使用
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const measureRef = useRef<() => void>(() => {});

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const elements = container.querySelectorAll<HTMLElement>('.chat-message.user');
    const all = messagesRef.current;

    // 按顺序为每条用户消息收集「问题 + 其后第一条非空 AI 回复」，
    // qas 的顺序与 DOM 中 .chat-message.user 一一对应
    const qas: Array<{ question: string; answer: string }> = [];
    for (const m of all) {
      if (m.type === 'user') {
        const text = String(m.content || '').trim();
        qas.push({
          question: text || (m.images?.length ? '[图片消息]' : '[文件消息]'),
          answer: '',
        });
      } else if (m.type === 'assistant' && qas.length > 0) {
        const last = qas[qas.length - 1];
        if (!last.answer) {
          const text = String(m.content || m.displayText || '').trim();
          if (text) last.answer = truncate(text, ANSWER_CHARS);
        }
      }
    }

    // DOM 与消息数组必须一一对应，否则提示文本会张冠李戴
    if (elements.length !== qas.length) {
      setMarks((prev) => (prev.length === 0 ? prev : []));
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const next: UserMark[] = [];
    elements.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      next.push({
        top: rect.top - containerRect.top + container.scrollTop,
        question: truncate(qas[i]?.question || '', QUESTION_CHARS),
        answer: qas[i]?.answer || '',
      });
    });
    setMarks(next);
    setScrollable(container.scrollHeight - container.clientHeight > 80);
    setRailHeight(container.clientHeight);
  }, [containerRef]);

  measureRef.current = measure;

  // 内容高度变化（流式输出/分页加载/图片/窗口缩放）→ 重新测量横杠位置
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureRef.current();
      });
    };

    const inner = container.lastElementChild;
    const observer = inner instanceof Element ? new ResizeObserver(schedule) : null;
    if (inner instanceof Element && observer) observer.observe(inner);
    window.addEventListener('resize', schedule);

    // 首帧渲染完成后再量一次
    schedule();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef]);

  // 消息列表变化（发消息/切会话/加载更早消息）→ 立即重测
  useEffect(() => {
    measure();
  }, [messages, measure]);

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

  return (
    <div className="pointer-events-none absolute bottom-2 left-1 top-2 z-20 w-5">
      {marks.map((mark, i) => (
        <button
          key={`${mark.top}-${i}`}
          type="button"
          onClick={() => jumpTo(mark)}
          onMouseEnter={() => setHoverIdx(i)}
          onMouseLeave={() => setHoverIdx(-1)}
          aria-label={`跳转到第 ${i + 1} 条消息`}
          className="pointer-events-auto absolute left-1/2 flex h-3 w-4 -translate-x-1/2 cursor-pointer items-center justify-center"
          style={{ top: positions[i] - 6 }}
        >
          <span
            className={`block h-[2px] rounded-full transition-colors duration-150 ${
              i === hoverIdx
                ? 'w-3 bg-primary'
                : 'w-2 bg-muted-foreground/30 hover:bg-muted-foreground/60'
            }`}
          />
        </button>
      ))}
      {hoverIdx >= 0 && marks[hoverIdx] && (
        <div
          className="pointer-events-auto absolute left-6 z-30 w-[48rem] max-w-[calc(100vw-6rem)] rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
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
            {marks[hoverIdx].question}
          </div>
          {marks[hoverIdx].answer && (
            <div
              className="mt-1 break-words whitespace-pre-wrap border-t border-border/40 pt-1 text-muted-foreground"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {marks[hoverIdx].answer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatMessageRail;
