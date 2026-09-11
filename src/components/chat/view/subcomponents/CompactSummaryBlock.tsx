import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ChevronDown } from 'lucide-react';

import { cn } from '../../../../lib/utils';

import { Markdown } from './Markdown';

type CompactSummaryBlockProps = {
  content: string;
};

/**
 * 压缩摘要折叠块。终端 CLI 的 /compact 只显示一行「Compacted」，而摘要正文
 * （数千字的对话总结）在 UI 里若整段展开会占满整个对话区——默认折叠成一行，
 * 点击才展开查看。
 */
export default function CompactSummaryBlock({ content }: CompactSummaryBlockProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-accent/40"
      >
        <Archive className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
        <span className="text-xs text-gray-500 dark:text-gray-400">{t('compactSummary.label')}</span>
        <span className="text-xs font-medium text-muted-foreground/70">
          {open ? t('compactSummary.hide') : t('compactSummary.show')}
        </span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-muted-foreground/50 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div className="mt-1.5 max-h-[60vh] overflow-y-auto rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
          <Markdown className="prose prose-sm prose-gray max-w-none font-serif text-[13px] dark:prose-invert">
            {content}
          </Markdown>
        </div>
      )}
    </div>
  );
}
