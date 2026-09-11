export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    /** Electron 桌面壳桥接（preload.cjs 注入，纯浏览器模式不存在） */
    qiuDesktopFs?: {
      pickFolder?: () => Promise<string | null>;
      openFolder?: (dirPath: string) => Promise<string>;
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
