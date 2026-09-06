import { useEffect } from 'react';

type UseEditorKeyboardShortcutsParams = {
  onSave: () => void;
  onClose: () => void;
  dependency: string;
  /** 缓冲有未保存修改时，Esc 关闭前先确认（防误触丢稿） */
  isDirty?: () => boolean;
};

export const useEditorKeyboardShortcuts = ({
  onSave,
  onClose,
  dependency,
  isDirty,
}: UseEditorKeyboardShortcutsParams) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isDirty?.() && !window.confirm('编辑器有未保存的修改，确定丢弃并关闭？')) {
          return;
        }
        event.preventDefault();
        onClose();
        return;
      }

      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        onSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dependency, onClose, onSave, isDirty]);
};
