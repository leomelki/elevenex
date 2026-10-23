import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  HttpException,
  NotFoundException,
  Patch,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FilesService } from './files.service.js';
import * as path from 'node:path';
import { GetPathSuggestionsDto } from './dto/get-path-suggestions.dto.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { eq } from 'drizzle-orm';
import * as schema from '../database/schema/index.js';

type RenameRequest = {
  newPath: string;
  overwrite?: boolean;
};

function joinWildcardPath(value: string | string[]): string {
  // Express already decodes route and query parameters, including wildcard
  // segments. Only join the wildcard array; literal percent escapes are names.
  return Array.isArray(value) ? value.join('/') : value;
}

function toBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === 'true';
}

function toArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Array.isArray(value) ? value : [value];
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
    // A cached editor may outlive its task or the checkout assigned to it.
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
        'This editor belongs to an inactive task. Reopen the task before saving files.',
      );
    }
  }

  @Get(':worktreePath/stat')
  async statRoot(
    @Param('worktreePath') worktreePath: string,
    @Query('path') targetPath?: string,
  ) {
    const absolutePath = targetPath
      ? path.join(worktreePath, targetPath)
      : worktreePath;
    return this.filesService.stat(absolutePath, worktreePath);
  }

  @Get(':worktreePath/stat/*path')
  async statPath(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string | string[],
  ) {
    const decodedFile = joinWildcardPath(filePath);
    const absolutePath = path.join(worktreePath, decodedFile);
    return this.filesService.stat(absolutePath, worktreePath);
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
  ) {
    return this.filesService.listFiles(worktreePath, dir ?? '');
  }

  @Get(':worktreePath/file-search')
  async searchFiles(
    @Param('worktreePath') worktreePath: string,
    @Query('query') query?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return this.filesService.searchFiles(
      worktreePath,
      query ?? '',
      parsedLimit,
    );
  }

  /**
   * Streaming counterpart of `text-search`, emitting NDJSON lines
   * (`{"type":"results",...}` / `{"type":"done",...}` / `{"type":"error",...}`)
   * so the editor can render matches while ripgrep is still running.
   *
   * Headers are flushed lazily: until the first line is written we can still
   * fail with a normal HTTP status code.
   */
  @Get(':worktreePath/text-search/stream')
  async streamSearchText(
    @Res() res: Response,
    @Param('worktreePath') worktreePath: string,
    @Query('query') query?: string,
    @Query('isRegExp') isRegExp?: string,
    @Query('isCaseSensitive') isCaseSensitive?: string,
    @Query('isWordMatch') isWordMatch?: string,
    @Query('include') include?: string | string[],
    @Query('exclude') exclude?: string | string[],
    @Query('useIgnoreFiles') useIgnoreFiles?: string,
    @Query('maxResults') maxResults?: string,
  ): Promise<void> {
    const parsedMaxResults =
      maxResults === undefined ? undefined : Number(maxResults);

    const abortController = new AbortController();
    // The client disconnecting (VS Code cancelling a superseded search) must
    // stop ripgrep instead of letting it run to completion unobserved.
    res.on('close', () => abortController.abort());

    let headersSent = false;
    const ensureHeaders = (): void => {
      if (headersSent) {
        return;
      }
      headersSent = true;
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      // Defeat proxy buffering so batches are not held back.
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.socket?.setNoDelay(true);
    };

    const writeLine = (payload: unknown): void => {
      ensureHeaders();
      res.write(`${JSON.stringify(payload)}\n`);
    };

    try {
      const summary = await this.filesService.searchTextStream(
        worktreePath,
        {
          query: query ?? '',
          isRegExp: toBoolean(isRegExp),
          isCaseSensitive: toBoolean(isCaseSensitive),
          isWordMatch: toBoolean(isWordMatch),
          includes: toArray(include),
          excludes: toArray(exclude),
          useIgnoreFiles: toBoolean(useIgnoreFiles),
          maxResults: parsedMaxResults,
        },
        (results) => writeLine({ type: 'results', results }),
        abortController.signal,
      );

      if (res.writableEnded) {
        return;
      }

      writeLine({ type: 'done', limitHit: summary.limitHit });
      res.end();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Text search failed';

      if (res.writableEnded) {
        return;
      }

      if (!headersSent) {
        const status = error instanceof HttpException ? error.getStatus() : 500;
        res.status(status).json({ statusCode: status, message });
        return;
      }

      // The failure is often the socket itself; never let reporting it throw
      // back into Nest, which would try to respond on a dead connection.
      try {
        writeLine({ type: 'error', message });
        res.end();
      } catch {
        res.destroy();
      }
    }
  }

  @Get(':worktreePath/text-search')
  async searchText(
    @Param('worktreePath') worktreePath: string,
    @Query('query') query?: string,
    @Query('isRegExp') isRegExp?: string,
    @Query('isCaseSensitive') isCaseSensitive?: string,
    @Query('isWordMatch') isWordMatch?: string,
    @Query('include') include?: string | string[],
    @Query('exclude') exclude?: string | string[],
    @Query('useIgnoreFiles') useIgnoreFiles?: string,
    @Query('maxResults') maxResults?: string,
  ) {
    const parsedMaxResults =
      maxResults === undefined ? undefined : Number(maxResults);

    return this.filesService.searchText(worktreePath, {
      query: query ?? '',
      isRegExp: toBoolean(isRegExp),
      isCaseSensitive: toBoolean(isCaseSensitive),
      isWordMatch: toBoolean(isWordMatch),
      includes: toArray(include),
      excludes: toArray(exclude),
      useIgnoreFiles: toBoolean(useIgnoreFiles),
      maxResults: parsedMaxResults,
    });
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
   * GET /worktrees/:worktreePath/raw/*path
   * Streams raw file bytes with Content-Type and byte-range support.
   * Used to embed local images and videos from chat markdown that the browser
   * can't read from disk directly.
   * worktreePath and filePath are URL-encoded.
   */
  @Get(':worktreePath/raw/*path')
  async readFileRaw(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string | string[],
    @Res({ passthrough: true }) res: Response,
    @Headers('range') range?: string,
  ): Promise<StreamableFile> {
    const decodedFile = joinWildcardPath(filePath);
    const absolutePath = path.join(worktreePath, decodedFile);

    try {
      const { stream, mimeType, length, statusCode, contentRange } =
        await this.filesService.readFileRaw(absolutePath, worktreePath, range);
      res.status(statusCode);
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      res.setHeader(
        'Cache-Control',
        /^(image|video)\//.test(mimeType) ? 'no-store' : 'private, max-age=60',
      );
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

  @Get(':worktreePath/file')
  async readFileByQuery(
    @Param('worktreePath') worktreePath: string,
    @Query('path') filePath: string,
  ) {
    const absolutePath = path.join(worktreePath, filePath);

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

  @Put(':worktreePath/file')
  async writeFileByQuery(
    @Param('worktreePath') worktreePath: string,
    @Query('path') filePath: string,
    @Body() body: { content: string },
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    await this.assertTaskWrite(worktreePath, taskId);
    const absolutePath = path.join(worktreePath, filePath);

    await this.filesService.writeFile(absolutePath, body.content, worktreePath);
    return { success: true };
  }

  /** Binary uploads bypass the JSON parser and its body-size limit. */
  @Put(':worktreePath/raw')
  async writeFileRaw(
    @Param('worktreePath') worktreePath: string,
    @Query('path') filePath: string,
    @Req() req: Request,
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    if (!req.is('application/octet-stream')) {
      throw new UnsupportedMediaTypeException(
        'Expected application/octet-stream',
      );
    }
    // Express already decodes route and query parameters. Preserve literal %.
    await this.assertTaskWrite(worktreePath, taskId);
    await this.filesService.writeFileStream(
      path.join(worktreePath, filePath ?? ''),
      req,
      worktreePath,
      // A long upload may outlive the task's assignment to this checkout.
      () => this.assertTaskWrite(worktreePath, taskId),
    );
    return { success: true };
  }

  @Post(':worktreePath/directories/*path')
  async createDirectory(
    @Param('worktreePath') worktreePath: string,
    @Param('path') dirPath: string | string[],
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    await this.assertTaskWrite(worktreePath, taskId);
    const decodedDir = joinWildcardPath(dirPath);
    const absolutePath = path.join(worktreePath, decodedDir);

    await this.filesService.createDirectory(absolutePath, worktreePath);
    return { success: true };
  }

  @Patch(':worktreePath/files/*path')
  async rename(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string | string[],
    @Body() body: RenameRequest,
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    await this.assertTaskWrite(worktreePath, taskId);
    const decodedFile = joinWildcardPath(filePath);
    const absoluteOldPath = path.join(worktreePath, decodedFile);
    const absoluteNewPath = path.join(worktreePath, body.newPath);

    await this.filesService.rename(
      absoluteOldPath,
      absoluteNewPath,
      worktreePath,
      body.overwrite ?? false,
    );

    return { success: true, path: body.newPath };
  }

  @Delete(':worktreePath/files/*path')
  async deleteEntry(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string | string[],
    @Query('recursive') recursive?: string,
    @Headers('x-elevenex-task-id') taskId?: string,
  ) {
    await this.assertTaskWrite(worktreePath, taskId);
    const decodedFile = joinWildcardPath(filePath);
    const absolutePath = path.join(worktreePath, decodedFile);

    await this.filesService.deleteEntry(
      absolutePath,
      worktreePath,
      recursive === 'true',
    );

    return { success: true };
  }
}
