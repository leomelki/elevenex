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
import { ScratchpadService } from './scratchpad.service.js';
import { CreateSectionDto } from './dto/create-section.dto.js';
import { UpdateSectionDto } from './dto/update-section.dto.js';
import { UpdateOrdersDto } from './dto/update-orders.dto.js';

@Controller('projects/:projectId/scratchpad')
export class ScratchpadController {
  constructor(private readonly scratchpadService: ScratchpadService) {}

  @Get()
  findByProject(@Param('projectId') projectId: string) {
    return this.scratchpadService.findByProject(+projectId);
  }

  @Post()
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateSectionDto,
  ) {
    return this.scratchpadService.create(
      +projectId,
      dto.name,
      dto.description,
    );
  }

  @Put('orders')
  updateSortOrders(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateOrdersDto,
  ) {
    return this.scratchpadService.updateSortOrders(+projectId, dto.orders);
  }
}

@Controller('scratchpad')
export class ScratchpadSectionController {
  constructor(private readonly scratchpadService: ScratchpadService) {}

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSectionDto) {
    return this.scratchpadService.update(+id, {
      name: dto.name,
      description: dto.description,
      content: dto.content,
      isMarkdown: dto.isMarkdown,
    });
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.scratchpadService.delete(+id);
  }
}