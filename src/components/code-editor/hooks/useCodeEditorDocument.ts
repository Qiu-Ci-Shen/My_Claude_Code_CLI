import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';
import { getPreviewKind } from '../utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 读取失败时置位：错误信息绝不写进可编辑缓冲（否则 Ctrl+S 会用报错文案覆盖磁盘文件）
  const [loadError, setLoadError] = useState<string | null>(null);
  // 未保存修改跟踪：缓冲内容 vs 磁盘加载内容（关闭前确认用）
  const loadedContentRef = useRef('');
  const [isBinary, setIsBinary] = useState(false);
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;

  useEffect(() => {
    // 竞态守卫：慢的旧文件读取不得覆盖新文件的内容（否则 Ctrl+S 会把 A 的
    // 字节写进 B）。依赖变化时 cleanup 先行，迟到响应一律丢弃——与
    // CodeEditorMediaPreview 的 loadedKey 门控同款思路。
    let active = true;
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);
        setLoadError(null);
        setContent('');
        loadedContentRef.current = '';

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        if (getPreviewKind(file.name)) {
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          loadedContentRef.current = fileDiffNewString;
          setLoading(false);
          return;
        }

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectId, filePath);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        if (!active) return;
        setContent(data.content);
        loadedContentRef.current = data.content;
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        if (!active) return;
        setLoadError(message);
        setContent('');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    loadFileContent();
    return () => {
      active = false;
    };
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId]);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    // 读取失败的占位同样不可保存——缓冲区里没有文件内容。
    if (previewKind || isBinaryFile(fileName) || loadError) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectId, filePath, content);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      loadedContentRef.current = content;
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [content, filePath, fileProjectId, previewKind, fileName, loadError]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  // 缓冲内容与磁盘内容是否分叉（关闭前确认的依据）
  const isDirty = useCallback(
    () => !loadError && content !== loadedContentRef.current,
    [loadError, content],
  );

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    loadError,
    isDirty,
    isBinary,
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  };
};
