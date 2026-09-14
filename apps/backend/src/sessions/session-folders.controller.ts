import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import {
  CreateSessionFolderDto,
  RenameSessionFolderDto,
} from './dto/create-session-folder.dto.js';
import { SessionFoldersService } from './session-folders.service.js';

@Controller('session-folders')
export class SessionFoldersController {
  constructor(private readonly folders: SessionFoldersService) {}

  @Post()
  create(@Body() body: CreateSessionFolderDto) {
    return this.folders.create(body);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: RenameSessionFolderDto) {
    return this.folders.rename(Number(id), body.name);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.folders.archive(Number(id));
  }

  @Post(':id/unarchive')
  unarchive(@Param('id') id: string) {
    return this.folders.unarchive(Number(id));
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.folders.delete(Number(id));
  }
}
