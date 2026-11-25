import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { hasAppViewerAccess } from '../config/desktop-access.js';
import { TasksService } from '../tasks/tasks.service.js';
import { TaskAppHost } from './task-app-host.js';

/** One-use tickets expire even when desktop navigation interrupts an attachment. */
@Controller('task-apps/:taskId')
export class TaskAppController {
  private readonly tickets = new Map<
    string,
    { taskId: number; runId: string; expires: number }
  >();
  constructor(
    private readonly tasks: TasksService,
    private readonly apps: TaskAppHost,
  ) {}

  private async task(request: IncomingMessage, value: string): Promise<number> {
    if (!hasAppViewerAccess(request)) throw new ForbiddenException();
    const id = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id))
      throw new BadRequestException();
    const task = await this.tasks.record(id);
    if (task.archivedAt || task.taskState !== 'ready')
      throw new BadRequestException('Task is unavailable');
    return id;
  }

  @Get() async list(
    @Req() request: IncomingMessage,
    @Param('taskId') value: string,
  ) {
    return this.apps.list(await this.task(request, value));
  }

  @Get(':runId/output') async output(
    @Req() request: IncomingMessage,
    @Param('taskId') value: string,
    @Param('runId') runId: string,
  ) {
    return { output: this.apps.output(await this.task(request, value), runId) };
  }

  @Post(':runId/approve') async approve(
    @Req() request: IncomingMessage,
    @Param('taskId') value: string,
    @Param('runId') runId: string,
  ) {
    const run = await this.tasks.approveApp(await this.task(request, value), runId);
    return { approved: true, ...(run?.setupIssue ? { setupRequired: true } : {}) };
  }

  @Post(':runId/stop') async stop(
    @Req() request: IncomingMessage,
    @Param('taskId') value: string,
    @Param('runId') runId: string,
  ) {
    await this.apps.stop(await this.task(request, value), runId);
    return { stopped: true };
  }

  @Post(':runId/setup-settings') async setupSettings(
    @Req() request: IncomingMessage,
    @Param('taskId') value: string,
    @Param('runId') runId: string,
  ) {
    const taskId = await this.task(request, value);
    try {
      await this.apps.openSetupSettings(taskId, runId);
    } catch {
      throw new BadRequestException('Settings could not open on the task machine. Follow the steps there manually.');
    }
    return { opened: true };
  }

  @Post(':runId/watch') async watch(
    @Req() request: IncomingMessage,
    @Param('taskId') value: string,
    @Param('runId') runId: string,
  ) {
    const taskId = await this.task(request, value);
    const run = this.apps.get(taskId, runId);
    if (run?.status !== 'running' || run.mode !== 'stream')
      throw new BadRequestException('App is not streaming');
    const now = Date.now();
    for (const [id, ticket] of this.tickets)
      if (now >= ticket.expires) this.tickets.delete(id);
    if (this.tickets.size >= 128)
      throw new BadRequestException('App viewer limit reached');
    const token = randomUUID();
    this.tickets.set(token, { taskId, runId, expires: now + 10000 });
    return { token };
  }

  consume(request: IncomingMessage, taskId: number, runId: string): boolean {
    if (!hasAppViewerAccess(request)) return false;
    const token = request.headers['x-elevenex-app-view'];
    if (typeof token !== 'string') return false;
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.taskId !== taskId || ticket.runId !== runId)
      return false;
    this.tickets.delete(token);
    return Date.now() < ticket.expires;
  }
}
