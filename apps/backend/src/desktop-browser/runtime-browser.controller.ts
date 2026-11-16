import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RuntimeBrowserService } from './runtime-browser.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { TaskBrowserServers } from './task-browser-servers.js';
import { runtimeCommand, runtimeInput, runtimeTransfer } from './runtime-validation.js';
const webAuthnResult = z.union([
  z.object({ responseJson: z.string().min(2).max(65536) }).strict(),
  z.object({ error: z.object({ name: z.enum(['NotAllowedError', 'AbortError', 'NotSupportedError']), message: z.string().max(200) }).strict() }).strict(),
]);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid browser request');
  return result.data;
}

@Controller('desktop-browser/runtime/tasks/:taskId')
export class RuntimeBrowserController {
  constructor(
    private readonly browsers: RuntimeBrowserService,
    private readonly tasks: TasksService,
    private readonly sessions: SessionsService,
    private readonly ports: TaskBrowserServers,
  ) {}
  private async task(request: Pick<Request, 'socket' | 'headers'>, value: string): Promise<number> {
    // Display pixels require the managed private IPC transport. Originless TCP
    // requests (including local agent processes) are not proof of UI authority.
    if (
      request.socket.remoteAddress ||
      request.socket.localAddress ||
      request.headers.origin ||
      request.headers['sec-fetch-site']
    )
      throw new ForbiddenException();
    this.browsers.reservePort(request.socket.localPort);
    const id = parse(z.coerce.number().int().positive().safe(), value);
    const task = await this.tasks.record(id);
    if (task.archivedAt || task.taskState !== 'ready')
      throw new BadRequestException('Task is not active');
    return id;
  }
  /** Shared upgrade authorization; upgrades do not pass through Express guards. */
  async authorizeStream(request: Pick<Request, 'socket' | 'headers'>, id: number, token: string): Promise<void> {
    await this.task(request, String(id));
    this.browsers.viewer(id, token);
  }
  @Get('initial') async initial(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
  ) {
    const id = await this.task(request, value);
    const record = await this.tasks.record(id);
    const identity = createHash('sha256')
      .update(JSON.stringify([record.repoId, record.id, record.createdAt]))
      .digest('hex');
    const task = await this.browsers.prepare(id, identity);
    task.setPorts(await this.ports.ports(id));
    return task.state();
  }
  @Post('connect') async connect(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Body() input: unknown,
  ) {
    const id = await this.task(request, value);
    const { clientId, webAuthn } = parse(
      z.object({ clientId: z.string().uuid(), webAuthn: z.object({ platform: z.boolean() }).strict().optional() }).strict(),
      input,
    );
    const record = await this.tasks.record(id);
    const identity = createHash('sha256')
      .update(JSON.stringify([record.repoId, record.id, record.createdAt]))
      .digest('hex');
    const result = await this.browsers.connect(id, clientId, identity);
    const viewer = this.browsers.viewer(id, result.token);
    await viewer.webAuthn.configure(!!webAuthn, webAuthn?.platform ?? false);
    viewer.setPorts(await this.ports.ports(id));
    return result;
  }
  @Post('webauthn') async webAuthn(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Body() input: unknown,
  ) {
    const id = await this.task(request, value);
    const body = parse(z.object({ requestId: z.string().uuid(), result: webAuthnResult.optional() }).strict(), input);
    const task = this.browsers.viewer(id, token);
    try {
      if (body.result) { await task.webAuthn.complete(body.requestId, body.result); return {}; }
      return task.webAuthn.read(body.requestId);
    } catch { throw new BadRequestException('Authentication expired'); }
  }
  @Get('state') async state(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Query('after') after?: string,
  ) {
    const id = await this.task(request, value);
    const task = this.browsers.viewer(id, token);
    task.setPorts(await this.ports.ports(id));
    const state = task.state();
    return after !== undefined &&
      parse(z.coerce.number().int().min(0).safe(), after) === state.revision
      ? { unchanged: true }
      : state;
  }
  @Post('command') async command(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Body() input: unknown,
  ) {
    const id = await this.task(request, value);
    const command = parse(runtimeCommand, input);
    const task = this.browsers.viewer(id, token);
    if (command.kind === 'handoff') {
      const page = task.page(command.tabId), generation = page.generation;
      const session = await this.sessions.findOne(command.sessionId);
      if (session.workspaceId !== id || session.status === 'archived')
        throw new ForbiddenException();
      if (this.browsers.viewer(id, token) !== task || task.tabs.get(page.id) !== page || page.generation !== generation)
        throw new BadRequestException('Browser control changed. Hand control back explicitly when ready.');
    }
    try {
      return await task.command(command);
    } catch {
      throw new BadRequestException(
        'Browser operation failed. Inspect the page before retrying.',
      );
    }
  }
  @Post('layout') async layout(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Body() input: unknown,
  ) {
    const id = await this.task(request, value);
    const box = parse(
      z
        .object({
          tabId: z.string().uuid().optional(),
          detached: z.boolean().optional(),
          width: z.number().int().min(100).max(2560),
          height: z.number().int().min(100).max(1600),
          visible: z.boolean(),
          interactive: z.boolean(),
          pixelRatio: z.number().min(1).max(2),
          colorScheme: z.enum(['light', 'dark']).default('light'),
          sequence: z.number().int().min(0).safe().default(0),
        })
        .strict(),
      input,
    );
    const task = this.browsers.layoutViewer(id, token, box.sequence ?? 0, box.tabId);
    if (box.tabId) await task?.layoutTab(box.tabId, box.width, box.height, box.visible, box.interactive, box.pixelRatio, box.colorScheme ?? 'light', box.detached ?? true);
    else {
      if (box.detached !== undefined) throw new BadRequestException('A tab is required');
      await task?.layout(box.width, box.height, box.visible, box.interactive, box.pixelRatio, box.colorScheme ?? 'light');
    }
    return this.browsers.viewer(id, token).state();
  }
  @Post('input') async input(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Body() input: unknown,
  ) {
    const id = await this.task(request, value);
    const message = parse(
      z
        .object({
          tabId: z.string().uuid(),
          generation: z.number().int().positive().safe(),
          input: runtimeInput,
        })
        .strict(),
      input,
    );
    try {
      return await this.browsers
        .viewer(id, token)
        .input(message.tabId, message.generation, message.input);
    } catch {
      throw new BadRequestException(
        'Browser input was interrupted. Release controls and reconcile before retrying.',
      );
    }
  }
  @Post('transfer') async transfer(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Body() input: unknown,
  ) {
    const id = await this.task(request, value);
    const message = parse(runtimeTransfer, input);
    const task = this.browsers.viewer(id, token);
    return task.page(message.tabId).workflows.transfer(message.requestId, message.transfer);
  }
  @Post('disconnect') async disconnect(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
  ) {
    this.browsers.disconnect(await this.task(request, value), token);
    return { disconnected: true };
  }
  @Get('frame') async frame(
    @Req() request: Pick<Request, 'socket' | 'headers'>,
    @Res() response: Response,
    @Param('taskId') value: string,
    @Headers('x-elevenex-browser-view') token: string,
    @Query('tabId') tabId: string,
    @Query('after') after: string,
  ) {
    const id = await this.task(request, value),
      task = this.browsers.viewer(id, token);
    parse(z.string().uuid(), tabId);
    const sequence = parse(z.coerce.number().int().min(0).safe(), after ?? 0);
    if (!task.isPresented(tabId))
      throw new BadRequestException('Browser tab changed');
    const controller = new AbortController();
    const close = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', close);
    try {
      const frame = await task
        .page(tabId)
        .nextFrame(sequence, controller.signal);
      this.browsers.viewer(id, token);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (!frame) {
        response.status(204).end();
        return;
      }
      const header = Buffer.from(
        JSON.stringify({
          sequence: frame.sequence,
          width: frame.width,
          height: frame.height,
          ...(frame.displayEpoch === undefined ? {} : { displayEpoch: frame.displayEpoch }),
        }),
      );
      const size = Buffer.alloc(4);
      size.writeUInt32BE(header.length);
      response
        .type('application/octet-stream')
        .end(Buffer.concat([size, header, frame.jpeg]));
    } finally {
      response.off('close', close);
    }
  }
}
