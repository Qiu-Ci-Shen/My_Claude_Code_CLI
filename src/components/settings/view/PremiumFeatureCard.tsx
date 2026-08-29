import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';

type PremiumFeatureCardProps = {
  icon: ReactNode;
  title: string;
  description: string;
  ctaText?: string;
};

export default function PremiumFeatureCard({
  icon,
  title,
  description,
  ctaText = 'Available with Qiu_Ai_LZ Pro',
}: PremiumFeatureCardProps) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">{title}</h4>
            <Lock className="h-3 w-3 text-muted-foreground/60" />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
          <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
            {ctaText}
          </span>
        </div>
      </div>
    </div>
  );
}
