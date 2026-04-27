import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BranchesService } from './branches.service.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';

@Controller()
export class BranchesController {
  constructor(
    private readonly branchesService: BranchesService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  @Get('repos/:repoId/branches')
  async getBranches(@Param('repoId') repoId: string) {
    const id = +repoId;

    const repos = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (repos.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    const repo = repos[0];
    return this.branchesService.getBranches(repo.path);
  }

  @Get('repos/:repoId/branches/search')
  async searchBranches(
    @Param('repoId') repoId: string,
    @Query('q') query: string,
    @Query('allowEmpty') allowEmpty?: string,
  ) {
    const id = +repoId;

    const repos = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (repos.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    const repo = repos[0];
    return this.branchesService.searchBranches(
      repo.path,
      query,
      allowEmpty === 'true',
    );
  }

  @Get('repos/:repoId/branches/search-remote')
  async searchRemoteBranches(
    @Param('repoId') repoId: string,
    @Query('q') query: string,
  ) {
    const id = +repoId;

    const repos = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (repos.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    const repo = repos[0];
    return this.branchesService.searchRemoteBranches(repo.path, query || '');
  }

  @Post('repos/:repoId/branches')
  async createBranch(
    @Param('repoId') repoId: string,
    @Body() body: { name: string; startPoint?: string },
  ) {
    const id = +repoId;

    const repos = await this.db
      .select()
      .from(schema.repos)
      .where(eq(schema.repos.id, id));

    if (repos.length === 0) {
      throw new NotFoundException(`Repo with id ${id} not found`);
    }

    const repo = repos[0];
    return this.branchesService.createBranch(repo.path, body.name, body.startPoint);
  }
}