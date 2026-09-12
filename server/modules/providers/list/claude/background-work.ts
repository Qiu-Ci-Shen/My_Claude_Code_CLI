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
 * and a task is retired when either a successful TaskStop result OR a settled
 * task notification (`task_notification` completed/failed/stopped, or a
 * terminal `task_updated` patch) confirms it — a task killed outside the
 * TaskStop tool (e.g. `taskkill` from another shell, crash, natural exit)
 * only ever reports through those notifications (2026-09-12 实案：kill 掉的后台
 * 服务被永远视为"存活"，回合结束挂起指示器直到天顶兜底).
 *
 * 2026-09-12 二审：后台子代理（Agent 工具的 run_in_background）在此前完全不被
 * 入账——tool_use 块名不是 Bash，tool_result 也没有「running in background with
 * ID」文案。后果实案：回合结束误判「无后台工作」→ 释放 CLI stdin → 此后 Agents
 * 面板的「停止」控制请求被传输层静默丢弃，永远 8s 超时、子代理再也停不下来。
 * 入账信号 = task_started（is_backgrounded && !ambient；后台 Bash 与后端子代理
 * 通用），销账沿用 task_notification / task_updated 终态。
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
      // 任务落定通知销账：CLI 的任务系统对任何结束方式（自然完成/失败/被
      // TaskStop/被外部 kill）都会发 task_notification；task_updated 的终态
      // patch 是更早到达的等位信号。只认 TaskStop 会漏掉非工具途径的结束。
      const taskEvent = message as {
        type?: unknown;
        subtype?: unknown;
        task_id?: unknown;
        is_backgrounded?: unknown;
        ambient?: unknown;
        patch?: { status?: unknown } | null;
      } | null;
      let startedFromEvent = false;
      if (taskEvent?.type === 'system' && typeof taskEvent.task_id === 'string' && taskEvent.task_id) {
        if (taskEvent.subtype === 'task_started') {
          // 后台启动入账：事件型启动信号，与工具名无关（见文件头二审注释）。
          if (taskEvent.is_backgrounded === true && taskEvent.ambient !== true) {
            liveTaskIds.add(taskEvent.task_id);
            startedFromEvent = true;
          }
        } else if (taskEvent.subtype === 'task_notification') {
          liveTaskIds.delete(taskEvent.task_id);
        } else if (taskEvent.subtype === 'task_updated') {
          const patchStatus = taskEvent.patch?.status;
          if (patchStatus === 'completed' || patchStatus === 'failed' || patchStatus === 'killed') {
            liveTaskIds.delete(taskEvent.task_id);
          }
        }
      }

      const content = (message as { message?: { content?: unknown } } | null)?.message?.content;
      return trackBlocks(content) || startedFromEvent;
    },
    hasLiveWork(): boolean {
      return liveTaskIds.size > 0 || untrackedCount > 0 || startsAwaitingResult.size > 0;
    },
  };
}
