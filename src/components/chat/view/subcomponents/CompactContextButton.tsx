type CompactContextButtonProps = {
  onCompact: () => void;
  disabled?: boolean;
};

/**
 * 与终端 CLI 的 /compact 同一条路：点击把命令作为一轮消息发给 CLI，
 * 由 CLI 原生执行压缩（摘要随后写入转录并回流到对话）。
 */
export default function CompactContextButton({ onCompact, disabled = false }: CompactContextButtonProps) {
  return (
    <button
      type="button"
      onClick={onCompact}
      disabled={disabled}
      title="压缩上下文：把当前对话总结压缩，释放上下文窗口（同终端 /compact）"
      aria-label="压缩上下文"
      className="flex h-6 flex-shrink-0 items-center rounded-md border border-border/50 px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      压缩上下文
    </button>
  );
}
