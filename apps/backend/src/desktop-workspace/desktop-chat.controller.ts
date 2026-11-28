import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { DesktopChatAttachments } from './desktop-chat-attachments.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { record } from './desktop-chat-projection.js';
import { DesktopChatService } from './desktop-chat.service.js';
import { sendDesktopChatStream } from './desktop-chat-stream.js';
import { resourceId } from './desktop-workspace.service.js';

@Controller('desktop-workspace/tasks/:taskId/sessions/:sessionId/chat')
export class DesktopChatController {
  constructor(private readonly chat: DesktopChatService, private readonly attachments: DesktopChatAttachments, private readonly sessions: SessionsService) {}
  @Get('delivery/:deliveryId')
  delivery(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Param('deliveryId') deliveryId: string,
  ) {
    return this.chat.delivery(resourceId(task), resourceId(session), deliveryId);
  }

  @Get('events')
  events(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('loadingMode') loadingMode: unknown,
    @Headers('last-event-id') after: unknown,
    @Res() response: Response,
  ) {
    return sendDesktopChatStream(response, signal =>
      this.chat.openStream(resourceId(task), resourceId(session), loadingMode, after, signal));
  }

  @Post('attachments')
  async upload(@Param('taskId') task: string, @Param('sessionId') session: string, @Body() body: unknown) {
    const sessionId = resourceId(session);
    const target = await this.sessions.findOne(sessionId);
    if (target.workspaceId !== resourceId(task) || target.surface !== 'session' || target.status === 'archived' || target.workspaceArchivedAt)
      throw new BadRequestException('Attachments require an active session in this task.');
    await this.sessions.assertSessionWorkspaceLinked(sessionId);
    return this.attachments.chunk(sessionId, record(body));
  }
  @Get()
  async read(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('after') after: string | undefined,
    @Query('before') before: string | undefined,
    @Query('following') following: string | undefined,
    @Res() response: Response,
    @Query('loadingMode') loadingMode?: string,
    @Query('summarizeCompleted') summarizeCompleted?: string,
    @Query('deferToolDetails') deferToolDetails?: string,
    @Query('summarizeRecent') summarizeRecent?: string,
  ) {
    const abort = new AbortController();
    const close = () => abort.abort();
    response.once('close', close);
    try {
      const result = await this.chat.read(
        resourceId(task),
        resourceId(session),
        after,
        before,
        abort.signal,
        following,
        loadingMode,
        summarizeCompleted,
        deferToolDetails,
        summarizeRecent,
      );
      if (!abort.signal.aborted) response.json(result);
    } finally {
      response.off('close', close);
    }
  }
  @Get('turn-work')
  async turnWork(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('turnId') turnId: string,
    @Query('revision') revision: string,
    @Query('offset') offset: string,
    @Res() response: Response,
    @Query('deferToolDetails') deferToolDetails?: string,
    @Query('limit') limit?: string,
    @Query('timeline') timeline?: string,
    @Query('complete') complete?: string,
  ) {
    const abort = new AbortController();
    const close = () => abort.abort();
    response.once('close', close);
    try {
      const result = await this.chat.turnWork(
        resourceId(task), resourceId(session), turnId, revision,
        typeof offset === 'string' && /^\d+$/.test(offset) ? Number(offset) : NaN,
        abort.signal,
        deferToolDetails,
        limit === undefined ? undefined : typeof limit === 'string' && /^\d+$/.test(limit) ? Number(limit) : NaN,
        timeline,
        complete,
      );
      if (!abort.signal.aborted) response.json(result);
    } finally {
      response.off('close', close);
    }
  }
  @Get('tool-details')
  async toolDetails(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('itemId') itemId: string,
    @Query('revision') revision: string,
    @Query('resultId') resultId: string,
    @Query('resultRevision') resultRevision: string,
    @Res() response: Response,
    @Query('turnId') turnId?: string,
  ) {
    const abort = new AbortController();
    const close = () => abort.abort();
    response.once('close', close);
    try {
      const details = await this.chat.readToolDetails(resourceId(task), resourceId(session), {
        turnId,
        item: { id: itemId, revision },
        ...(resultId !== undefined || resultRevision !== undefined ? { result: { id: resultId, revision: resultRevision } } : {}),
      }, abort.signal);
      if (!abort.signal.aborted) response.json(details);
    } finally {
      response.off('close', close);
    }
  }
  @Post()
  command(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Body() action: unknown,
  ) {
    return this.chat.command(resourceId(task), resourceId(session), action);
  }
  @Get('prompt-edit')
  async promptEdit(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('itemId') itemId: string,
    @Res() response: Response,
  ) {
    const abort = new AbortController();
    const close = () => abort.abort();
    response.once('close', close);
    try {
      const result = await this.chat.promptEdit(resourceId(task), resourceId(session), itemId, abort.signal);
      if (!abort.signal.aborted) response.json(result);
    } finally {
      response.off('close', close);
    }
  }
  @Get('agent')
  agent(@Param('taskId') task: string, @Param('sessionId') session: string,
    @Query('agentId') agentId: string, @Query('before') before?: string) {
    return this.chat.agent(resourceId(task), resourceId(session), agentId, before);
  }
  @Get('catalog')
  catalog(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('provider') provider: string,
    @Query('refresh') refresh?: string,
  ) {
    if (refresh !== undefined && refresh !== '1')
      throw new BadRequestException('Invalid catalog refresh.');
    return this.chat.catalog(
      resourceId(task),
      resourceId(session),
      provider,
      refresh === '1',
    );
  }
  @Get('changes')
  changes(
    @Param('taskId') task: string, @Param('sessionId') session: string,
    @Query('turnId') turn: string, @Query('offset') offset: string,
    @Query('path') path?: string, @Query('lineOffset') lineOffset?: string, @Query('revision') revision?: string, @Query('source') source?: string,
  ) {
    return this.chat.changes(resourceId(task), resourceId(session), turn, Number(offset), path, lineOffset === undefined ? 0 : Number(lineOffset), revision, source);
  }
  @Get('media')
  media(
    @Param('taskId') task: string, @Param('sessionId') session: string,
    @Query('itemId') item: string, @Query('mediaId') media: string,
  ) {
    return this.chat.media(resourceId(task), resourceId(session), item, media);
  }
  @Get('content')
  content(
    @Param('taskId') task: string,
    @Param('sessionId') session: string,
    @Query('itemId') item: string,
    @Query('part') part: string,
    @Query('offset') offset: string,
  ) {
    return this.chat.content(
      resourceId(task),
      resourceId(session),
      item,
      part,
      Number(offset),
    );
  }
}
