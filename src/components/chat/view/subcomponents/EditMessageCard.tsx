import { useEffect, useRef, useState } from 'react';

type EditMessageCardProps = {
  originalText: string;
  busy: boolean;
  error: string | null;
  onResend: (text: string) => void;
  onCancel: () => void;
};

/**
 * 编辑重发的内联卡片：替代原消息气泡，预填原文。
 * 重发 = 截断会话中这条消息及其后的全部内容，再用编辑后的文本重新发送。
 */
export default function EditMessageCard({
  originalText,
  busy,
  error,
  onResend,
  onCancel,
}: EditMessageCardProps) {
  const [text, setText] = useState(originalText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const canSubmit = !busy && text.trim().length > 0;

  return (
    <div className="w-full rounded-2xl rounded-br-md border border-primary/40 bg-background px-3 py-2 shadow-sm sm:px-4">
      <textarea
        ref={textareaRef}
        value={text}
        rows={Math.min(10, Math.max(3, text.split('\n').length))}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onCancel();
          }
        }}
        disabled={busy}
        className="w-full resize-none bg-transparent font-serif text-sm text-foreground outline-none"
        placeholder="编辑消息内容…（@ 可引用文件路径）"
      />
      <div className="mt-1 flex items-center justify-end gap-2 border-t border-border/40 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-border/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => canSubmit && onResend(text)}
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? '正在回退会话…' : '重发'}
        </button>
      </div>
      {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
    </div>
  );
}
