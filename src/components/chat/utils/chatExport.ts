import type { ChatMessage } from '../types/types';
import { api } from '../../../utils/api';

export interface ExportOptions {
  includeMeta: boolean;
  format: 'markdown' | 'pdf' | 'docx';
}

/** 导出用消息体：角色 + 时间 + 已提炼的正文（工具调用折叠为单行说明） */
type ExportTurn = {
  role: 'user' | 'assistant' | 'error';
  timestamp?: string | number | Date;
  lines: string[];
};

/**
 * 从服务端拉取完整转录（分页直到取尽）——聊天界面只加载尾部窗口，
 * 直接导出已加载窗口会静默丢掉更早的对话。
 */
export async function fetchFullSessionMessages(
  sessionId: string,
  provider: string,
): Promise<unknown[]> {
  const all: unknown[] = [];
  const pageSize = 200;
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const response = await api.unifiedSessionMessages(sessionId, provider, {
      limit: pageSize,
      offset,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch session history: ${response.status}`);
    }
    const payload = await response.json().then((r) => r?.data ?? r);
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    all.push(...messages);
    hasMore = Boolean(payload?.hasMore) && messages.length > 0;
    offset += messages.length;
  }
  return all;
}

/** 工具调用提炼为一行人类可读说明（读/写文件、命令等） */
function describeToolUse(toolName: unknown, rawInput: unknown): string {
  const name = String(toolName || 'tool');
  let input: Record<string, unknown> | null = null;
  if (typeof rawInput === 'string') {
    try {
      const parsed = JSON.parse(rawInput);
      input = parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      input = null;
    }
  } else if (rawInput && typeof rawInput === 'object') {
    input = rawInput as Record<string, unknown>;
  }

  const file = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (file) {
    const target = String(file);
    const verb = name === 'Write' ? '写入' : name === 'MultiEdit' ? '多处编辑' : name === 'NotebookEdit' ? '编辑' : '编辑';
    return `🔧 ${name} → ${target}（${verb}）`;
  }
  if (typeof input?.command === 'string') {
    const command = input.command.length > 120 ? `${input.command.slice(0, 120)}…` : input.command;
    return `🔧 Bash → \`${command}\``;
  }
  if (typeof input?.url === 'string') {
    return `🔧 ${name} → ${input.url}`;
  }
  return `🔧 ${name}`;
}

/**
 * 把消息列表提炼为干净的导出回合：用户/AI 正文保留，工具调用折叠为单行，
 * 跳过工具结果回显与思考内容。
 */
export function buildExportTurns(messages: ChatMessage[]): ExportTurn[] {
  const turns: ExportTurn[] = [];
  const pushTurn = (role: ExportTurn['role'], timestamp: ExportTurn['timestamp'], line?: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role && last.timestamp === timestamp) {
      if (line) last.lines.push(line);
      return;
    }
    const turn: ExportTurn = { role, timestamp, lines: [] };
    if (line) turn.lines.push(line);
    turns.push(turn);
  };

  for (const msg of messages) {
    const ts = msg.timestamp;
    if (msg.type === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
      if (content.trim()) pushTurn('user', ts, content);
      continue;
    }
    if (msg.type === 'error') {
      pushTurn('error', ts, String(msg.content ?? ''));
      continue;
    }
    if (msg.isToolUse) {
      pushTurn('assistant', ts, describeToolUse(msg.toolName, msg.toolInput));
      continue;
    }
    if (msg.type === 'assistant' && msg.isThinking) continue;
    if (msg.type === 'assistant') {
      const content = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '');
      if (content.trim()) pushTurn('assistant', ts, content);
    }
  }
  return turns;
}

const ROLE_LABEL: Record<ExportTurn['role'], string> = {
  user: '🧑 用户',
  assistant: '🤖 Claude',
  error: '⚠️ 错误',
};

/**
 * Format a timestamp for display in exports.
 */
