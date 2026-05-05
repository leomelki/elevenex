import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { WorktreesService } from './worktrees.service.js';
import { CreateWorktreeDto } from './dto/create-worktree.dto.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorktreeCreationJobsService } from './worktree-creation-jobs.service.js';
import * as schema from '../database/schema/index.js';
import * as path from 'node:path';

@Controller()
export class WorktreesController {
  constructor(
    private readonly worktreesService: WorktreesService,
    private readonly worktreeCreationJobsService: WorktreeCreationJobsService,
    private readonly sessionsService: SessionsService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  @Get('repos/:repoId/worktrees')
  async listWorktrees(@Param('repoId') repoId: string) {
    const id = +repoId;

    const repos = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (repos.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    return this.worktreesService.listWorktrees(repos[0].path);
  }

  @Post('repos/:repoId/worktrees')
  @HttpCode(HttpStatus.ACCEPTED)
  async createWorktree(
    @Param('repoId') repoId: string,
    @Body() dto: CreateWorktreeDto,
  ) {
    const { id, repo } = await this.findRepo(repoId);
    const worktreePath =
      dto.worktreePath ||
      path.join(path.dirname(repo.path), '.worktrees', repo.name, dto.branchName);
    const job = this.worktreeCreationJobsService.startJob(
      id,
      repo.path,
      dto.branchName,
      worktreePath,
    );

    return {
      jobId: job.id,
      repoId: id,
      branchName: job.branchName,
      worktreePath: job.worktreePath,
      status: job.status,
    };
  }

  @Get('repos/:repoId/worktrees/jobs/:jobId')
  async getCreateWorktreeJob(
    @Param('repoId') repoId: string,
    @Param('jobId') jobId: string,
  ) {
    const { id } = await this.findRepo(repoId);
    const job = this.worktreeCreationJobsService.getJob(id, jobId);

    return {
      jobId: job.id,
      status: job.status,
      branchName: job.branchName,
      worktreePath: job.worktreePath,
      result: job.result,
      error: job.error,
    };
  }

  @Delete('repos/:repoId/worktrees')
  async removeWorktree(
    @Param('repoId') repoId: string,
    @Body() body: { worktreePath: string },
  ) {
    const { repo } = await this.findRepo(repoId);

    // Delete sessions associated with this worktree before removing it
    await this.sessionsService.deleteByWorktreePath(body.worktreePath);
    await this.worktreesService.removeWorktree(repo.path, body.worktreePath);
    return { success: true };
  }

  @Delete('repos/:repoId/worktrees/project-attachment')
  async removeWorktreeFromProject(
    @Param('repoId') repoId: string,
    @Body() body: { worktreePath: string },
  ) {
    const { id } = await this.findRepo(repoId);

    await this.sessionsService.deleteByRepoAndWorktreePath(
      id,
      body.worktreePath,
    );

    return { success: true };
  }

  private async findRepo(repoId: string) {
    const id = +repoId;

    const repos = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (repos.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    return { id, repo: repos[0] };
  }
}
