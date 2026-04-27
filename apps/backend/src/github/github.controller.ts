import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GithubService } from './github.service.js';

@Controller('github')
export class GithubController {
  constructor(private readonly githubService: GithubService) {}

  @Get('capabilities')
  getCapabilities(
    @Query('worktreePath') worktreePath: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.githubService.getCapabilities(
      decodeURIComponent(worktreePath),
      refresh === 'true',
    );
  }

  @Get('branch-context')
  getBranchContext(
    @Query('worktreePath') worktreePath: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.githubService.getBranchContext(
      decodeURIComponent(worktreePath),
      refresh === 'true',
    );
  }

  @Get('pull-request')
  getPullRequest(
    @Query('worktreePath') worktreePath: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.githubService.getPullRequest(
      decodeURIComponent(worktreePath),
      refresh === 'true',
    );
  }

  @Get('pull-request/diff')
  getPullRequestDiff(
    @Query('worktreePath') worktreePath: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.githubService.getPullRequestDiff(
      decodeURIComponent(worktreePath),
      refresh === 'true',
    );
  }

  @Get('pull-request/conversation')
  getPullRequestConversation(
    @Query('worktreePath') worktreePath: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.githubService.getPullRequestConversation(
      decodeURIComponent(worktreePath),
      refresh === 'true',
    );
  }

  @Get('pull-request/checks')
  getPullRequestChecks(
    @Query('worktreePath') worktreePath: string,
    @Query('refresh') refresh?: string,
  ) {
    return this.githubService.getPullRequestChecks(
      decodeURIComponent(worktreePath),
      refresh === 'true',
    );
  }

  @Post('pull-request/comment')
  addComment(@Body() body: { worktreePath: string; comment: string }) {
    return this.githubService.addComment(
      decodeURIComponent(body.worktreePath),
      body.comment,
    );
  }

  @Post('pull-request/review')
  submitReview(
    @Body()
    body: {
      worktreePath: string;
      event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
      body: string;
    },
  ) {
    return this.githubService.submitReview(
      decodeURIComponent(body.worktreePath),
      body.event,
      body.body,
    );
  }

  @Post('push')
  push(@Body() body: { worktreePath: string }) {
    return this.githubService.push(decodeURIComponent(body.worktreePath));
  }
}
