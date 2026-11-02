import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DesktopRepositoryReviewService } from './desktop-repository-review.service.js';
import { resourceId, workspaceBody } from './desktop-workspace.service.js';

@Controller('desktop-workspace/tasks/:id/review')
export class DesktopRepositoryReviewController {
  constructor(private readonly review: DesktopRepositoryReviewService) {}
  @Post() async read(
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once('close', close);
    try {
      return await this.review.read(
        resourceId(id),
        workspaceBody(body),
        controller.signal,
      );
    } finally {
      response.off('close', close);
    }
  }
  @Get('branches') branches(
    @Param('id') id: string,
    @Query('query') query = '',
  ) {
    return this.review.branches(resourceId(id), query);
  }
}
