import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  DesktopTerminalService,
  terminalId,
} from './desktop-terminal.service.js';

/** Additive desktop protocol. GET is attachment only and can never start a shell. */
@Controller('desktop-workspace/tasks/:taskId/terminals')
export class DesktopTerminalController {
  constructor(private readonly service: DesktopTerminalService) {}
  @Get() list(@Param('taskId') task: string) {
    return this.service.list(terminalId(task));
  }
  @Post() create(@Param('taskId') task: string, @Body() input: unknown) {
    return this.service.create(terminalId(task), input);
  }
  @Get(':id/output') read(
    @Param('taskId') task: string,
    @Param('id') id: string,
    @Query('generation') gen: string | undefined,
    @Query('after') after: string,
  ) {
    return this.service.read(
      terminalId(task),
      terminalId(id),
      gen ?? null,
      after,
    );
  }
  @Post(':id') command(
    @Param('taskId') task: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.service.command(terminalId(task), terminalId(id), input);
  }
  @Delete(':id') close(@Param('taskId') task: string, @Param('id') id: string) {
    return this.service.close(terminalId(task), terminalId(id));
  }
}

/** App-lifetime cleanup, scoped to the main process's opaque launch owner. */
@Controller('desktop-workspace/terminal-owners')
export class DesktopTerminalOwnerController {
  constructor(private readonly service: DesktopTerminalService) {}
  @Delete(':owner') close(@Param('owner') owner: string) {
    return this.service.closeOwned(owner);
  }
}
