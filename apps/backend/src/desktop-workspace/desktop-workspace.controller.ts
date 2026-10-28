import { NavigationEventsService } from '../navigation/navigation-events.service.js';
import type { Response } from 'express';
import { listWorkspaceFolders } from './desktop-workspace-folders.js';
import {
  DesktopWorkspaceGitService,
  type WorkspaceGitInput,
} from './desktop-workspace-git.service.js';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  DesktopWorkspaceService,
  resourceId,
  workspaceBody,
  type PageQuery,
} from './desktop-workspace.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { DesktopProjectDeletionService } from './desktop-project-deletion.service.js';

@Controller('desktop-workspace')
export class DesktopWorkspaceController {
  constructor(
    private readonly navigation: NavigationEventsService,
    private readonly git: DesktopWorkspaceGitService,
    private readonly workspace: DesktopWorkspaceService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly projectDeletion: DesktopProjectDeletionService,
  ) {}
  @Get('revision') revision() {
    return { revision: this.navigation.revision, version: 1, commitPanel: true, sessionArchive: true, sessionArchiveHistory: true };
  }
  private async changed<T>(operation: Promise<T>): Promise<T> {
    const value = await operation;
    this.navigation.invalidate();
    return value;
  }
  @Get('tasks/:id/close-preview') closePreview(@Param('id') id: string) {
    return this.git.closePreview(resourceId(id));
  }
  @Post('tasks/:id/commit-preview') commitPreview(@Param('id') id: string, @Body() input: unknown) {
    return this.git.commitPreview(resourceId(id), workspaceBody(input));
  }
  @Get('tasks/:id/git') gitSummary(@Param('id') id: string) {
    return this.git.summary(resourceId(id));
  }
  @Post('tasks/:id/git') gitAction(
    @Param('id') id: string,
    @Body() input: WorkspaceGitInput,
  ) {
    return this.changed(this.git.action(resourceId(id), input));
  }
  @Post('projects/:id/restore') async restoreProject(@Param('id') id: string) {
    await this.changed(this.projects.unarchive(resourceId(id)));
    return { accepted: true };
  }
  @Post('projects/:id/delete') async deleteProject(@Param('id') id: string) {
    await this.changed(this.projectDeletion.delete(resourceId(id)));
    return { accepted: true };
  }
  @Get('projects') listProjects(@Query() query: PageQuery) {
    return this.workspace.listProjects(query);
  }
  @Get('projects/name-availability') projectNameAvailability(@Query('name') name: unknown) {
    return this.workspace.projectNameAvailability(name);
  }
  @Get('projects/:id') project(@Param('id') id: string) {
    return this.workspace.project(resourceId(id));
  }
  @Post('projects') async createProject(
    @Body() input: Parameters<DesktopWorkspaceService['createProject']>[0],
    @Res({ passthrough: true }) response: Response,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    const deadline = setTimeout(abort, 120_000);
    try {
      return await this.changed(
        this.workspace.createProject(input, controller.signal),
      );
    } finally {
      clearTimeout(deadline);
      response.off('close', abort);
    }
  }
  @Post('projects/:id/repositories') addRepository(
    @Param('id') id: string,
    @Body() input: { path: unknown },
  ) {
    return this.changed(
      this.workspace.addRepository(resourceId(id), workspaceBody(input).path),
    );
  }
  @Patch('projects/:id') updateProject(
    @Param('id') id: string,
    @Body() input: Parameters<DesktopWorkspaceService['updateProject']>[1],
  ) {
    return this.changed(this.workspace.updateProject(resourceId(id), input));
  }
  @Post('projects/:id/archive') async archiveProject(@Param('id') id: string) {
    await this.changed(this.projects.archive(resourceId(id)));
    return { accepted: true };
  }
  @Get('tasks') listTasks(
    @Query() query: PageQuery & { projectId?: string; state?: string },
  ) {
    return this.workspace.listTasks(query);
  }
  @Get('tasks/:id') task(@Param('id') id: string) {
    return this.workspace.task(resourceId(id));
  }
  @Post('tasks') createTask(
    @Body() input: Parameters<DesktopWorkspaceService['createTask']>[0],
  ) {
    return this.changed(this.workspace.createTask(input));
  }
  @Patch('tasks/:id') async renameTask(
    @Param('id') id: string,
    @Body() input: { name: string },
  ) {
    return this.changed(this.workspace.renameTask(resourceId(id), input));
  }
  @Patch('tasks/:id/stage') setStage(
    @Param('id') id: string,
    @Body() input: { stage: unknown },
  ) {
    return this.changed(
      this.workspace.setStage(resourceId(id), workspaceBody(input).stage),
    );
  }
  @Post('tasks/:id/finish') async finishTask(
    @Param('id') id: string,
    @Body() input: { confirmStop?: boolean },
  ) {
    const body = workspaceBody(input);
    if (typeof body.confirmStop !== 'boolean')
      throw new BadRequestException('A stop confirmation is required.');
    await this.tasks.finish(resourceId(id), body.confirmStop);
    return this.workspace.task(resourceId(id));
  }
  @Post('tasks/:id/retry') retryTask(
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.changed(this.workspace.retryTask(resourceId(id), input));
  }
  @Post('tasks/:id/reopen') async reopenTask(@Param('id') id: string) {
    await this.tasks.reopen(resourceId(id));
    return this.workspace.task(resourceId(id));
  }
  @Get('tasks/:id/sessions') listSessions(
    @Param('id') id: string,
    @Query() query: PageQuery & { order?: string; state?: string },
  ) {
    return this.workspace.listSessions(resourceId(id), query);
  }
  @Post('tasks/:taskId/sessions/:sessionId/archive') archiveSession(
    @Param('taskId') taskId: string, @Param('sessionId') sessionId: string, @Body() input: unknown,
  ) {
    return this.changed(this.workspace.archiveSession(resourceId(taskId), resourceId(sessionId), workspaceBody(input).confirmStop));
  }
  @Post('tasks/:taskId/sessions/:sessionId/restore') restoreSession(
    @Param('taskId') taskId: string, @Param('sessionId') sessionId: string,
  ) {
    return this.changed(this.workspace.restoreSession(resourceId(taskId), resourceId(sessionId)));
  }
  @Post('sessions') createSession(
    @Body() input: Parameters<DesktopWorkspaceService['createSession']>[0],
  ) {
    return this.changed(this.workspace.createSession(input));
  }
  @Get('branches') branches(
    @Query('repoId') id: string,
    @Query('query') query = '',
    @Query('limit') limit = '50',
  ) {
    return this.workspace.listBranches(resourceId(id), query, Number(limit));
  }
  @Get('folders') async folders(
    @Query('query') query = '',
    @Query('limit') limit = '20',
    @Res({ passthrough: true }) response: Response,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    try {
      return await listWorkspaceFolders(
        query,
        Number(limit),
        controller.signal,
      );
    } finally {
      response.off('close', abort);
    }
  }
}