function formatTimestamp(date: Date | string | number): string {
  const d = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert messages to markdown format with proper styling and structure.
 */
export function exportToMarkdown(
  messages: ChatMessage[],
  sessionTitle?: string,
  options: Partial<ExportOptions> = {},
): string {
  const includeMeta = options.includeMeta ?? true;
  const turns = buildExportTurns(messages);

  let markdown = '';

  // Header
  if (includeMeta) {
    markdown += `# ${sessionTitle || '会话导出'}\n\n`;
    markdown += `> 导出时间：${formatTimestamp(new Date())} · 共 ${turns.length} 个发言回合\n\n`;
    markdown += `---\n\n`;
  }

  for (const turn of turns) {
    markdown += `## ${ROLE_LABEL[turn.role]}\n\n`;
    markdown += `${turn.lines.join('\n\n')}\n\n`;
    if (includeMeta && turn.timestamp) {
      markdown += `<small>${formatTimestamp(turn.timestamp)}</small>\n\n`;
    }
    markdown += '---\n\n';
  }

  return markdown;
}

/**
 * Export messages to a downloadable markdown file.
 */
export function downloadMarkdown(
  messages: ChatMessage[],
  filename: string = 'chat-export.md',
  sessionTitle?: string,
): void {
  const content = exportToMarkdown(messages, sessionTitle);
  const blob = new Blob([content], { type: 'text/markdown' });
  downloadBlob(blob, filename);
}

/**
 * Export messages to HTML (for PDF conversion or viewing).
 */
export function exportToHTML(
  messages: ChatMessage[],
  sessionTitle?: string,
  options: Partial<ExportOptions> = {},
): string {
  const includeMeta = options.includeMeta ?? true;
  const turns = buildExportTurns(messages);

  const htmlContent = turns
    .map((turn) => {
      const time = includeMeta && turn.timestamp ? `<p style="font-size: 12px; color: #999; margin-top: 8px;">${formatTimestamp(turn.timestamp)}</p>` : '';
      const background = turn.role === 'user' ? '#e3f2fd' : turn.role === 'error' ? '#fdecea' : '#f5f5f5';
      const body = turn.lines
        .map((line) => `<p style="margin: 0 0 10px 0; white-space: pre-wrap; word-wrap: break-word; color: #555; font-size: 14px; line-height: 1.6;">${escapeHTML(line)}</p>`)
        .join('');

      return `
        <div style="margin-bottom: 24px; padding: 16px; border-radius: 8px; background-color: ${background};">
          <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #333;">${ROLE_LABEL[turn.role]}</h3>
          ${body}
          ${time}
        </div>
      `;
    })
    .join('');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${escapeHTML(sessionTitle || '会话导出')}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 24px;
            background-color: #fafafa;
            color: #333;
          }
          h1 { margin: 0 0 8px 0; }
          .meta { color: #999; font-size: 13px; margin-bottom: 24px; }
          .divider { border-top: 1px solid #ddd; margin: 24px 0; }
        </style>
      </head>
      <body>
        <h1>${escapeHTML(sessionTitle || '会话导出')}</h1>
        <div class="meta">导出时间 ${formatTimestamp(new Date())}</div>
        <div class="divider"></div>
        ${htmlContent}
      </body>
    </html>
  `;
}

/**
 * Export to PDF by converting HTML via external service (requires html2pdf library or server).
 * For now, we'll generate a downloadable HTML that can be printed to PDF.
 */
export function downloadHTML(
  messages: ChatMessage[],
  filename: string = 'chat-export.html',
  sessionTitle?: string,
): void {
  const content = exportToHTML(messages, sessionTitle);
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' });
  downloadBlob(blob, filename);
}

/**
 * Create a DOCX file (simplified; full implementation requires docx library).
 * For now, returns HTML that can be opened in Word.
 */
export function downloadWord(
  messages: ChatMessage[],
  _filename: string = 'chat-export.html',
  sessionTitle?: string,
): void {
  // Fallback to HTML export since generating true DOCX requires additional library
  downloadHTML(messages, 'chat-export.html', sessionTitle);
}

/**
 * Download PDF using the browser's print dialog.
 */
export function downloadPDF(
  messages: ChatMessage[],
  _filename: string = 'chat-export',
  sessionTitle?: string,
): void {
  const htmlContent = exportToHTML(messages, sessionTitle);
  const win = window.open('', '', 'width=800,height=600');
  if (!win) {
    window.alert('PDF export could not start because the browser blocked the popup. Allow popups and try again.');
    return;
  }

  win.document.write(htmlContent);
  win.document.close();
  // Delay print dialog to ensure content is loaded
  setTimeout(() => {
    win.print();
    // Optionally close after printing
    // win.close();
  }, 250);
}

/**
 * Helper to download a blob as a file.
 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Get all export formats available.
 */
export const EXPORT_FORMATS = [
  { id: 'markdown', label: 'Markdown (.md)', ext: '.md' },
  { id: 'html', label: 'Web Page (.html)', ext: '.html' },
  { id: 'pdf', label: 'PDF (Print to File)', ext: '.pdf' },
] as const;
