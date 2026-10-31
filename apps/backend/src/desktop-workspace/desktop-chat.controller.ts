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
import { DesktopChatService } from './desktop-chat.service.js';
import { resourceId } from './desktop-workspace.service.js';

@Controller('desktop-workspace/tasks/:taskId/sessions/:sessionId/chat')
export class DesktopChatController {
  constructor(private readonly chat: DesktopChatService) {}
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
