/**
 * Interrupted-turn registry for the Claude provider.
 *
 * An abort stops the CLI from *generating*, but the CLI still winds down
 * gracefully and flushes what it already generated — often the nearly complete
 * turn — into its JSONL transcript AFTER the abort instant. History is served
 * by re-parsing that transcript (claude-sessions.provider fetchHistory), so
 * without extra state the flushed output resurfaces on the next refresh even
 * though the user just interrupted the run.
 *
 * The runtime records the abort instant here (markAbortedTurn); fetchHistory
 * consults it via filterPostAbortTranscriptEntries, which drops transcript
 * entries written between the abort and the next real user message — exactly
 * the wind-down flush. Entries written before the abort stay: they are what
 * the user already saw live before pressing stop. The transcript file itself
 * is never modified — the CLI owns it, and resume still sees the full context.
 */

const abortedTurnsBySession = new Map<string, number[]>();

// Bounds for the in-memory registry. Losing old markers only re-exposes the
// flushed tail of long-forgotten interrupted turns — an acceptable trade for
// not growing without limit.
const MAX_TRACKED_SESSIONS = 200;
const MAX_TURNS_PER_SESSION = 20;

/** Records that `appSessionId`'s run was aborted at `abortedAtMs`. */
export function markAbortedTurn(appSessionId: string, abortedAtMs: number = Date.now()): void {
  if (!appSessionId) return;
  let turns = abortedTurnsBySession.get(appSessionId);
  if (!turns) {
    if (abortedTurnsBySession.size >= MAX_TRACKED_SESSIONS) {
      const oldest = abortedTurnsBySession.keys().next().value;
      if (oldest !== undefined) abortedTurnsBySession.delete(oldest);
    }
    turns = [];
    abortedTurnsBySession.set(appSessionId, turns);
  }
  turns.push(abortedAtMs);
  if (turns.length > MAX_TURNS_PER_SESSION) {
    turns.splice(0, turns.length - MAX_TURNS_PER_SESSION);
  }
}

/** All recorded abort instants for `appSessionId` (oldest first). */
export function getAbortedTurnTimestamps(appSessionId: string): number[] {
  return abortedTurnsBySession.get(appSessionId) ?? [];
}

/** Forgets every recorded abort for `appSessionId`. */
export function clearAbortedTurns(appSessionId: string): void {
  abortedTurnsBySession.delete(appSessionId);
}

type TranscriptEntry = {
  timestamp?: unknown;
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: unknown;
  [key: string]: unknown;
};

function entryTimestampMs(entry: TranscriptEntry): number | null {
  const raw = entry?.timestamp;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * A "real" user turn start: any user entry that is not a tool result. Tool
 * results also arrive as user-role entries with tool_result blocks, and the
 * CLI writes meta/sidechain bookkeeping rows — none of those start a turn.
 * Image-only prompts (content array without a text block) are real turns, so
 * the check must be "has no tool_result", not "has text" — a missed turn start
 * would make the pruner eat the next turn's content.
 */
function isRealUserTurnStart(entry: TranscriptEntry): boolean {
  if (!entry || entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) {
    return false;
  }
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const part of content) {
      if ((part as { type?: unknown })?.type === 'tool_result') return false;
    }
    return true;
  }
  return false;
}

/**
 * Drops transcript entries the CLI wrote during an aborted run's wind-down.
 *
 * For each recorded abort instant T: entries with timestamp > T are dropped up
 * to (not including) the first real user turn start after T — that boundary is
 * where a later turn begins and its content must be served untouched. Entries
 * dated at or before T, and undated entries, are always kept so the filter can
 * never eat pre-abort history it cannot attribute.
 */
export function filterPostAbortTranscriptEntries<T extends TranscriptEntry>(
  entries: T[],
  abortedAtMsList: number[],
): T[] {
  if (!Array.isArray(entries) || entries.length === 0 || abortedAtMsList.length === 0) {
    return entries;
  }

  const drop = new Set<number>();
  for (const marker of [...abortedAtMsList].sort((a, b) => a - b)) {
    let stopIndex = entries.length;
    for (let i = 0; i < entries.length; i++) {
      const ts = entryTimestampMs(entries[i]);
      if (ts !== null && ts > marker && isRealUserTurnStart(entries[i])) {
        stopIndex = i;
        break;
      }
    }
    for (let i = 0; i < stopIndex; i++) {
      if (drop.has(i)) continue;
      const ts = entryTimestampMs(entries[i]);
      if (ts === null || ts <= marker) continue;
      if (!isRealUserTurnStart(entries[i])) drop.add(i);
    }
  }

  if (drop.size === 0) return entries;
  return entries.filter((_, index) => !drop.has(index));
}
