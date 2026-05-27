import { Controller, Get, Post, Body, Query, Logger } from '@nestjs/common';
import type { AgentProviderId } from '../agent-runtime/agent-runtime.types.js';
import { ChangeReviewService } from './change-review.service.js';
import type {
  ChangeReviewContextWindow,
  ChangeReviewFileWindow,
  ChangeReviewScope,
  ChangeReviewSummary,
} from './change-review.types.js';
import {
  GitService,
  FileStatus,
  CommitInfo,
  CommitMessageSuggestion,
  GitStatusSummary,
  CommitResult,
  PushResult,
} from './git.service.js';

@Controller('git')
export class GitController {
  private readonly logger = new Logger(GitController.name);

  constructor(
    private readonly gitService: GitService,
    private readonly changeReviewService: ChangeReviewService,
  ) {}

  @Get('status')
  async getStatus(
    @Query('worktreePath') worktreePath: string,
  ): Promise<FileStatus[]> {
    return this.gitService.getStatus(decodeURIComponent(worktreePath));
  }

  @Get('summary')
  async getSummary(
    @Query('worktreePath') worktreePath: string,
    @Query('conflictsOnly') conflictsOnly?: string,
  ): Promise<GitStatusSummary> {
    return this.gitService.getStatusSummary(decodeURIComponent(worktreePath), {
      conflictsOnly: conflictsOnly === 'true',
    });
  }

  @Get('change-review/summary')
  async getChangeReviewSummary(
    @Query('worktreePath') worktreePath: string,
    @Query('scope') scope: ChangeReviewScope = 'branch',
    @Query('refreshBase') refreshBase?: string,
    @Query('forceLoad') forceLoad?: string,
  ): Promise<ChangeReviewSummary> {
    return this.changeReviewService.getSummary(
      decodeURIComponent(worktreePath),
      scope,
      refreshBase === 'true',
      forceLoad === 'true',
    );
  }

  @Get('change-review/file')
  async getChangeReviewFile(
    @Query('worktreePath') worktreePath: string,
    @Query('scope') scope: ChangeReviewScope = 'branch',
    @Query('path') filePath: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('context') context?: string,
    @Query('forceLoad') forceLoad?: string,
  ): Promise<ChangeReviewFileWindow> {
    return this.changeReviewService.getFileWindow(
      decodeURIComponent(worktreePath),
      scope,
      decodeURIComponent(filePath),
      {
        offset: offset ? Number.parseInt(offset, 10) : undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        context: context ? Number.parseInt(context, 10) : undefined,
        forceLoad: forceLoad === 'true',
      },
    );
  }

  @Get('change-review/window')
  async getChangeReviewWindow(
    @Query('worktreePath') worktreePath: string,
    @Query('scope') scope: ChangeReviewScope = 'branch',
    @Query('path') filePath: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('context') context?: string,
    @Query('forceLoad') forceLoad?: string,
  ): Promise<ChangeReviewFileWindow> {
    return this.getChangeReviewFile(
      worktreePath,
      scope,
      filePath,
      offset,
      limit,
      context,
      forceLoad,
    );
  }

  @Get('change-review/context')
  async getChangeReviewContext(
    @Query('worktreePath') worktreePath: string,
    @Query('scope') scope: ChangeReviewScope = 'branch',
    @Query('path') filePath: string,
    @Query('oldStart') oldStart: string,
    @Query('newStart') newStart: string,
    @Query('count') count: string,
    @Query('limit') limit?: string,
    @Query('forceLoad') forceLoad?: string,
  ): Promise<ChangeReviewContextWindow> {
    return this.changeReviewService.getContextWindow(
      decodeURIComponent(worktreePath),
      scope,
      decodeURIComponent(filePath),
      {
        oldStart: Number.parseInt(oldStart, 10),
        newStart: Number.parseInt(newStart, 10),
        count: Number.parseInt(count, 10),
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        forceLoad: forceLoad === 'true',
      },
    );
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
      provider: AgentProviderId;
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
      provider: body.provider,
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
    @Body() body: { worktreePath: string; provider: AgentProviderId },
  ): Promise<CommitMessageSuggestion> {
    return this.gitService.suggestCommitMessage(
      decodeURIComponent(body.worktreePath),
      body.provider,
    );
  }

  @Post('push')
  push(@Body() body: { worktreePath: string }): Promise<PushResult> {
    return this.gitService.push(decodeURIComponent(body.worktreePath));
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
