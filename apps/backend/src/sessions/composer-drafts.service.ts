import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

export interface ComposerDraftDto {
  sessionId: number;
  text: string;
  diffMentions: unknown[];
  sessionMentions: unknown[];
  images: unknown[];
  updatedAt: string;
}

export interface SaveComposerDraftDto {
  text?: string;
  diffMentions?: unknown[];
  sessionMentions?: unknown[];
  /**
   * Omit to leave the stored attachments untouched. Images are base64 data
   * URLs, so the composer only resends them when the attachment set actually
   * changes — every keystroke would otherwise push megabytes over the wire
   * (and over an SSH tunnel, for a remote workspace).
   */
  images?: unknown[];
}

/** Generous for a prompt; small enough that a runaway paste cannot bloat the db. */
const MAX_TEXT_LENGTH = 200_000;
const MAX_MENTIONS_JSON_LENGTH = 500_000;
/**
 * The composer accepts up to 20 MB of images, which is worth having in memory
 * for the message being written but not worth carrying in the drafts table for
 * every abandoned composer. Past this, the text is still saved and the
 * attachments are dropped.
 */
const MAX_IMAGES_JSON_LENGTH = 8 * 1024 * 1024;

@Injectable()
export class ComposerDraftsService {
  private readonly logger = new Logger(ComposerDraftsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  async find(sessionId: number): Promise<ComposerDraftDto | null> {
    await this.assertSessionExists(sessionId);

    const rows = await this.db
      .select()
      .from(schema.composerDrafts)
      .where(eq(schema.composerDrafts.sessionId, sessionId));

    return rows.length > 0 ? this.toDto(rows[0]) : null;
  }

  /**
   * Writes the whole draft. Returns the stored draft, or null when the composer
   * came back empty — an empty draft is no draft, so the row goes away rather
   * than lingering for every session the user ever opened.
   */
  async save(
    sessionId: number,
    dto: SaveComposerDraftDto,
  ): Promise<ComposerDraftDto | null> {
    await this.assertSessionExists(sessionId);

    const text = this.clampText(dto.text);
    const diffMentionsJson = this.serializeArray(
      dto.diffMentions,
      MAX_MENTIONS_JSON_LENGTH,
      'diff mentions',
    );
    const sessionMentionsJson = this.serializeArray(
      dto.sessionMentions,
      MAX_MENTIONS_JSON_LENGTH,
      'session mentions',
    );
    const imagesJson =
      dto.images === undefined
        ? null
        : this.serializeArray(dto.images, MAX_IMAGES_JSON_LENGTH, 'images');

    const existing = (
      await this.db
        .select()
        .from(schema.composerDrafts)
        .where(eq(schema.composerDrafts.sessionId, sessionId))
    )[0];

    // A patch that omits `images` keeps whatever is stored.
    const nextImagesJson = imagesJson ?? existing?.imagesJson ?? '[]';

    if (
      !text.trim() &&
      diffMentionsJson === '[]' &&
      sessionMentionsJson === '[]' &&
      nextImagesJson === '[]'
    ) {
      await this.delete(sessionId);
      return null;
    }

    const row = {
      sessionId,
      text,
      diffMentionsJson,
      sessionMentionsJson,
      imagesJson: nextImagesJson,
      updatedAt: new Date().toISOString(),
    };

    const [saved] = await this.db
      .insert(schema.composerDrafts)
      .values(row)
      .onConflictDoUpdate({
        target: schema.composerDrafts.sessionId,
        set: {
          text: row.text,
          diffMentionsJson: row.diffMentionsJson,
          sessionMentionsJson: row.sessionMentionsJson,
          imagesJson: row.imagesJson,
          updatedAt: row.updatedAt,
        },
      })
      .returning();

    return this.toDto(saved);
  }

  async delete(sessionId: number): Promise<void> {
    await this.db
      .delete(schema.composerDrafts)
      .where(eq(schema.composerDrafts.sessionId, sessionId));
  }

  /**
   * Guards against writing a draft for a session id this database knows nothing
   * about — the exact failure the server-side store exists to prevent. Kept to
   * a single indexed lookup because a save runs on every composer pause.
   */
  private async assertSessionExists(sessionId: number): Promise<void> {
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      throw new NotFoundException(`Session with id ${sessionId} not found`);
    }

    const rows = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));

    if (rows.length === 0) {
      throw new NotFoundException(`Session with id ${sessionId} not found`);
    }
  }

  private clampText(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : '';
  }

  private serializeArray(
    value: unknown,
    maxLength: number,
    label: string,
  ): string {
    if (!Array.isArray(value) || value.length === 0) {
      return '[]';
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      this.logger.warn(`Dropping unserializable composer draft ${label}.`);
      return '[]';
    }

    if (serialized.length > maxLength) {
      this.logger.warn(
        `Dropping composer draft ${label}: ${serialized.length} bytes exceeds the ${maxLength} byte limit.`,
      );
      return '[]';
    }

    return serialized;
  }

  private toDto(row: typeof schema.composerDrafts.$inferSelect): ComposerDraftDto {
    return {
      sessionId: row.sessionId,
      text: row.text,
      diffMentions: this.parseArray(row.diffMentionsJson),
      sessionMentions: this.parseArray(row.sessionMentionsJson),
      images: this.parseArray(row.imagesJson),
      updatedAt: row.updatedAt,
    };
  }

  private parseArray(json: string): unknown[] {
    try {
      const parsed: unknown = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
