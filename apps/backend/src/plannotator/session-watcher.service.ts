import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileAsync } from '../terminal/async-process.js';

export interface PlannotatorSessionInfo {
  pid: number;
  port: number;
  url: string;
  mode: 'plan' | 'review' | 'annotate' | 'archive';
  project: string;
  startedAt: string;
  label: string;
}

export interface SessionMatchResult {
  plannotatorSession: PlannotatorSessionInfo;
  elevenexSessionId: number | null;
  worktreePath: string | null;
}

@Injectable()
export class PlannotatorSessionWatcher
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private sessionsDir: string;
  private interval: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private destroyed = false;
  private knownSessions: Map<number, PlannotatorSessionInfo> = new Map();
  private readonly sessionFiles = new Map<string, number>();
  private readonly logger = new Logger('PlannotatorSessionWatcher');

  private worktreeToSession: Map<string, number> = new Map();

  constructor() {
    super();
    this.sessionsDir = path.join(os.homedir(), '.plannotator', 'sessions');
  }

  onModuleInit() {
    this.startPolling();
  }

  onModuleDestroy() {
    this.destroyed = true;
    this.stopPolling();
  }

  registerWorktreeSession(worktreePath: string, sessionId: number): void {
    this.worktreeToSession.set(worktreePath, sessionId);
    this.logger.log(
      `[DEBUG] registerWorktreeSession: worktreePath="${worktreePath}", sessionId=${sessionId}, map size=${this.worktreeToSession.size}`,
    );
  }

  unregisterWorktreeSession(worktreePath: string): void {
    this.worktreeToSession.delete(worktreePath);
    this.logger.log(
      `[DEBUG] unregisterWorktreeSession: worktreePath="${worktreePath}", map size=${this.worktreeToSession.size}`,
    );
  }

  private startPolling(): void {
    if (this.destroyed || this.interval) return;
    void this.poll();
    this.interval = setInterval(() => void this.poll(), 500);
  }

  private stopPolling(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.destroyed || this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const entries = await fs
        .readdir(this.sessionsDir)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            return null;
          }
          throw error;
        });
      if (this.destroyed || !entries) return;

      const currentPids = new Set<number>();

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;

        const filePath = path.join(this.sessionsDir, entry);
        // A producer may truncate and rewrite its registration between polls.
        // Keep an existing session until this file disappears or proves dead.
        const previousPid = this.sessionFiles.get(entry);
        if (previousPid !== undefined) currentPids.add(previousPid);
        try {
          const contents = await fs.readFile(filePath, 'utf-8');
          if (this.destroyed) return;
          const data: unknown = JSON.parse(contents);
          if (!this.isSessionInfo(data)) continue;

          if (!this.isProcessAlive(data.pid)) {
            // Recheck contents before unlinking a registration the producer
            // may have replaced while we were checking its process.
            const latest = await fs.readFile(filePath, 'utf-8');
            if (this.destroyed) return;
            if (latest === contents && !this.isProcessAlive(data.pid)) {
              await fs.unlink(filePath).catch(() => undefined);
              if (this.destroyed) return;
              if (previousPid !== undefined) currentPids.delete(previousPid);
              this.sessionFiles.delete(entry);
            }
            continue;
          }

          currentPids.add(data.pid);

          if (!this.knownSessions.has(data.pid)) {
            const match = await this.matchToElevenexSession(data);
            if (this.destroyed) return;
            this.knownSessions.set(data.pid, data);
            this.emit('session-started', match);
            this.logger.log(
              `New plannotator session: pid=${data.pid}, port=${data.port}, mode=${data.mode}`,
            );
          } else {
            const existing = this.knownSessions.get(data.pid);
            if (existing && JSON.stringify(existing) !== JSON.stringify(data)) {
              this.knownSessions.set(data.pid, data);
            }
          }
          this.sessionFiles.set(entry, data.pid);
          if (previousPid !== undefined && previousPid !== data.pid) {
            currentPids.delete(previousPid);
          }
        } catch (err) {
          if (this.destroyed) return;
          this.logger.warn(`Failed to read session file ${entry}: ${err}`);
        }
      }

      if (this.destroyed) return;
      const presentFiles = new Set(entries);
      for (const entry of this.sessionFiles.keys()) {
        if (!presentFiles.has(entry)) this.sessionFiles.delete(entry);
      }
      for (const [pid, session] of this.knownSessions) {
        if (!currentPids.has(pid)) {
          this.knownSessions.delete(pid);
          this.emit('session-ended', { pid, port: session.port });
          this.logger.log(`Plannotator session ended: pid=${pid}`);
        }
      }
    } catch (error) {
      // Timer callbacks intentionally do not await poll(). Contain failures here
      // so unreadable directories cannot produce unhandled rejections.
      if (!this.destroyed)
        this.logger.warn(`Failed to poll sessions: ${error}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  private isSessionInfo(value: unknown): value is PlannotatorSessionInfo {
    if (!value || typeof value !== 'object') return false;
    const data = value as PlannotatorSessionInfo;
    return (
      Number.isSafeInteger(data.pid) &&
      data.pid > 0 &&
      Number.isInteger(data.port) &&
      data.port > 0 &&
      data.port <= 65535 &&
      ['plan', 'review', 'annotate', 'archive'].includes(data.mode) &&
      ['url', 'project', 'startedAt', 'label'].every(
        (key) => typeof (value as Record<string, unknown>)[key] === 'string',
      )
    );
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM (and unknown errors) do not prove that a process is dead.
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async getProcessCommandLine(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(
        'ps',
        ['eww', '-p', pid.toString(), '-o', 'command='],
        {
          maxBuffer: 1024 * 1024,
        },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async getProcessEnvVar(
    pid: number,
    varName: string,
  ): Promise<string | null> {
    try {
      const environ = await fs.readFile(`/proc/${pid}/environ`, 'utf-8');
      const vars = environ.split('\0');
      for (const v of vars) {
        if (v.startsWith(varName + '=')) {
          return v.substring(varName.length + 1);
        }
      }
    } catch {
      // /proc not available (macOS) or process not accessible
    }

    const commandLine = await this.getProcessCommandLine(pid);
    if (commandLine) {
      const match = commandLine.match(
        new RegExp(`(?:^|\\s)${varName}=([^\\s]+)`),
      );
      if (match?.[1]) {
        return match[1];
      }
    }

    return null;
  }

  private async matchToElevenexSession(
    plannotatorSession: PlannotatorSessionInfo,
  ): Promise<SessionMatchResult> {
    // Primary: read ELEVENEX_SESSION_ID directly from the plannotator process environment
    const sessionIdStr = await this.getProcessEnvVar(
      plannotatorSession.pid,
      'ELEVENEX_SESSION_ID',
    );
    if (sessionIdStr) {
      const sessionId = parseInt(sessionIdStr, 10);
      if (!isNaN(sessionId)) {
        for (const [worktreePath, sid] of this.worktreeToSession) {
          if (sid === sessionId) {
            this.logger.log(
              `Matched plannotator pid=${plannotatorSession.pid} to sessionId=${sessionId} via ELEVENEX_SESSION_ID env var`,
            );
            return {
              plannotatorSession,
              elevenexSessionId: sessionId,
              worktreePath,
            };
          }
        }
        // Session ID found but worktree not registered yet — still use the ID
        this.logger.log(
          `Matched plannotator pid=${plannotatorSession.pid} to sessionId=${sessionId} via env var (no worktree registered)`,
        );
        return {
          plannotatorSession,
          elevenexSessionId: sessionId,
          worktreePath: null,
        };
      }
    }

    this.logger.log(
      `No ELEVENEX_SESSION_ID env var found for plannotator pid=${plannotatorSession.pid}`,
    );
    return {
      plannotatorSession,
      elevenexSessionId: null,
      worktreePath: null,
    };
  }

  getActiveSessions(): PlannotatorSessionInfo[] {
    return Array.from(this.knownSessions.values()).sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );
  }

  getSessionByPort(port: number): PlannotatorSessionInfo | null {
    for (const session of this.knownSessions.values()) {
      if (session.port === port) {
        return session;
      }
    }
    return null;
  }

  getSessionByPid(pid: number): PlannotatorSessionInfo | null {
    return this.knownSessions.get(pid) || null;
  }

  terminateSessionByPort(port: number): boolean {
    const session = this.getSessionByPort(port);
    if (!session) {
      return false;
    }

    try {
      process.kill(session.pid, 'SIGTERM');
    } catch (error) {
      this.logger.warn(
        `Failed to terminate plannotator pid=${session.pid}: ${error}`,
      );
      return false;
    }

    setTimeout(() => {
      if (!this.isProcessAlive(session.pid)) {
        return;
      }

      try {
        process.kill(session.pid, 'SIGKILL');
      } catch {
        // Process already exited.
      }
    }, 5000);

    return true;
  }

  async getMatchingSessionId(port: number): Promise<number | null> {
    const session = this.getSessionByPort(port);
    if (!session) return null;

    const match = await this.matchToElevenexSession(session);
    return match.elevenexSessionId;
  }

  async getMatchByPort(port: number): Promise<SessionMatchResult | null> {
    const session = this.getSessionByPort(port);
    if (!session) {
      return null;
    }

    return this.matchToElevenexSession(session);
  }

  getMatchForSession(
    session: PlannotatorSessionInfo,
  ): Promise<SessionMatchResult> {
    return this.matchToElevenexSession(session);
  }
}
