import { createHash } from 'node:crypto';
import { SessionsService } from '../sessions/sessions.service.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { BadRequestException, Body, Controller, ForbiddenException, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { TasksService } from '../tasks/tasks.service.js';
import { DesktopBrowserService } from './desktop-browser.service.js';
const inputSchema = z.object({ taskId: z.number().int().positive().safe(), desktopId: z.string().uuid(), token: z.string().uuid(), receipt: z.object({ id: z.string().uuid(), value: z.unknown().optional(), failed: z.boolean().optional() }).strict().optional() }).strict();
@Controller('desktop-browser')
export class DesktopBrowserController {
  constructor(private readonly browsers: DesktopBrowserService, private readonly tasks: TasksService, private readonly servers: TaskBrowserServers, private readonly sessions: SessionsService) {}
  @Get('tasks/:taskId') async context(@Req() request: Request, @Param('taskId') taskId: string) {
    if (request.headers.origin || request.headers['sec-fetch-site']) throw new ForbiddenException();
    const parsed = z.coerce.number().int().positive().safe().safeParse(taskId);
    if (!parsed.success) throw new BadRequestException('Invalid browser task');
    const task = await this.tasks.record(parsed.data);
    if (task.archivedAt || task.taskState !== 'ready') throw new BadRequestException('Task is not active');
    return { id: task.id, repoId: task.repoId, state: 'ready',
      identity: createHash('sha256').update(JSON.stringify([task.repoId, task.id, task.createdAt])).digest('hex'), ports: await this.servers.ports(task.id) };
  }
  @Post('authorize') async authorize(@Req() request: Request, @Body() input: unknown) {
    if (request.headers.origin || request.headers['sec-fetch-site']) throw new ForbiddenException();
    const parsed = z.object({ taskId: z.number().int().positive().safe(), sessionId: z.number().int().positive().safe() }).strict().safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid browser handoff');
    const session = await this.sessions.findOne(parsed.data.sessionId), task = await this.tasks.record(parsed.data.taskId);
    if (session.workspaceId !== task.id || session.status === 'archived' || task.archivedAt || task.taskState !== 'ready') throw new ForbiddenException();
    return { ...parsed.data, available: true };
  }
  @Post('poll') async poll(@Req() request: Request, @Body() input: unknown) {
    // Page fetch/form/navigation cannot become a desktop connection. This endpoint is
    // main-to-backend only, behind the existing remote authentication boundary.
    if (request.headers.origin || request.headers['sec-fetch-site']) throw new ForbiddenException();
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || JSON.stringify(input).length > 32768) throw new BadRequestException('Invalid browser poll');
    const data = parsed.data;
    const task = await this.tasks.record(data.taskId);
    if (task.archivedAt || task.taskState !== 'ready') throw new BadRequestException('Task is not active');
    return { ...this.browsers.poll(data.taskId, data.desktopId, data.token, data.receipt), ports: await this.servers.ports(data.taskId) };
  }
}
