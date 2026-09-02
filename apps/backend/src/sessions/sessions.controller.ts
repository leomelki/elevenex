import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SessionsService } from './sessions.service.js';
import { SessionForksService } from './session-forks.service.js';
import type { CreateSessionForkDto } from './session-forks.service.js';
import {
  PlanChatForksService,
  type EnsurePlanChatForkDto,
  type SubmitPlanChatQuestionDto,
} from './plan-chat-forks.service.js';
import {
  ReviewChatsService,
  type CreateReviewChatDto,
  type ReviewAnchorDto,
  type SubmitReviewChatMessageDto,
  type UpdateReviewChatDto,
} from './review-chats.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';

@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly sessionForksService: SessionForksService,
    private readonly planChatForksService: PlanChatForksService,
    private readonly reviewChatsService: ReviewChatsService,
  ) {}

  @Post()
  create(@Body() dto: CreateSessionDto) {
    return this.sessionsService.create(dto);
  }

  @Get('repo/:repoId')
  findByRepo(@Param('repoId') repoId: string) {
    return this.sessionsService.findByRepo(+repoId);
  }

  @Get('worktree/:path')
  findByWorktreePath(@Param('path') path: string) {
    // Decode URL-encoded path
    const worktreePath = decodeURIComponent(path);
    return this.sessionsService.findByWorktreePath(worktreePath);
  }

  @Get('repo/:repoId/branch/:branchName')
  findByRepoAndBranch(
    @Param('repoId') repoId: string,
    @Param('branchName') branchName: string,
  ) {
    return this.sessionsService.findByRepoAndBranch(+repoId, branchName);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.sessionsService.update(+id, body);
  }

  @Patch(':id/status')
  updateStatus(@Param('id') id: string, @Body() body: { status: string }) {
    return this.sessionsService.updateStatus(+id, body.status);
  }

  @Patch(':id/agent-provider')
  updateActiveAgentProvider(
    @Param('id') id: string,
    @Body() body: { provider: string },
  ) {
    return this.sessionsService.updateActiveAgentProvider(+id, body.provider);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.sessionsService.delete(+id);
  }

  @Post(':id/start')
  async start(@Param('id') id: string) {
    return this.sessionsService.start(Number(id));
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    return this.sessionsService.archive(Number(id));
  }

  @Post(':id/unarchive')
  async unarchive(@Param('id') id: string) {
    return this.sessionsService.unarchive(Number(id));
  }

  @Post(':id/reset')
  async reset(@Param('id') id: string) {
    return this.sessionsService.reset(Number(id));
  }

  @Post(':id/fork')
  async fork(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.sessionsService.fork(Number(id), body.name);
  }

  @Get(':id/forks')
  findForks(@Param('id') id: string) {
    return this.sessionForksService.findByParent(Number(id));
  }

  @Post(':id/forks')
  createFork(@Param('id') id: string, @Body() body: CreateSessionForkDto) {
    return this.sessionForksService.create(Number(id), body);
  }

  @Get(':id/plan-chats')
  findPlanChats(@Param('id') id: string, @Query('reviewId') reviewId?: string) {
    return this.planChatForksService.findByParent(Number(id), reviewId);
  }

  @Post(':id/plan-chats')
  ensurePlanChat(@Param('id') id: string, @Body() body: EnsurePlanChatForkDto) {
    return this.planChatForksService.ensure(Number(id), body);
  }

  @Post(':id/plan-chats/:planChatId/questions')
  submitPlanChatQuestion(
    @Param('id') id: string,
    @Param('planChatId') planChatId: string,
    @Body() body: SubmitPlanChatQuestionDto,
  ) {
    return this.planChatForksService.submitQuestion(
      Number(id),
      Number(planChatId),
      body,
    );
  }

  @Delete(':id/plan-chats/:planChatId')
  deletePlanChat(
    @Param('id') id: string,
    @Param('planChatId') planChatId: string,
  ) {
    return this.planChatForksService.delete(Number(id), Number(planChatId));
  }

  // Review-chat routes must stay above `@Get(':id')` so `:id/review-chats` is
  // not swallowed by the single-segment session lookup.
  @Get(':id/review-chats')
  findReviewChats(@Param('id') id: string, @Query('filePath') filePath?: string) {
    return this.reviewChatsService.findByParent(Number(id), filePath);
  }

  @Post(':id/review-chats')
  createReviewChat(@Param('id') id: string, @Body() body: CreateReviewChatDto) {
    return this.reviewChatsService.create(Number(id), body);
  }

  @Post(':id/review-chats/:chatId/messages')
  submitReviewChatMessage(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @Body() body: SubmitReviewChatMessageDto,
  ) {
    return this.reviewChatsService.submitMessage(
      Number(id),
      Number(chatId),
      body,
    );
  }

  @Post(':id/review-chats/:chatId/anchors')
  addReviewChatAnchors(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @Body() body: { anchors?: ReviewAnchorDto[] },
  ) {
    return this.reviewChatsService.addAnchors(Number(id), Number(chatId), body);
  }

  @Patch(':id/review-chats/:chatId')
  updateReviewChat(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @Body() body: UpdateReviewChatDto,
  ) {
    return this.reviewChatsService.update(Number(id), Number(chatId), body);
  }

  @Post(':id/review-chats/:chatId/promote')
  promoteReviewChat(
    @Param('id') id: string,
    @Param('chatId') chatId: string,
  ) {
    return this.reviewChatsService.promote(Number(id), Number(chatId));
  }

  @Delete(':id/review-chats/:chatId')
  deleteReviewChat(@Param('id') id: string, @Param('chatId') chatId: string) {
    return this.reviewChatsService.delete(Number(id), Number(chatId));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.sessionsService.findOne(+id);
  }

  @Post(':id/kill')
  async kill(@Param('id') id: string) {
    return this.sessionsService.kill(Number(id));
  }

  @Post(':id/mark-reviewed')
  async markReviewed(@Param('id') id: string) {
    return this.sessionsService.markCompletionReviewed(Number(id));
  }
}
