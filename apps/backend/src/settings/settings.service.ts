import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import {
  AppSettings,
  CLAUDE_SESSION_SURFACES,
  DEFAULT_CLAUDE_SESSION_SURFACE,
  DefaultClaudeSessionSurface,
  SessionToolbarButtonSetting,
  UpdateAppSettingsInput,
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
        sessionToolbarButtons: null,
        createdAt: null,
        updatedAt: null,
      };
    }

    return this.toResponse(row);
  }

  async update(input: UpdateAppSettingsInput): Promise<AppSettings> {
    const current = await this.findOne();
    const defaultClaudeSessionSurface =
      input.defaultClaudeSessionSurface ?? current.defaultClaudeSessionSurface;
    this.assertDefaultClaudeSessionSurface(defaultClaudeSessionSurface);

    const hasToolbarButtons = Object.prototype.hasOwnProperty.call(
      input,
      'sessionToolbarButtons',
    );
    const sessionToolbarButtons = hasToolbarButtons
      ? this.normalizeSessionToolbarButtons(input.sessionToolbarButtons)
      : current.sessionToolbarButtons;

    const timestamp = new Date().toISOString();

    await this.db
      .insert(schema.appSettings)
      .values({
        id: SINGLETON_SETTINGS_ID,
        defaultClaudeSessionSurface,
        sessionToolbarButtons: this.serializeSessionToolbarButtons(
          sessionToolbarButtons,
        ),
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [schema.appSettings.id],
        set: {
          defaultClaudeSessionSurface,
          sessionToolbarButtons: this.serializeSessionToolbarButtons(
            sessionToolbarButtons,
          ),
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
      sessionToolbarButtons: this.parseSessionToolbarButtons(
        row.sessionToolbarButtons,
      ),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private assertDefaultClaudeSessionSurface(
    defaultClaudeSessionSurface: DefaultClaudeSessionSurface,
  ): void {
    if (!CLAUDE_SESSION_SURFACES.includes(defaultClaudeSessionSurface)) {
      throw new BadRequestException('Unsupported Claude session surface.');
    }
  }

  private normalizeSessionToolbarButtons(
    value: SessionToolbarButtonSetting[] | null | undefined,
  ): SessionToolbarButtonSetting[] | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (!Array.isArray(value)) {
      throw new BadRequestException('Unsupported session toolbar settings.');
    }

    return value.map((button) => {
      if (
        typeof button !== 'object' ||
        button === null ||
        typeof button.id !== 'string' ||
        typeof button.visible !== 'boolean'
      ) {
        throw new BadRequestException('Unsupported session toolbar settings.');
      }

      return {
        id: button.id,
        visible: button.visible,
      };
    });
  }

  private serializeSessionToolbarButtons(
    value: SessionToolbarButtonSetting[] | null,
  ): string | null {
    return value === null ? null : JSON.stringify(value);
  }

  private parseSessionToolbarButtons(
    value: string | null | undefined,
  ): SessionToolbarButtonSetting[] | null {
    if (!value) {
      return null;
    }

    try {
      return this.normalizeSessionToolbarButtons(JSON.parse(value));
    } catch {
      return null;
    }
  }
}
