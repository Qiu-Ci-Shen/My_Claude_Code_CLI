// Post-abort reload suppression. When a run is aborted, the CLI still flushes
// the (nearly complete) turn into its JSONL transcript on wind-down; the
// sessions watcher then broadcasts `session_upserted`, and external-source
// reloads would resurface the full output seconds after the user pressed
// stop. External reloads are therefore skipped for a short window after an
// abort. Normal-completion refetches don't consult this and stay untouched.
const ABORT_RELOAD_SUPPRESS_MS = 20_000;

const abortedAtBySession = new Map<string, number>();

/** Record that `sessionId`'s run was just aborted (arms the suppression window). */
export function markSessionAborted(sessionId: string): void {
  if (!sessionId) return;
  abortedAtBySession.set(sessionId, Date.now());
}

/** True while `sessionId` is inside the post-abort suppression window. */
export function isSessionAbortSuppressed(sessionId: string): boolean {
  const abortedAt = abortedAtBySession.get(sessionId);
  if (abortedAt === undefined) return false;
  if (Date.now() - abortedAt >= ABORT_RELOAD_SUPPRESS_MS) {
    abortedAtBySession.delete(sessionId);
    return false;
  }
  return true;
}
