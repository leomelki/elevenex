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
import { ActionsService } from './actions.service.js';
import { CreateActionDto } from './dto/create-action.dto.js';
import { UpdateActionDto } from './dto/update-action.dto.js';

@Controller('actions')
export class ActionsController {
  constructor(private readonly service: ActionsService) {}

  @Post()
  create(@Body() dto: CreateActionDto) {
    return this.service.create(dto);
  }

  @Get()
  listByWorktree(@Query('worktreePath') worktreePath: string) {
    return this.service.listByWorktree(worktreePath);
  }

  @Get('running-count')
  getRunningCount(@Query('worktreePath') worktreePath: string) {
    return this.service.getRunningCount(worktreePath);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateActionDto) {
    return this.service.update(+id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(+id);
  }

  @Post(':id/run')
  run(@Param('id') id: string) {
    return this.service.run(+id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.service.stop(+id);
  }
}
