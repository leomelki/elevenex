import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ProjectsService } from './projects.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  findAll(@Query('state') state?: string) {
    return this.projectsService.findAll(
      this.projectsService.parseListState(state),
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.projectsService.findOne(+id);
  }

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto.name);
  }

  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return this.projectsService.archive(+id);
  }

  @Post(':id/unarchive')
  unarchive(@Param('id') id: string) {
    return this.projectsService.unarchive(+id);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.projectsService.delete(+id);
  }
}
