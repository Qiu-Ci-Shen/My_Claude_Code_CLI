type ContextUsageBarProps = {
  tokenBudget: Record<string, unknown> | null;
};

const readNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Slim context-window usage bar rendered above the composer, mirroring the CLI
 * status line's `Context █████░░░░░ 45%`. Color follows the same gradient used
 * by the HUD: 0% green (hue 120) → 40%+ red (hue 0).
 */
export default function ContextUsageBar({ tokenBudget }: ContextUsageBarProps) {
  const reportedPercent = readNumber(tokenBudget?.contextPercent);
  const used = readNumber(tokenBudget?.used);
  const total = readNumber(tokenBudget?.contextWindow ?? tokenBudget?.total);
  const percent = reportedPercent > 0
    ? reportedPercent
    : total > 0
      ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
      : 0;

  if (total <= 0) {
    return null;
  }

  const hue = Math.max(0, 120 * Math.max(0, 1 - percent / 40));
  const barColor = `hsl(${hue} 60% 45%)`;

  return (
    <div className="mx-3 mb-1 flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        Context
      </span>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted/60"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context usage"
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${percent}%`, backgroundColor: barColor }}
        />
      </div>
      <span className="w-10 text-right text-xs font-medium tabular-nums text-muted-foreground">
        {percent}%
      </span>
    </div>
  );
}