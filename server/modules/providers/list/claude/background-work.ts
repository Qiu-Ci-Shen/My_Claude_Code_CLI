/**
 * Background-work lifecycle tracker for the Claude provider's post-turn hold.
 *
 * A turn that backgrounds work (Bash run_in_background, Monitor, scheduled
 * wake-ups) keeps its CLI process held open after the turn's `result` so the
 * work can report back in a follow-up turn (see claude-runtime.provider.js).
 * The hold normally ends when that follow-up lands. Work that is instead
 * *stopped* before it ever reports (TaskStop) never pushes one — without this
 * tracker the process stays held and the client's "Background task running"
 * indicator lingers until the ceiling, forcing a manual interrupt.
 *
 * The tracker consumes each raw SDK stream message: tool_use blocks start
 * work (or request a stop), the Bash start's tool_result reveals the task id,
 * and a successful TaskStop result retires that id.
 */

// Tool calls that leave work running past the end of a turn. Bash only counts
// when it is explicitly backgrounded; the rest defer or watch work by nature.
// TaskCreate deliberately NOT included (2026-09-11): plain todo lists do not
// outlive their turn — counting them held the process open with nothing to
// wait for and stuck the "Background task running" indicator until the ceiling.
const DEFERRED_WORK_TOOLS = new Set(['Monitor', 'ScheduleWakeup', 'CronCreate']);

// "Command running in background with ID: bf7qd9sfk. Output is being written …"
const BACKGROUND_TASK_ID_RE = /running in background with ID:\s*([A-Za-z0-9_-]+)/;
const TASK_STOPPED_RE = /Successfully stopped/i;

type ToolBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: { run_in_background?: unknown; task_id?: unknown } | null;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
};

export type BackgroundWorkTracker = {
  /** Feeds one raw SDK message; returns true when it starts background work. */
  track(message: unknown): boolean;
  /** True while any work started by this run may still be running. */
  hasLiveWork(): boolean;
};

export function createBackgroundWorkTracker(): BackgroundWorkTracker {
  // Bash background starts whose tool_result (carrying the task id) is still
  // pending; keyed by tool_use id so the result can be matched back.
  const startsAwaitingResult = new Set<string>();
  // TaskStop calls whose tool_result is still pending: tool_use id → task id.
  const stopRequests = new Map<string, string>();
  // Started background tasks no successful TaskStop has retired yet.
  const liveTaskIds = new Set<string>();
  // Background work with no stoppable task id (Monitor / wake-ups) or with an
  // unparseable start result — only its own follow-up report can end it.
  let untrackedCount = 0;

  const trackBlocks = (content: unknown): boolean => {
    if (!Array.isArray(content)) {
      return false;
    }
    let started = false;
    for (const rawBlock of content) {
      const block = rawBlock as ToolBlock | null;
      if (block?.type === 'tool_use') {
        if (block.name === 'Bash' && block.input?.run_in_background === true) {
          started = true;
          if (typeof block.id === 'string' && block.id) {
            startsAwaitingResult.add(block.id);
          } else {
            untrackedCount += 1;
          }
        } else if (typeof block.name === 'string' && DEFERRED_WORK_TOOLS.has(block.name)) {
          started = true;
          untrackedCount += 1;
        } else if (block.name === 'TaskStop') {
          const taskId = block.input?.task_id;
          if (typeof taskId === 'string' && taskId && typeof block.id === 'string' && block.id) {
            stopRequests.set(block.id, taskId);
          }
        }
      } else if (block?.type === 'tool_result') {
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (!toolUseId) {
          continue;
        }
        const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        if (startsAwaitingResult.has(toolUseId)) {
          startsAwaitingResult.delete(toolUseId);
          const idMatch = BACKGROUND_TASK_ID_RE.exec(text);
          if (idMatch) {
            liveTaskIds.add(idMatch[1]);
          } else if (block.is_error !== true) {
            // Started but the id could not be parsed — assume it is running
            // rather than releasing the hold and killing it early.
            untrackedCount += 1;
          }
        }
        const stopTaskId = stopRequests.get(toolUseId);
        if (stopTaskId !== undefined) {
          stopRequests.delete(toolUseId);
          if (TASK_STOPPED_RE.test(text)) {
            liveTaskIds.delete(stopTaskId);
          }
        }
      }
    }
    return started;
  };

  return {
    track(message: unknown): boolean {
      const content = (message as { message?: { content?: unknown } } | null)?.message?.content;
      return trackBlocks(content);
    },
    hasLiveWork(): boolean {
      return liveTaskIds.size > 0 || untrackedCount > 0 || startsAwaitingResult.size > 0;
    },
  };
}
