import { useEffect, useState } from 'react';
import {
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoIcon,
  PresentationIcon,
  XIcon,
} from 'lucide-react';

import { ImageLightbox } from './ChatMessageImages';

interface ComposerAttachmentProps {
  file: File;
  onRemove: () => void;
  uploadProgress?: number;
  error?: string;
}

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/** 按类型挑图标与配色，让不同文件一眼可辨 */
const getFileVisual = (file: File) => {
  const name = file.name.toLowerCase();
  const mimeType = file.type;
  if (mimeType.startsWith('audio/')) return { Icon: FileAudioIcon, className: 'text-pink-500' };
  if (mimeType.startsWith('video/')) return { Icon: FileVideoIcon, className: 'text-red-400' };
  if (mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(name)) {
    return { Icon: FileImageIcon, className: 'text-sky-500' };
  }
  if (/\.pdf$/.test(name)) return { Icon: FileTextIcon, className: 'text-red-500' };
  if (/\.(docx?|rtf|odt|pages)$/.test(name)) return { Icon: FileTextIcon, className: 'text-blue-500' };
  if (/\.(xlsx?|csv|ods|numbers)$/.test(name)) return { Icon: FileSpreadsheetIcon, className: 'text-green-600' };
  if (/\.(pptx?|odp|key)$/.test(name)) return { Icon: PresentationIcon, className: 'text-orange-500' };
  if (/\.(zip|rar|7z|tar|gz|bz2)$/.test(name)) return { Icon: FileArchiveIcon, className: 'text-amber-600' };
  if (/\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|css|html|json|ya?ml|sh|sql|xml|toml|ini)$/.test(name)) {
    return { Icon: FileCodeIcon, className: 'text-violet-500' };
  }
  if (mimeType.startsWith('text/') || /\.(md|txt|log)$/.test(name)) {
    return { Icon: FileTextIcon, className: 'text-muted-foreground' };
  }
  return { Icon: FileIcon, className: 'text-muted-foreground' };
};

const ComposerAttachment = ({ file, onRemove, uploadProgress, error }: ComposerAttachmentProps) => {
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const isImage = file.type.startsWith('image/');
  const isUploading = uploadProgress !== undefined && uploadProgress < 100;
  const { Icon, className: iconClassName } = getFileVisual(file);

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  // 图片走应用内大图；其余文件优先交给系统默认程序打开（桌面壳桥接），
  // 浏览器里 PDF 新标签页预览、其他类型触发下载
  const openFile = () => {
    if (isImage) {
      if (preview) setExpanded(true);
      return;
    }

    const filePath = window.qiuDesktopFs?.getPathForFile?.(file);
    if (filePath && window.qiuDesktopFs?.openFile) {
      void window.qiuDesktopFs.openFile(filePath);
      return;
    }

    const url = URL.createObjectURL(file);
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      window.open(url, '_blank', 'noopener');
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <div className="group/pill relative">
      <button
        type="button"
        onClick={openFile}
        title={`${file.name} · ${formatFileSize(file.size)}${error ? ` · ${error}` : ''}`}
        aria-label={`Open ${file.name}`}
        className={`flex h-7 max-w-[220px] items-center gap-1.5 rounded-lg border py-1 pl-1.5 pr-5 text-xs text-foreground transition-colors ${
          error
            ? 'border-red-500/60 bg-red-500/10'
            : 'border-border/50 bg-muted/60 hover:bg-muted'
        }`}
      >
        <Icon className={`h-4 w-4 shrink-0 ${iconClassName}`} aria-hidden />
        <span className="truncate">{file.name}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${file.name}`}
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 sm:opacity-0 sm:group-hover/pill:opacity-100"
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
      {isUploading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/70 text-[10px] font-medium text-foreground">
          {uploadProgress}%
        </div>
      )}
      {expanded && preview && (
        <ImageLightbox src={preview} alt={file.name} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
};

export default ComposerAttachment;
