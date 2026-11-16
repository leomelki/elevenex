import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { actions } from '../database/schema/index.js';
/** Task-scoped, bounded action output discovery. Never exports command lines or logs. */
@Injectable()
export class TaskBrowserServers {
  private readonly cache = new Map<number, { at: number; ports: number[] }>();
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}
  async ports(taskId: number): Promise<number[]> {
    const cached = this.cache.get(taskId);
    if (cached && Date.now() - cached.at < 2000) return cached.ports;
    const rows = await this.db.select({ tail: sql<string>`substr(${actions.currentOutput}, -2048)` }).from(actions)
      .where(and(eq(actions.workspaceId, taskId), eq(actions.status, 'running'))).limit(32);
    const ports = new Set<number>();
    for (const row of rows) for (const match of row.tail.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):([0-9]{1,5})\b/g)) {
      const port = Number(match[1]); if (port > 0 && port <= 65535) ports.add(port);
    }
    const result = [...ports].slice(0, 32).sort((a, b) => a - b);
    this.cache.delete(taskId); this.cache.set(taskId, { at: Date.now(), ports: result });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}
