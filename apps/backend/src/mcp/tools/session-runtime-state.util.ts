/**
 * Shared "is this session really done" check for the observe/drive tools that
 * wait on session completion (`session_status`, `prompt_session`,
 * `poll_session_status`, `await_session_event`).
 *
 * `sessionState`/`runPhase` go idle as soon as the *visible* turn ends, but a
 * `run_in_background` subagent/task or a prompt queued behind one keeps the
 * runtime busy and WILL produce more output (the SDK autonomously resumes to
 * report back, or the queued prompt starts running once it drains) — see
 * `claude-runtime.service.ts`'s "Background work registry" section. Only
 * `pendingPrompts` is populated for every provider; `backgroundWork` is a
 * Claude-only signal and absent elsewhere, so both are optional here.
 */
export interface SessionRuntimeSnapshot {
  sessionState?: string | null;
  runPhase?: string | null;
  backgroundWork?: unknown[] | null;
  pendingPrompts?: unknown[] | null;
}

/** True when the runtime still has work queued that will resume the session on its own. */
export function hasQueuedWork(
  state: SessionRuntimeSnapshot | null | undefined,
): boolean {
  if (!state) return false;
  return (
    (state.backgroundWork?.length ?? 0) > 0 ||
    (state.pendingPrompts?.length ?? 0) > 0
  );
}

/**
 * True only when the session is idle AND has nothing left that will resume it
 * automatically. Callers that treat `sessionState === 'idle' && runPhase ===
 * 'idle'` alone as "completed" will report a session done while it still has
 * a background task or a queued message about to run.
 */
export function isSessionSettled(
  state: SessionRuntimeSnapshot | null | undefined,
): boolean {
  if (!state) return false;
  return (
    state.sessionState === 'idle' &&
    state.runPhase === 'idle' &&
    !hasQueuedWork(state)
  );
}
