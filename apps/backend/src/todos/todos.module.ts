import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { TodosController, TodosItemController } from './todos.controller.js';
import { TodosService } from './todos.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [TodosController, TodosItemController],
  providers: [TodosService],
  exports: [TodosService],
})
export class TodosModule {}
