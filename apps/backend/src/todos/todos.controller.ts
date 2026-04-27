import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { TodosService } from './todos.service.js';
import { CreateTodoDto } from './dto/create-todo.dto.js';
import { UpdateTodoDto } from './dto/update-todo.dto.js';
import { UpdateOrdersDto } from './dto/update-orders.dto.js';

@Controller('projects/:projectId/todos')
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  @Get()
  findByProject(@Param('projectId') projectId: string) {
    return this.todosService.findByProject(+projectId);
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateTodoDto,
  ) {
    return this.todosService.create(+projectId, dto.text);
  }

  @Put('orders')
  updateSortOrders(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateOrdersDto,
  ) {
    return this.todosService.updateSortOrders(+projectId, dto.orders);
  }

  @Delete('completed')
  async clearCompleted(@Param('projectId') projectId: string) {
    const count = await this.todosService.clearCompleted(+projectId);
    return { count };
  }
}

@Controller('todos')
export class TodosItemController {
  constructor(private readonly todosService: TodosService) {}

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTodoDto) {
    return this.todosService.update(+id, {
      text: dto.text,
      completed: dto.completed,
    });
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.todosService.delete(+id);
  }
}