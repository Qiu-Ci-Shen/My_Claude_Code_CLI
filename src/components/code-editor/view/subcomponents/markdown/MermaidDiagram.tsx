import { useEffect, useId, useState } from 'react';

import { useTheme } from '../../../../../contexts/ThemeContext';

// Mermaid is ~1.5MB minified, so it is loaded on demand the first time a
// diagram is rendered and shared by every instance afterwards.
let mermaidPromise: Promise<typeof import('mermaid')['default']> | null = null;
const loadMermaid = () => {
  mermaidPromise ??= import('mermaid').then((module) => module.default);
  return mermaidPromise;
};

type MermaidDiagramProps = {
  /** Raw mermaid source, i.e. the body of a ```mermaid fenced block. */
  code: string;
};

/**
 * Renders a ```mermaid code block as an SVG diagram, GitHub-preview style.
 *
 * While mermaid is loading — or when the source doesn't parse (e.g. a block
 * that is still streaming in) — the raw source is shown instead, so the
 * content is never blank or replaced by an error box.
 */
export default function MermaidDiagram({ code }: MermaidDiagramProps) {
  const { isDarkMode } = useTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;

    // 流式输出期间 code 每 ~100ms 变化一次；立刻渲染的话每次变化都要跑一遍
    // 重量级 mermaid.render（且多半因代码未闭合而解析失败）。等到代码安静
    // 250ms 再渲染一次，流式时只在成块结束后真正渲染。
    const timer = window.setTimeout(() => {
      loadMermaid()
        .then((mermaid) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: isDarkMode ? 'dark' : 'default',
            suppressErrorRendering: true,
          });
          return mermaid.render(renderId, code.trim());
        })
        .then((result) => {
          if (!cancelled) {
            setSvg(result.svg);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSvg(null);
          }
          // suppressErrorRendering still leaves the scratch element behind on
          // parse failures in some mermaid versions; clean it up.
          document.getElementById(`d${renderId}`)?.remove();
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, isDarkMode, reactId]);

  if (!svg) {
    return (
      <pre className="my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900">
        {code.trim()}
      </pre>
    );
  }

  return (
    <div
      className="my-3 flex justify-center overflow-x-auto rounded-xl border border-border bg-white p-4 dark:bg-zinc-900 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
