import { useState } from 'react';
import { Download, FileJson, FileText, Loader2 } from 'lucide-react';

import type { ChatMessage } from '../../types/types';
import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import {
  downloadMarkdown,
  downloadHTML,
  downloadPDF,
  EXPORT_FORMATS,
  fetchFullSessionMessages,
} from '../../utils/chatExport';

type ChatExportMenuProps = {
  messages: ChatMessage[];
  sessionTitle?: string;
  /** 传入时会话历史只加载了部分窗口——导出前自动从服务端拉全量转录 */
  sessionId?: string | null;
  provider?: string;
  hasMoreMessages?: boolean;
};

export default function ChatExportMenu({
  messages,
  sessionTitle,
  sessionId,
  provider = 'claude',
  hasMoreMessages = false,
}: ChatExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  if (messages.length === 0) {
    return null;
  }

  const handleExport = async (format: 'markdown' | 'html' | 'pdf') => {
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${sessionTitle || 'chat'}-${timestamp}`;
    const safeSessionId = sessionId;

    setExporting(true);
    try {
      // 界面只加载消息尾部窗口；hasMore 时先从服务端拉完整转录再导出，
      // 否则长会话的导出会静默丢掉更早的对话。
      let exportSource = messages;
      if (safeSessionId && hasMoreMessages) {
        const raw = await fetchFullSessionMessages(safeSessionId, provider);
        exportSource = normalizedToChatMessages(raw as never[]);
      }

      switch (format) {
        case 'markdown':
          downloadMarkdown(exportSource, `${filename}.md`, sessionTitle);
          break;
        case 'html':
          downloadHTML(exportSource, `${filename}.html`, sessionTitle);
          break;
        case 'pdf':
          downloadPDF(exportSource, filename, sessionTitle);
          break;
      }
    } catch (error) {
      window.alert(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setExporting(false);
      setIsOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={exporting}
        aria-label="Export chat"
        title="导出会话记录（自动包含未加载的历史）"
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-border/50 text-muted-foreground transition-all hover:bg-accent hover:text-foreground disabled:opacity-60"
      >
        {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </button>

      {isOpen && !exporting && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-lg border border-border/50 bg-card shadow-lg">
          <div className="p-2">
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              {hasMoreMessages ? '将自动获取完整历史，导出为：' : 'Export as:'}
            </div>
            {EXPORT_FORMATS.map((fmt) => (
              <button
                key={fmt.id}
                type="button"
                onClick={() => void handleExport(fmt.id as 'markdown' | 'html' | 'pdf')}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
              >
                {fmt.id === 'markdown' ? (
                  <FileText className="h-4 w-4" />
                ) : (
                  <FileJson className="h-4 w-4" />
                )}
                <span>{fmt.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {isOpen && (
        <div className="fixed inset-0" onClick={() => setIsOpen(false)} />
      )}
    </div>
  );
}
