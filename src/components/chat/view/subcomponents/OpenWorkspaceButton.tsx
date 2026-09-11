import { AlignLeft } from 'lucide-react';

import { cn } from '../../../../lib/utils';

type OpenWorkspaceButtonProps = {
  projectPath?: string;
  className?: string;
};

export default function OpenWorkspaceButton({ projectPath, className }: OpenWorkspaceButtonProps) {
  const openFolder = window.qiuDesktopFs?.openFolder;

  // 纯浏览器模式没有桌面壳桥接，打不开本地资源管理器，按钮不渲染
  if (typeof openFolder !== 'function' || !projectPath) {
    return null;
  }

  const handleOpen = async () => {
    try {
      const error = await openFolder(projectPath);
      if (error) {
        window.alert(`打开目录失败：${error}`);
      }
    } catch (err) {
      window.alert(`打开目录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void handleOpen();
      }}
      aria-label="查看文件"
      title="查看文件"
      className={cn(
        'flex items-center justify-center rounded text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      <AlignLeft className="h-3 w-3" />
    </button>
  );
}
