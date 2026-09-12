import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';

// SVG 是模型生成的不可信内容（可能混入从网页读回的注入内容），必须过
// sanitizer 再内联渲染：svg profile 只放行图形/文本/表现属性，剔除
// foreignObject（内嵌 HTML 可逃出 SVG 沙箱）、style 标签（内联 SVG 的
// <style> 作用域是整页，会污染聊天界面）、<a>（误点会把应用窗口导航走）。
const SVG_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'style', 'a'],
};

const FALLBACK_CLASS =
  'my-3 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-[0.8125rem] leading-relaxed text-muted-foreground dark:bg-zinc-900';

type SvgDiagramProps = {
  /** Raw SVG source, i.e. the body of a ```svg fenced block. */
  code: string;
};

/**
 * Renders a ```svg code block as an inline vector drawing, so the model can
 * draw diagrams/infographics directly in chat. Falls back to showing the raw
 * source while the block is still streaming in or when sanitizing leaves no
 * usable <svg>, so the content is never blank.
 */
export default function SvgDiagram({ code }: SvgDiagramProps) {
  const sanitized = useMemo(() => {
    try {
      return DOMPurify.sanitize(code, SVG_SANITIZE_CONFIG);
    } catch {
      return '';
    }
  }, [code]);

  if (!sanitized.includes('<svg')) {
    return <pre className={FALLBACK_CLASS}>{code}</pre>;
  }

  return (
    <div
      className="my-3 flex justify-center overflow-x-auto rounded-xl border border-border bg-white p-4 dark:bg-zinc-900 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
