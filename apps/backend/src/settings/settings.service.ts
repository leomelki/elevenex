import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  AppSettings,
  CLAUDE_SESSION_SURFACES,
  DEFAULT_CLAUDE_SESSION_SURFACE,
  DefaultClaudeSessionSurface,
} from './settings.types.js';

const SINGLETON_SETTINGS_ID = 1;

@Injectable()
export class SettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async findOne(): Promise<AppSettings> {
    const rows = await this.db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.id, SINGLETON_SETTINGS_ID))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return {
        defaultClaudeSessionSurface: DEFAULT_CLAUDE_SESSION_SURFACE,
        createdAt: null,
        updatedAt: null,
      };
    }

    return this.toResponse(row);
  }

  async update(
    defaultClaudeSessionSurface: DefaultClaudeSessionSurface,
  ): Promise<AppSettings> {
    if (!CLAUDE_SESSION_SURFACES.includes(defaultClaudeSessionSurface)) {
      throw new BadRequestException('Unsupported Claude session surface.');
    }

    const timestamp = new Date().toISOString();

    await this.db
      .insert(schema.appSettings)
      .values({
        id: SINGLETON_SETTINGS_ID,
        defaultClaudeSessionSurface,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [schema.appSettings.id],
        set: {
          defaultClaudeSessionSurface,
          updatedAt: timestamp,
        },
      });

    return this.findOne();
  }

  private toResponse(row: typeof schema.appSettings.$inferSelect): AppSettings {
    const defaultClaudeSessionSurface = CLAUDE_SESSION_SURFACES.includes(
      row.defaultClaudeSessionSurface as DefaultClaudeSessionSurface,
    )
      ? (row.defaultClaudeSessionSurface as DefaultClaudeSessionSurface)
      : DEFAULT_CLAUDE_SESSION_SURFACE;

    return {
      defaultClaudeSessionSurface,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
