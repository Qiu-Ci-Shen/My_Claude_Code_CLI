/** Agents 面板展示格式化小工具 */

export function formatTokens(tokens: number | null | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M tok`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k tok`;
  }
  return `${tokens} tok`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return '';
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h${remainMinutes}m` : `${hours}h`;
}

/** 运行中条目的已耗时（startedAt → now/endedAt） */
export function elapsedSince(startedAt: string | null, endedAt: string | null, now: number): number {
  if (!startedAt) {
    return 0;
  }
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) {
    return 0;
  }
  const end = endedAt ? Date.parse(endedAt) : now;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'NotebookEdit']);

/** 工具调用一行的紧凑参数摘要（与主聊天子代理容器的观感一致） */
export function compactToolArg(toolName: string, toolInput: unknown): string {
  const input = (typeof toolInput === 'string'
    ? (() => {
        try {
          return JSON.parse(toolInput) as Record<string, unknown>;
        } catch {
          return {} as Record<string, unknown>;
        }
      })()
    : (toolInput || {})) as Record<string, unknown>;

  if (FILE_TOOLS.has(toolName)) {
    const filePath = String(input.file_path ?? '');
    return filePath.split(/[\\/]/).pop() || filePath;
  }
  switch (toolName) {
    case 'Bash': {
      const command = String(input.command ?? '').replace(/\s+/g, ' ');
      return command.length > 64 ? `${command.slice(0, 64)}…` : command;
    }
    case 'Grep':
    case 'Glob':
      return String(input.pattern ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'Agent':
    case 'Task':
      return String(input.description ?? input.subagent_type ?? '');
    default:
      return '';
  }
}
