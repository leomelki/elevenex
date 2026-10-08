import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { TasksService } from './tasks.service.js';

class RenameTaskDto {
  @IsString() @MaxLength(160) name!: string;
}
class FinishTaskDto {
  @IsBoolean() @IsOptional() confirmStop?: boolean;
}
class TaskDraftDto {
  @IsString() @MaxLength(100000) text!: string;
}
class RetryTaskDto {
  @IsString() @IsOptional() @MaxLength(160) name?: string;
  @IsString() @IsOptional() @MaxLength(240) branchName?: string;
  @IsString() @IsOptional() @MaxLength(240) baseRef?: string;
  @IsBoolean() @IsOptional() confirmOverLimit?: boolean;
  @IsBoolean() @IsOptional() confirmExternal?: boolean;
  @IsBoolean() @IsOptional() useSavedRef?: boolean;
  @IsOptional() @IsIn(['new', 'existing']) mode?: 'new' | 'existing';
  @IsOptional() @IsIn(['branch', 'snapshot']) checkoutMode?:
    | 'branch'
    | 'snapshot';
  @IsOptional() @IsIn(['automatic', 'new', 'existing']) environment?:
    | 'automatic'
    | 'new'
    | 'existing';
  @IsOptional() @IsInt() @Min(1) worktreeId?: number;
}

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}
  @Get('repos/:repoId/tasks/defaults') defaults(
    @Param('repoId') repoId: string,
    @Query('name') name = '',
  ) {
    return this.tasks.defaults(+repoId, name.slice(0, 160));
  }
  @Get('repos/:repoId/tasks') list(
    @Param('repoId') repoId: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.tasks.list(
      +repoId,
      state === 'finished' ? 'finished' : 'active',
      +(limit || 50),
      +(cursor || 0),
    );
  }
  @Post('repos/:repoId/tasks') @HttpCode(HttpStatus.ACCEPTED) create(
    @Param('repoId') repoId: string,
    @Body() input: CreateTaskDto,
  ) {
    return this.tasks.create(+repoId, input);
  }
  @Get('tasks/:id') get(@Param('id') id: string) {
    return this.tasks.get(+id);
  }
  @Post('tasks/:id/conversation') conversation(@Param('id') id: string) {
    return this.tasks.openConversation(+id);
  }
  @Patch('tasks/:id') rename(
    @Param('id') id: string,
    @Body() input: RenameTaskDto,
  ) {
    return this.tasks.rename(+id, input.name);
  }
  @Post('tasks/:id/retry') @HttpCode(HttpStatus.ACCEPTED) retry(
    @Param('id') id: string,
    @Body() input: RetryTaskDto,
  ) {
    return this.tasks.retry(+id, input);
  }
  @Patch('tasks/:id/draft') draft(
    @Param('id') id: string,
    @Body() input: TaskDraftDto,
  ) {
    return this.tasks.saveDraft(+id, input.text);
  }
  @Get('tasks/:id/finish-preview') preview(@Param('id') id: string) {
    return this.tasks.finishPreview(+id);
  }
  @Post('tasks/:id/finish') finish(
    @Param('id') id: string,
    @Body() input: FinishTaskDto,
  ) {
    return this.tasks.finish(+id, input.confirmStop);
  }
  @Post('tasks/:id/reopen') @HttpCode(HttpStatus.ACCEPTED) reopen(
    @Param('id') id: string,
  ) {
    return this.tasks.reopen(+id);
  }
}
