import { Injectable } from '@nestjs/common';

/** A single focus snapshot: which code session the human had open in the UI. */
export interface AgentFocusRecord {
  /** The code session the user had focused in the UI when they last spoke. */
  focusedSessionId: number;
  /** ISO timestamp of when the snapshot was recorded (the user's last message). */
  reportedAt: string;
}

/**
 * Ephemeral, in-memory store of "what the human had open in the UI when they
 * last messaged a mission". Keyed by the mission's (agent session) id.
 *
 * This deliberately does NOT live in the conversation transcript. The UI used to
 * append an `<elevenex-session-context>` block to every message, which made the
 * focused session permanently salient and caused the agent to mis-attribute
 * follow-up instructions to whatever tab was open rather than the session the
 * conversation was about. Instead, focus is recorded out-of-band on each user
 * message and surfaced only on demand via the `get_focused_session` MCP tool, so
 * the agent pulls it when the user's words imply it and ignores it otherwise.
 *
 * Focus is volatile: it is overwritten on every user message and can differ
 * between two turns. Callers must treat each read as a point-in-time snapshot.
 */
@Injectable()
export class AgentFocusService {
  private readonly byMission = new Map<number, AgentFocusRecord>();

  /**
   * Record the focused code session for a mission as of the user's latest
   * message. A null/invalid `focusedSessionId` (no tab open) clears any prior
   * record so a stale focus is never reported.
   */
  record(
    missionSessionId: number,
    focusedSessionId: number | null | undefined,
  ): void {
    if (
      typeof focusedSessionId === 'number' &&
      Number.isInteger(focusedSessionId) &&
      focusedSessionId > 0
    ) {
      this.byMission.set(missionSessionId, {
        focusedSessionId,
        reportedAt: new Date().toISOString(),
      });
    } else {
      this.byMission.delete(missionSessionId);
    }
  }

  /** The latest focus snapshot for a mission, or null if none is known. */
  get(missionSessionId: number): AgentFocusRecord | null {
    return this.byMission.get(missionSessionId) ?? null;
  }

  /** Drop a mission's focus (e.g. when it is archived). */
  clear(missionSessionId: number): void {
    this.byMission.delete(missionSessionId);
  }
}
