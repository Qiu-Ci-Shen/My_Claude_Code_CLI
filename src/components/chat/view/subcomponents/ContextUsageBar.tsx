import type { ReactNode } from 'react';

type ContextUsageBarProps = {
  tokenBudget: Record<string, unknown> | null;
  trailing?: ReactNode;
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
export default function ContextUsageBar({ tokenBudget, trailing }: ContextUsageBarProps) {
  const reportedPercent = readNumber(tokenBudget?.contextPercent);
  const used = readNumber(tokenBudget?.used);
  const total = readNumber(tokenBudget?.contextWindow ?? tokenBudget?.total);
  const percent = reportedPercent > 0
    ? reportedPercent
    : total > 0
      ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
      : 0;
  // 缓存命中率 = 缓存命中的输入 / 本次请求的全部输入（直连 + 缓存读 + 缓存写）
  const cacheReadTokens = readNumber(tokenBudget?.cacheReadTokens);
  const inputTokens = readNumber(tokenBudget?.inputTokens);
  const cacheHitPercent = inputTokens > 0
    ? Math.min(100, Math.max(0, (cacheReadTokens / inputTokens) * 100))
    : 0;
  // 优先会话累计口径（服务端按 provider 会话累积三桶、防假 100 后下发）；
  // 其他 provider 或旧消息没有该字段时回退单请求快照
  const sessionHitRaw = tokenBudget?.sessionCacheHitPercent;
  const sessionHit = Number(sessionHitRaw);
  const sessionHitDisplayPercent = sessionHitRaw !== null
    && sessionHitRaw !== undefined
    && Number.isFinite(sessionHit)
    ? sessionHit
    : cacheHitPercent;

  const showContextBar = total > 0;

  if (!showContextBar && !trailing) {
    return null;
  }

  const hue = Math.max(0, 120 * Math.max(0, 1 - percent / 40));
  const barColor = `hsl(${hue} 60% 45%)`;

  return (
    <div className="mb-1.5 flex items-center justify-end gap-2 px-3">
      {showContextBar && (
        <>
          <span
            className="text-xs font-medium text-muted-foreground/70"
            title="会话累计缓存命中率（冷启动从低值累积；100% = 真·全命中）"
          >
            缓存命中率
          </span>
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            {sessionHitDisplayPercent.toFixed(1)}%
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Context
          </span>
          <div
            className="h-1 w-32 overflow-hidden rounded-full bg-muted/60"
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
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            {percent}%
          </span>
        </>
      )}
      {trailing}
    </div>
  );
}