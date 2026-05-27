import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { SessionsService } from './sessions.service.js';
import { SessionForksService } from './session-forks.service.js';
import type { CreateSessionForkDto } from './session-forks.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';

@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly sessionForksService: SessionForksService,
  ) {}

  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.sessionsService.create(dto);
  }

  @Get('repo/:repoId')
  findByRepo(@Param('repoId') repoId: string) {
    return this.sessionsService.findByRepo(+repoId);
  }

  @Get('worktree/:path')
  findByWorktreePath(@Param('path') path: string) {
    // Decode URL-encoded path
    const worktreePath = decodeURIComponent(path);
    return this.sessionsService.findByWorktreePath(worktreePath);
  }

  @Get('repo/:repoId/branch/:branchName')
  findByRepoAndBranch(
    @Param('repoId') repoId: string,
    @Param('branchName') branchName: string,
  ) {
    return this.sessionsService.findByRepoAndBranch(+repoId, branchName);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.sessionsService.update(+id, body);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status: string }) {
    return this.sessionsService.updateStatus(+id, body.status);
  }

  @Patch(':id/agent-provider')
  updateActiveAgentProvider(
    @Param('id') id: string,
    @Body() body: { provider: string },
  ) {
    return this.sessionsService.updateActiveAgentProvider(+id, body.provider);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.sessionsService.delete(+id);
  }

  @Post(':id/start')
  async start(@Param('id') id: string) {
    return this.sessionsService.start(Number(id));
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    return this.sessionsService.archive(Number(id));
  }

  @Post(':id/unarchive')
  async unarchive(@Param('id') id: string) {
    return this.sessionsService.unarchive(Number(id));
  }

  @Post(':id/reset')
  async reset(@Param('id') id: string) {
    return this.sessionsService.reset(Number(id));
  }

  @Post(':id/fork')
  async fork(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.sessionsService.fork(Number(id), body.name);
  }

  @Get(':id/forks')
  findForks(@Param('id') id: string) {
    return this.sessionForksService.findByParent(Number(id));
  }

  @Post(':id/forks')
  createFork(@Param('id') id: string, @Body() body: CreateSessionForkDto) {
    return this.sessionForksService.create(Number(id), body);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sessionsService.findOne(+id);
  }

  @Post(':id/kill')
  async kill(@Param('id') id: string) {
    return this.sessionsService.kill(Number(id));
  }

  @Post(':id/mark-reviewed')
  async markReviewed(@Param('id') id: string) {
    return this.sessionsService.markCompletionReviewed(Number(id));
  }
}
