import { useEffect, useRef, useState } from 'react';

type EditMessageCardProps = {
  originalText: string;
  busy: boolean;
  error: string | null;
  onResend: (text: string, restoreFiles: boolean) => void;
  onCancel: () => void;
};

/**
 * 编辑重发的内联卡片：替代原消息气泡，预填原文。
 * 「同时恢复代码文件」勾选后，重发会先调用 claude-rewind 把代码文件
 * 恢复到该消息发出前的 checkpoint。
 */
export default function EditMessageCard({
  originalText,
  busy,
  error,
  onResend,
  onCancel,
}: EditMessageCardProps) {
  const [text, setText] = useState(originalText);
  const [restoreFiles, setRestoreFiles] = useState(false);
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
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/40 pt-2">
        <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={restoreFiles}
            onChange={(event) => setRestoreFiles(event.target.checked)}
            disabled={busy}
            className="h-3.5 w-3.5 accent-primary"
          />
          同时恢复代码文件
        </label>
        <div className="flex items-center gap-2">
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
            onClick={() => canSubmit && onResend(text, restoreFiles)}
            disabled={!canSubmit}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? '正在回退会话…' : '重发'}
          </button>
        </div>
      </div>
      {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
    </div>
  );
}
