import { Controller, Get, Post, Body, Query, Logger } from '@nestjs/common';
import {
  GitService,
  FileStatus,
  CommitInfo,
  CommitMessageSuggestion,
  GitStatusSummary,
  CommitResult,
} from './git.service.js';

@Controller('git')
export class GitController {
  private readonly logger = new Logger(GitController.name);

  constructor(private readonly gitService: GitService) {}

  @Get('status')
  async getStatus(
    @Query('worktreePath') worktreePath: string,
  ): Promise<FileStatus[]> {
    return this.gitService.getStatus(decodeURIComponent(worktreePath));
  }

  @Get('summary')
  async getSummary(
    @Query('worktreePath') worktreePath: string,
  ): Promise<GitStatusSummary> {
    return this.gitService.getStatusSummary(decodeURIComponent(worktreePath));
  }

  @Post('stage')
  async stageFiles(
    @Body() body: { worktreePath: string; files: string[] },
  ): Promise<void> {
    return this.gitService.stageFiles(
      decodeURIComponent(body.worktreePath),
      body.files,
    );
  }

  @Post('unstage')
  async unstageFiles(
    @Body() body: { worktreePath: string; files: string[] },
  ): Promise<void> {
    return this.gitService.unstageFiles(
      decodeURIComponent(body.worktreePath),
      body.files,
    );
  }

  @Post('commit')
  async commit(
    @Body()
    body: {
      worktreePath: string;
      message?: string;
      includeUnstaged?: boolean;
    },
  ): Promise<CommitResult> {
    const worktreePath = decodeURIComponent(body.worktreePath);
    const requestId = this.createRequestId();
    const message = body.message ?? '';
    this.logger.log(
      `[commit:${requestId}] request received worktreePath="${worktreePath}" includeUnstaged=${Boolean(body.includeUnstaged)} messageChars=${message.length} messageLines=${this.countLines(message)} messagePreview="${this.preview(message)}"`,
    );

    return this.gitService.commit(worktreePath, {
      message: body.message,
      includeUnstaged: Boolean(body.includeUnstaged),
      requestId,
    });
  }

  private createRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private countLines(value: string): number {
    return value ? value.split(/\r?\n/).length : 0;
  }

  private preview(value: string, maxLength = 120): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength)}...`
      : normalized;
  }

  @Post('commit-message/suggest')
  async suggestCommitMessage(
    @Body() body: { worktreePath: string },
  ): Promise<CommitMessageSuggestion> {
    return this.gitService.suggestCommitMessage(
      decodeURIComponent(body.worktreePath),
    );
  }

  @Get('log')
  async getLog(
    @Query('worktreePath') worktreePath: string,
    @Query('maxCount') maxCount?: number,
  ): Promise<CommitInfo[]> {
    return this.gitService.getLog(
      decodeURIComponent(worktreePath),
      maxCount ? parseInt(String(maxCount), 10) : 50,
    );
  }

  @Get('diff')
  async getDiff(
    @Query('worktreePath') worktreePath: string,
    @Query('commit') commit?: string,
    @Query('file') file?: string,
    @Query('staged') staged?: string,
  ): Promise<{ diff: string }> {
    const diff = await this.gitService.getDiff(
      decodeURIComponent(worktreePath),
      {
        commit,
        file,
        staged: staged === 'true',
      },
    );
    return { diff };
  }

  @Get('original')
  async getOriginalContent(
    @Query('worktreePath') worktreePath: string,
    @Query('path') path: string,
    @Query('ref') ref?: string,
  ): Promise<{ content: string }> {
    const content = await this.gitService.show(
      decodeURIComponent(worktreePath),
      ref || 'HEAD',
      decodeURIComponent(path),
    );
    return { content };
  }
}
