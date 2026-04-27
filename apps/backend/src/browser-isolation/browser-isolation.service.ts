import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

@Injectable()
export class BrowserIsolationService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findOne(projectId: number) {
    const rows = await this.db
      .select()
      .from(schema.browserIsolationSettings)
      .where(eq(schema.browserIsolationSettings.projectId, projectId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { projectId, mode: 'shared', sharedGlobs: [] as string[] };
    }

    return {
      ...row,
      sharedGlobs: JSON.parse(row.sharedGlobs) as string[],
    };
  }

  async upsert(projectId: number, mode: string, sharedGlobs: string[]) {
    const timestamp = new Date().toISOString();
    const sharedGlobsJson = JSON.stringify(sharedGlobs);

    await this.db
      .insert(schema.browserIsolationSettings)
      .values({
        projectId,
        mode,
        sharedGlobs: sharedGlobsJson,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [schema.browserIsolationSettings.projectId],
        set: {
          mode,
          sharedGlobs: sharedGlobsJson,
          updatedAt: timestamp,
        },
      });

    return this.findOne(projectId);
  }
}
