import { Body, Controller, Get, Logger, Post, Put, Query } from '@nestjs/common';
import { ConsumeWorktreeContextDto } from './dto/consume-worktree-context.dto.js';
import { GenerateWorktreeContextDto } from './dto/generate-worktree-context.dto.js';
import { GetWorktreeContextDto } from './dto/get-worktree-context.dto.js';
import { UpdateWorktreeRootRefDto } from './dto/update-worktree-root-ref.dto.js';
import { WorktreeContextService } from './worktree-context.service.js';

@Controller('worktree-context')
export class WorktreeContextController {
  private readonly logger = new Logger(WorktreeContextController.name);

  constructor(private readonly worktreeContextService: WorktreeContextService) {}

  @Get()
  getSnapshot(@Query() query: GetWorktreeContextDto) {
    this.logger.log(`GET / repo=${query.repoId} path=${query.worktreePath}`);
    return this.worktreeContextService.getSnapshot(query.repoId, query.worktreePath);
  }

  @Post('generate')
  generate(@Body() dto: GenerateWorktreeContextDto) {
    this.logger.log(
      `POST /generate repo=${dto.repoId} path=${dto.worktreePath} force=${!!dto.force} rootRef=${dto.rootRef ?? 'inherit'}`,
    );
    return this.worktreeContextService.generate(dto.repoId, dto.worktreePath, {
      force: dto.force,
      rootRef: dto.rootRef,
    });
  }

  @Put('root-ref')
  updateRootRef(@Body() dto: UpdateWorktreeRootRefDto) {
    this.logger.log(`PUT /root-ref repo=${dto.repoId} path=${dto.worktreePath} rootRef=${dto.rootRef ?? 'null'}`);
    return this.worktreeContextService.updateRootRef(
      dto.repoId,
      dto.worktreePath,
      dto.rootRef ?? null,
    );
  }

  @Post('consume')
  consume(@Body() dto: ConsumeWorktreeContextDto) {
    this.logger.log(`POST /consume session=${dto.sessionId} enabled=${dto.enabled ?? true}`);
    return this.worktreeContextService.consumeForSession(
      dto.sessionId,
      dto.enabled ?? true,
      dto.contextSentence,
    );
  }
}
