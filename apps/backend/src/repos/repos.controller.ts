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
import { ReposService } from './repos.service.js';
import { AddRepoDto } from './dto/add-repo.dto.js';
import { UpdateRepoContextRootDto } from './dto/update-repo-context-root.dto.js';
import { GetRepoSuggestionsDto } from './dto/get-repo-suggestions.dto.js';

@Controller()
export class ReposController {
  constructor(private readonly reposService: ReposService) {}

  @Get('projects/:projectId/repos')
  findByProject(@Param('projectId') projectId: string) {
    return this.reposService.findByProject(+projectId);
  }

  @Post('projects/:projectId/repos')
  addRepo(@Param('projectId') projectId: string, @Body() dto: AddRepoDto) {
    return this.reposService.addRepo(+projectId, dto.path);
  }

  @Post('repos/validate')
  validatePath(@Body() dto: AddRepoDto) {
    return this.reposService.validatePath(dto.path);
  }

  @Get('repos/suggestions')
  suggestions(@Query() query: GetRepoSuggestionsDto) {
    return this.reposService.suggestRepositories(query.query, query.limit);
  }

  @Delete('repos/:id')
  remove(@Param('id') id: string) {
    return this.reposService.remove(+id);
  }

  @Patch('repos/:id/context-root')
  updatePreferredContextRootRef(
    @Param('id') id: string,
    @Body() dto: UpdateRepoContextRootDto,
  ) {
    return this.reposService.updatePreferredContextRootRef(
      +id,
      dto.preferredContextRootRef ?? null,
    );
  }
}
