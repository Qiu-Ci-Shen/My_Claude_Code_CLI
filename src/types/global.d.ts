export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    /** Electron 桌面壳桥接（preload.cjs 注入，纯浏览器模式不存在） */
    qiuDesktopFs?: {
      pickFolder?: () => Promise<string | null>;
      openFolder?: (dirPath: string) => Promise<string>;
      /** 浏览器 File 对象 → 本机磁盘路径；无磁盘来源（如剪贴板）返回空串 */
      getPathForFile?: (file: File) => string;
      /** 用系统默认程序打开文件；成功返回空串，失败返回错误描述 */
      openFile?: (filePath: string) => Promise<string>;
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
