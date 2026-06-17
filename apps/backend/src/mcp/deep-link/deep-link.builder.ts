import { Injectable } from '@nestjs/common';

/**
 * Builds ready-to-open elevenex URLs so every tool result can hand the agent
 * (and, through it, the human) a one-click jump to what it touched. The agent
 * never rebuilds these by hand.
 *
 * Paths mirror the frontend router. Today's routes are coarse
 * (`/projects/:id`, `/sessions/:id`); finer panel/PR/diff deep links land with
 * the agent-panel UX milestone and extend this builder, not the call sites.
 */
@Injectable()
export class DeepLinkBuilder {
  project(projectId: number): string {
    return `/projects/${projectId}`;
  }

  session(sessionId: number, opts?: { panel?: 'transcript' | 'changes' | 'terminal' }): string {
    const base = `/sessions/${sessionId}`;
    return opts?.panel ? `${base}?panel=${opts.panel}` : base;
  }

  /** Session opened on its change-review diff (optionally a specific file). */
  changeReview(sessionId: number, file?: string): string {
    const base = `/sessions/${sessionId}?panel=changes`;
    return file ? `${base}&file=${encodeURIComponent(file)}` : base;
  }
}
