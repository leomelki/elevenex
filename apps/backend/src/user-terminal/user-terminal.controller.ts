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
import { UserTerminalService } from './user-terminal.service.js';
import { CreateUserTerminalDto } from './dto/create-user-terminal.dto.js';
import { RenameUserTerminalDto } from './dto/rename-user-terminal.dto.js';

@Controller('user-terminals')
export class UserTerminalController {
  constructor(private readonly service: UserTerminalService) {}

  @Post()
  create(@Body() dto: CreateUserTerminalDto) {
    return this.service.create(dto);
  }

  @Get()
  listByWorktree(@Query('worktreePath') worktreePath: string) {
    return this.service.listByWorktree(worktreePath);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(+id);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() dto: RenameUserTerminalDto) {
    return this.service.rename(+id, dto.name);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(+id);
  }
}
