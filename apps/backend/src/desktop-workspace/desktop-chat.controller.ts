import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { resourceId } from './desktop-workspace.service.js';

@Controller('desktop-workspace/tasks/:taskId/sessions/:sessionId/chat')
export class DesktopChatController {
  constructor(private readonly chat: DesktopChatService, private readonly attachments: DesktopChatAttachments, private readonly sessions: SessionsService) {}
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
    @Res() response: Response,
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
      );
      if (!abort.signal.aborted) response.json(result);
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
    @Query('path') path?: string, @Query('lineOffset') lineOffset?: string, @Query('revision') revision?: string,
  ) {
    return this.chat.changes(resourceId(task), resourceId(session), turn, Number(offset), path, lineOffset === undefined ? 0 : Number(lineOffset), revision);
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
