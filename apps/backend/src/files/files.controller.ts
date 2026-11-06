import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { FilesService } from './files.service.js';
import * as path from 'node:path';
import { GetPathSuggestionsDto } from './dto/get-path-suggestions.dto.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema/index.js';

function joinWildcardPath(value: string | string[]): string {
  // Express already decodes route and query parameters, including wildcard
  // segments. Only join the wildcard array; literal percent escapes are names.
  return Array.isArray(value) ? value.join('/') : value;
}

@Controller('filesystem')
export class FilesystemController {
  constructor(private readonly filesService: FilesService) {}

  @Get('media')
  async readMedia(
    @Query('path') filePath: string,
    @Res({ passthrough: true }) res: Response,
    @Headers('range') range?: string,
  ): Promise<StreamableFile> {
    try {
      const { stream, mimeType, length, statusCode, contentRange } =
        await this.filesService.readLocalMedia(filePath ?? '', range);
      res.status(statusCode);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.once('close', () => stream.destroy());
      return new StreamableFile(stream, { type: mimeType, length });
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not exist')) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Get('path-suggestions')
  async suggestPaths(@Query() query: GetPathSuggestionsDto) {
    return this.filesService.suggestPaths(
      query.input ?? '',
      query.targetKind ?? 'either',
      query.preferredStartDirectory,
    );
  }
}

@Controller('worktrees')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  private async assertTaskWrite(worktreePath: string, taskId?: string) {
    // A file operation may outlive its task or the checkout assigned to it.
    if (!taskId) return;
    const id = Number(taskId);
    const task =
      Number.isSafeInteger(id) && id > 0
        ? (
            await this.db
              .select()
              .from(schema.workspaces)
              .where(eq(schema.workspaces.id, id))
              .limit(1)
          )[0]
        : undefined;
    if (
      !task ||
      task.archivedAt ||
      task.taskState !== 'ready' ||
      task.linkStatus !== 'linked' ||
      path.resolve(task.path) !== path.resolve(worktreePath)
    ) {
      throw new ConflictException(
        'This task is inactive. Reopen the task before saving files.',
      );
    }
  }

  /**
   * GET /worktrees/:worktreePath/files
   * Returns the file tree for a worktree (non-recursive, single level).
   * Optional ?dir=relative/path to list contents of a specific directory.
   * worktreePath is URL-encoded.
   */
  @Get(':worktreePath/files')
  async listFiles(
    @Param('worktreePath') worktreePath: string,
    @Query('dir') dir?: string,
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    await this.assertTaskWrite(worktreePath, taskId);
    return this.filesService.listFiles(worktreePath, dir ?? '');
  }

  /**
   * GET /worktrees/:worktreePath/files/*path
   * Returns file content and detected language.
   * worktreePath and filePath are URL-encoded.
   */
  @Get(':worktreePath/files/*path')
  async readFile(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string | string[],
  ) {
    const decodedFile = joinWildcardPath(filePath);
    const absolutePath = path.join(worktreePath, decodedFile);

    try {
      return await this.filesService.readFile(absolutePath, worktreePath);
    } catch (error) {
      if (error instanceof Error && error.message.includes('does not exist')) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  /**
   * PUT /worktrees/:worktreePath/files/*path
   * Writes content to a file within the worktree.
   * worktreePath and filePath are URL-encoded.
   */
  @Put(':worktreePath/files/*path')
  async writeFile(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string | string[],
    @Body() body: { content: string },
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    await this.assertTaskWrite(worktreePath, taskId);
    const decodedFile = joinWildcardPath(filePath);
    const absolutePath = path.join(worktreePath, decodedFile);

    await this.filesService.writeFile(absolutePath, body.content, worktreePath);
    return { success: true };
  }
}
