import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Patch,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { FilesService } from './files.service.js';
import * as path from 'node:path';
import { GetPathSuggestionsDto } from './dto/get-path-suggestions.dto.js';

type RenameRequest = {
  newPath: string;
  overwrite?: boolean;
};

@Controller('filesystem')
export class FilesystemController {
  constructor(private readonly filesService: FilesService) {}

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
  constructor(private readonly filesService: FilesService) {}

  @Get(':worktreePath/stat')
  async statRoot(
    @Param('worktreePath') worktreePath: string,
    @Query('path') targetPath?: string,
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedTargetPath = targetPath ? decodeURIComponent(targetPath) : '';
    const absolutePath = decodedTargetPath
      ? path.join(decodedWorktree, decodedTargetPath)
      : decodedWorktree;
    return this.filesService.stat(absolutePath, decodedWorktree);
  }

  @Get(':worktreePath/stat/*path')
  async statPath(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string,
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absolutePath = path.join(decodedWorktree, decodedFile);
    return this.filesService.stat(absolutePath, decodedWorktree);
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
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedDir = dir ? decodeURIComponent(dir) : '';
    return this.filesService.listFiles(decodedWorktree, decodedDir);
  }

  /**
   * GET /worktrees/:worktreePath/files/*path
   * Returns file content and detected language.
   * worktreePath and filePath are URL-encoded.
   */
  @Get(':worktreePath/files/*path')
  async readFile(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string,
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absolutePath = path.join(decodedWorktree, decodedFile);

    try {
      return await this.filesService.readFile(absolutePath, decodedWorktree);
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
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absolutePath = path.join(decodedWorktree, decodedFile);

    try {
      return await this.filesService.readFile(absolutePath, decodedWorktree);
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
    @Param('path') filePath: string,
    @Body() body: { content: string },
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absolutePath = path.join(decodedWorktree, decodedFile);

    await this.filesService.writeFile(absolutePath, body.content, decodedWorktree);
    return { success: true };
  }

  @Put(':worktreePath/file')
  async writeFileByQuery(
    @Param('worktreePath') worktreePath: string,
    @Query('path') filePath: string,
    @Body() body: { content: string },
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absolutePath = path.join(decodedWorktree, decodedFile);

    await this.filesService.writeFile(absolutePath, body.content, decodedWorktree);
    return { success: true };
  }

  @Post(':worktreePath/directories/*path')
  async createDirectory(
    @Param('worktreePath') worktreePath: string,
    @Param('path') dirPath: string,
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedDir = decodeURIComponent(dirPath);
    const absolutePath = path.join(decodedWorktree, decodedDir);

    await this.filesService.createDirectory(absolutePath, decodedWorktree);
    return { success: true };
  }

  @Patch(':worktreePath/files/*path')
  async rename(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string,
    @Body() body: RenameRequest,
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absoluteOldPath = path.join(decodedWorktree, decodedFile);
    const absoluteNewPath = path.join(decodedWorktree, body.newPath);

    await this.filesService.rename(
      absoluteOldPath,
      absoluteNewPath,
      decodedWorktree,
      body.overwrite ?? false,
    );

    return { success: true, path: body.newPath };
  }

  @Delete(':worktreePath/files/*path')
  async deleteEntry(
    @Param('worktreePath') worktreePath: string,
    @Param('path') filePath: string,
    @Query('recursive') recursive?: string,
  ) {
    const decodedWorktree = decodeURIComponent(worktreePath);
    const decodedFile = decodeURIComponent(filePath);
    const absolutePath = path.join(decodedWorktree, decodedFile);

    await this.filesService.deleteEntry(
      absolutePath,
      decodedWorktree,
      recursive === 'true',
    );

    return { success: true };
  }
}
