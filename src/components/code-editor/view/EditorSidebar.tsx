import { useState, useEffect, useRef } from 'react';
import type { MouseEvent, MutableRefObject } from 'react';
import type { CodeEditorFile } from '../types/types';
import CodeEditor from './CodeEditor';

type EditorSidebarProps = {
  editingFile: CodeEditorFile | null;
  isMobile: boolean;
  editorExpanded: boolean;
  editorWidth: number;
  resizeHandleRef: MutableRefObject<HTMLDivElement | null>;
  onResizeStart: (event: MouseEvent<HTMLDivElement>) => void;
  onCloseEditor: () => void;
  onToggleEditorExpand: () => void;
  projectPath?: string;
};

// Minimum width for the left content (file tree, chat, etc.)
const MIN_LEFT_CONTENT_WIDTH = 200;
// Minimum width for the editor sidebar
const MIN_EDITOR_WIDTH = 280;

export default function EditorSidebar({
  editingFile,
  isMobile,
  editorExpanded,
  editorWidth,
  resizeHandleRef,
  onResizeStart,
  onCloseEditor,
  onToggleEditorExpand,
  projectPath,
}: EditorSidebarProps) {
  const [poppedOut, setPoppedOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [effectiveWidth, setEffectiveWidth] = useState(editorWidth);

  // Adjust editor width when container size changes to ensure buttons are always visible
  useEffect(() => {
    if (!editingFile || isMobile || poppedOut) return;

    const updateWidth = () => {
      if (!containerRef.current) return;
      const parentElement = containerRef.current.parentElement;
      if (!parentElement) return;

      const containerWidth = parentElement.clientWidth;

      // Calculate maximum allowed editor width
      const maxEditorWidth = containerWidth - MIN_LEFT_CONTENT_WIDTH;

      if (maxEditorWidth < MIN_EDITOR_WIDTH) {
        // Not enough space - pop out the editor so user can still see everything
        setPoppedOut(true);
      } else if (editorWidth > maxEditorWidth) {
        // Editor is too wide - constrain it to ensure left content has space
        setEffectiveWidth(maxEditorWidth);
      } else {
        setEffectiveWidth(editorWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);

    // Also use ResizeObserver for more accurate detection
    const resizeObserver = new ResizeObserver(updateWidth);
    const parentEl = containerRef.current?.parentElement;
    if (parentEl) {
      resizeObserver.observe(parentEl);
    }

    return () => {
      window.removeEventListener('resize', updateWidth);
      resizeObserver.disconnect();
    };
  }, [editingFile, isMobile, poppedOut, editorWidth]);

  if (!editingFile) {
    return null;
  }

  if (isMobile || poppedOut) {
    return (
      <CodeEditor
        file={editingFile}
        onClose={() => {
          setPoppedOut(false);
          onCloseEditor();
        }}
        projectPath={projectPath}
        isSidebar={false}
      />
    );
  }

  const useFlexLayout = editorExpanded;

  return (
    <div ref={containerRef} className={`flex h-full min-w-0 ${editorExpanded ? 'flex-1' : ''}`}>
      {!editorExpanded && (
        <div
          ref={resizeHandleRef}
          onMouseDown={onResizeStart}
          className="group relative w-1 flex-shrink-0 cursor-col-resize bg-gray-200 transition-colors hover:bg-blue-500 dark:bg-gray-700 dark:hover:bg-blue-600"
          title="Drag to resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-blue-500 opacity-0 transition-opacity group-hover:opacity-100 dark:bg-blue-600" />
        </div>
      )}

      <div
        className={`h-full overflow-hidden border-l border-gray-200 dark:border-gray-700 ${useFlexLayout ? 'min-w-0 flex-1' : `min-w-[ flex-shrink-0${MIN_EDITOR_WIDTH}px]`}`}
        style={useFlexLayout ? undefined : { width: `${effectiveWidth}px`, minWidth: `${MIN_EDITOR_WIDTH}px` }}
      >
        {/* key=文件路径：换文件时重置 showDiff/预览等本地 UI 状态（否则 diff 文件
            跟在普通文件后面打开时，diff 视图永远不会出现） */}
        <CodeEditor
          key={editingFile.path}
          file={editingFile}
          onClose={onCloseEditor}
          projectPath={projectPath}
          isSidebar
          isExpanded={editorExpanded}
          onToggleExpand={onToggleEditorExpand}
          onPopOut={() => setPoppedOut(true)}
        />
      </div>
    </div>
  );
}
