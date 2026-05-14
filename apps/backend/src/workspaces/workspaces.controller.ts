import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import * as schema from '../database/schema/index.js';
import { CreateWorkspaceDto } from './dto/create-workspace.dto.js';
import { CreateWorkspaceBranchDto } from './dto/create-workspace-branch.dto.js';
import { SwitchWorkspaceBranchDto } from './dto/switch-workspace-branch.dto.js';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto.js';
import { WorkspacesService } from './workspaces.service.js';

@Controller()
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  @Get('repos/:repoId/workspaces')
  async list(@Param('repoId') repoId: string) {
    const repo = await this.findRepo(+repoId);
    return this.workspacesService.listForRepo(repo);
  }

  @Post('repos/:repoId/workspaces')
  async create(@Param('repoId') repoId: string, @Body() dto: CreateWorkspaceDto) {
    const repo = await this.findRepo(+repoId);
    return this.workspacesService.createWorkspace(repo, dto);
  }

  @Patch('repos/:repoId/workspaces/:workspaceId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspacesService.renameWorkspace(+workspaceId, dto.name);
  }

  @Post('repos/:repoId/workspaces/:workspaceId/switch-branch')
  async switchBranch(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SwitchWorkspaceBranchDto,
  ) {
    return this.workspacesService.switchBranch(+workspaceId, dto.branchName, dto.force);
  }

  @Post('repos/:repoId/workspaces/:workspaceId/create-branch')
  async createBranch(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateWorkspaceBranchDto,
  ) {
    return this.workspacesService.createBranch(+workspaceId, dto);
  }

  @Delete('repos/:repoId/workspaces/:workspaceId')
  async delete(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.deleteWorkspace(+workspaceId, true);
  }

  @Delete('repos/:repoId/workspaces/:workspaceId/project-attachment')
  async forget(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.deleteWorkspace(+workspaceId, false);
  }

  private async findRepo(repoId: number) {
    const rows = await this.db.select().from(schema.repos).where(eq(schema.repos.id, repoId));
    if (rows.length === 0) {
      throw new NotFoundException(`Repo with id ${repoId} not found`);
    }
    return rows[0];
  }
}
