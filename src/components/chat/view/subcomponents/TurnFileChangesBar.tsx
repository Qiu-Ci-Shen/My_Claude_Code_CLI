import { useState } from 'react';
import { ChevronRightIcon } from 'lucide-react';

import type { TurnChanges } from '../../utils/turnFileChanges';

type TurnFileChangesBarProps = {
  changes: TurnChanges;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
};

/** 展示路径：保留最后两级（父目录/文件名），完整路径放 title 悬停查看 */
function displayPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}

/**
 * 「N 个文件已更改」折叠条（自官方 Claude Code 复刻）：
 * 挂在每个回合最后一条消息之后，箭头展开本回合改动的文件列表，
 * 点击文件行用编辑器 diff 视图审查该文件的修改内容。
 */
export default function TurnFileChangesBar({ changes, onFileOpen }: TurnFileChangesBarProps) {
  const [expanded, setExpanded] = useState(false);

  if (changes.files.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[54.25rem] px-3 sm:px-0">
      <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/40 dark:border-gray-700/60 dark:bg-gray-800/40">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-accent/50"
          aria-expanded={expanded}
        >
          <ChevronRightIcon
            className={`h-4 w-4 flex-none text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          />
          <span>
            {changes.files.length} 个文件已更改
          </span>
          <span className="font-mono text-xs">
            <span className="text-emerald-600 dark:text-emerald-400">+{changes.totalAdded}</span>{' '}
            <span className="text-red-500 dark:text-red-400">-{changes.totalRemoved}</span>
          </span>
        </button>

        {expanded && (
          <div className="border-t border-border/60 dark:border-gray-700/60">
            {changes.files.map((file) => (
              <button
                key={file.filePath}
                type="button"
                disabled={!onFileOpen}
                onClick={() =>
                  onFileOpen?.(
                    file.filePath,
                    file.lastDiff
                      ? { old_string: file.lastDiff.old_string, new_string: file.lastDiff.new_string }
                      : undefined,
                  )
                }
                className="flex w-full items-center justify-between gap-3 px-4 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60 disabled:cursor-default"
                title={onFileOpen ? `审查 ${file.filePath}` : file.filePath}
              >
                <span className="truncate text-foreground">{displayPath(file.filePath)}</span>
                <span className="flex-none font-mono text-xs">
                  <span className="text-emerald-600 dark:text-emerald-400">+{file.added}</span>{' '}
                  <span className="text-red-500 dark:text-red-400">-{file.removed}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
