import { Module } from '@nestjs/common';
import { TodosController, TodosItemController } from './todos.controller.js';
import { TodosService } from './todos.service.js';

@Module({
  controllers: [TodosController, TodosItemController],
  providers: [TodosService],
  exports: [TodosService],
})
export class TodosModule {}