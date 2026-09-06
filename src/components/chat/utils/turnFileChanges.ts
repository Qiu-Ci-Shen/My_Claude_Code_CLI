import type { ChatMessage } from '../types/types';

export type TurnFileDiff = { old_string: string; new_string: string };

export type TurnFileChange = {
  filePath: string;
  added: number;
  removed: number;
  /** 该文件在本回合内最后一次内容对——供审查用的编辑器 diff 视图 */
  lastDiff: TurnFileDiff | null;
};

export type TurnChanges = {
  files: TurnFileChange[];
  totalAdded: number;
  totalRemoved: number;
};

/** 会改动项目文件的内置工具（Bash 改文件无法可靠归因，不计入） */
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function countLines(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Edit 替换的增删行数 = diff 增量（与官方徽标一致）：剥掉 old/new 的公共前缀行与
 * 公共后缀行，剩下的才是真正增删的内容。给 100 行文件追加 1 行必须是 +1 -0，
 * 而不是 +101 -100。Edit 的 old/new 通常是连续块，前后缀剥离即等价于行级 diff。
 */
function diffLineCounts(oldString: unknown, newString: unknown): { added: number; removed: number } {
  const oldText = typeof oldString === 'string' ? oldString : '';
  const newText = typeof newString === 'string' ? newString : '';
  if (oldText.length === 0 && newText.length === 0) return { added: 0, removed: 0 };

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }
  const removed = oldText.length === 0 ? 0 : endOld - start + 1;
  const added = newText.length === 0 ? 0 : endNew - start + 1;
  return { added: Math.max(0, added), removed: Math.max(0, removed) };
}

/** toolInput 在消息流里可能是 JSON 字符串（转录）也可能是对象（实时流/子代理） */
function parseToolInput(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

type MutableTurnFileChange = {
  filePath: string;
  added: number;
  removed: number;
  lastDiff: TurnFileDiff | null;
};

/**
 * 按回合聚合文件更改（官方「N 个文件已更改」折叠条的数据源）。
 *
 * 回合 = 从一条用户消息到下一条用户消息之前。聚合本回合内 Edit/Write/MultiEdit/
 * NotebookEdit 的 tool_use（子代理容器内的同类子工具一并计入），失败的工具调用
 * （isError）不计。返回 Map：回合最后一条消息对象 → 该回合的更改统计——消息对象
 * 在 grouping/分页链路里保持引用一致，渲染层按对象命中折叠条的挂载点。
 */
export function collectTurnFileChanges(messages: ChatMessage[]): Map<ChatMessage, TurnChanges> {
  const result = new Map<ChatMessage, TurnChanges>();
  const byFile = new Map<string, MutableTurnFileChange>();
  let prev: ChatMessage | null = null;

  const changeFor = (filePath: string): MutableTurnFileChange => {
    let entry = byFile.get(filePath);
    if (!entry) {
      entry = { filePath, added: 0, removed: 0, lastDiff: null };
      byFile.set(filePath, entry);
    }
    return entry;
  };

  const applyEdit = (filePath: string, oldString: unknown, newString: unknown): void => {
    if (!filePath) return;
    const entry = changeFor(filePath);
    const counts = diffLineCounts(oldString, newString);
    entry.added += counts.added;
    entry.removed += counts.removed;
    entry.lastDiff = { old_string: String(oldString ?? ''), new_string: String(newString ?? '') };
  };

  const flush = (): void => {
    if (prev && byFile.size > 0) {
      const files = [...byFile.values()];
      result.set(prev, {
        files,
        totalAdded: files.reduce((sum, file) => sum + file.added, 0),
        totalRemoved: files.reduce((sum, file) => sum + file.removed, 0),
      });
    }
    byFile.clear();
  };

  const processToolMessage = (toolName: string | undefined, rawInput: unknown, isError: boolean): void => {
    if (!toolName || !FILE_EDIT_TOOLS.has(toolName) || isError) return;
    const input = parseToolInput(rawInput);
    if (!input) return;

    if (toolName === 'Edit') {
      applyEdit(String(input.file_path || ''), input.old_string, input.new_string);
      return;
    }
    if (toolName === 'MultiEdit') {
      const filePath = String(input.file_path || '');
      if (!filePath) return;
      const edits = Array.isArray(input.edits) ? input.edits : [];
      let added = 0;
      let removed = 0;
      let lastDiff: TurnFileDiff | null = null;
      for (const edit of edits) {
        const record = (edit ?? {}) as Record<string, unknown>;
        const counts = diffLineCounts(record.old_string, record.new_string);
        added += counts.added;
        removed += counts.removed;
        lastDiff = { old_string: String(record.old_string ?? ''), new_string: String(record.new_string ?? '') };
      }
      const entry = changeFor(filePath);
      entry.added += added;
      entry.removed += removed;
      if (lastDiff) entry.lastDiff = lastDiff;
      return;
    }
    if (toolName === 'Write') {
      // 全量写入：旧内容不可知，按“新增全文”计
      applyEdit(String(input.file_path || ''), '', input.content);
      return;
    }
    if (toolName === 'NotebookEdit') {
      const entry = changeFor(String(input.notebook_path || ''));
      entry.added += countLines(input.new_source);
      entry.lastDiff = null;
    }
  };

  for (const msg of messages) {
    if (msg.type === 'user') {
      flush();
      prev = msg;
      continue;
    }

    if (msg.isToolUse) {
      processToolMessage(
        msg.toolName,
        msg.toolInput,
        Boolean(msg.toolResult?.isError),
      );
      // 子代理容器：其内部同类子工具一并计入
      if (msg.isSubagentContainer && msg.subagentState?.childTools) {
        for (const child of msg.subagentState.childTools) {
          processToolMessage(child.toolName, child.toolInput, Boolean(child.toolResult?.isError));
        }
      }
    }

    prev = msg;
  }
  flush();

  return result;
}
