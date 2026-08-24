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
  Patch,
  Post,
  Sse,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { Observable } from 'rxjs';
import { WorktreesService } from './worktrees.service.js';
import { CreateWorktreeDto } from './dto/create-worktree.dto.js';
import { CreatePoolWorktreeDto } from './dto/create-pool-worktree.dto.js';
import { LinkPoolWorktreeDto } from './dto/link-pool-worktree.dto.js';
import { RenamePoolWorktreeDto } from './dto/rename-pool-worktree.dto.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { WorktreeCreationJobsService } from './worktree-creation-jobs.service.js';
import { WorktreePoolItem, WorktreePoolService } from './worktree-pool.service.js';
import * as schema from '../database/schema/index.js';
import * as path from 'node:path';
import { ProjectsService } from '../projects/projects.service.js';

type WorktreeStreamEvent = {
  type: string;
  data: unknown;
};

@Controller()
export class WorktreesController {
  constructor(
    private readonly worktreesService: WorktreesService,
    private readonly worktreePoolService: WorktreePoolService,
    private readonly worktreeCreationJobsService: WorktreeCreationJobsService,
    private readonly sessionsService: SessionsService,
    private readonly projectsService: ProjectsService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  @Get('repos/:repoId/worktree-pool')
  async listWorktreePool(@Param('repoId') repoId: string) {
    const { repo } = await this.findRepo(repoId);
    return this.worktreePoolService.listForRepo(repo);
  }

  @Sse('repos/:repoId/worktree-pool/stream')
  async streamListWorktreePool(
    @Param('repoId') repoId: string,
  ): Promise<Observable<WorktreeStreamEvent>> {
    const { repo } = await this.findRepo(repoId);
    return new Observable<WorktreeStreamEvent>((subscriber) => {
      let closed = false;

      const onItem = (item: WorktreePoolItem) => {
        if (closed) return;
        subscriber.next({
          type: 'worktree',
          data: item,
        });
      };

      this.worktreePoolService
        .streamProgressivelyForRepo(repo, onItem)
        .then((total) => {
          if (closed) return;
          subscriber.next({
            type: 'done',
            data: { total },
          });
          subscriber.complete();
        })
        .catch((error) => {
          if (closed) return;
          closed = true;
          subscriber.error(error);
        });

      return () => {
        closed = true;
      };
    });
  }

  @Post('repos/:repoId/worktree-pool')
  async createPoolWorktree(
    @Param('repoId') repoId: string,
    @Body() dto: CreatePoolWorktreeDto,
  ) {
    const { repo } = await this.findRepo(repoId);
    return this.worktreePoolService.createForRepo(repo, dto);
  }

  @Patch('repos/:repoId/worktree-pool/:worktreeId')
  async renamePoolWorktree(
    @Param('repoId') repoId: string,
    @Param('worktreeId') worktreeId: string,
    @Body() dto: RenamePoolWorktreeDto,
  ) {
    const { repo } = await this.findRepo(repoId);
    return this.worktreePoolService.rename(repo, +worktreeId, dto.name);
  }

  @Post('repos/:repoId/worktree-pool/:worktreeId/link')
  async linkPoolWorktree(
    @Param('repoId') repoId: string,
    @Param('worktreeId') worktreeId: string,
    @Body() dto: LinkPoolWorktreeDto,
  ) {
    const { repo } = await this.findRepo(repoId);
    return this.worktreePoolService.linkToProject(repo, +worktreeId, dto);
  }

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
    await this.projectsService.assertProjectIsActive(repo.projectId);

    const worktreePath =
      dto.worktreePath ||
      path.join(
        path.dirname(repo.path),
        '.worktrees',
        repo.name,
        dto.branchName,
      );
    const job = this.worktreeCreationJobsService.startJob(
      id,
      repo.path,
      dto.branchName,
      worktreePath,
      dto.startPoint,
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
    const { id, repo } = await this.findRepo(repoId);
    await this.projectsService.assertProjectIsActive(repo.projectId);

    // Delete sessions associated with this repo/worktree before removing it.
    await this.sessionsService.deleteByRepoAndWorktreePath(
      id,
      body.worktreePath,
    );
    await this.worktreesService.removeWorktree(repo.path, body.worktreePath);
    return { success: true };
  }

  @Delete('repos/:repoId/worktrees/project-attachment')
  async removeWorktreeFromProject(
    @Param('repoId') repoId: string,
    @Body() body: { worktreePath: string },
  ) {
    const { id, repo } = await this.findRepo(repoId);
    await this.projectsService.assertProjectIsActive(repo.projectId);

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
