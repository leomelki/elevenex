import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ClaudeRuntimeService } from './claude-runtime.service.js';
import { ClaudeMcpService } from './claude-mcp.service.js';

@Controller('sessions/:sessionId/claude')
export class ClaudeRuntimeController {
  constructor(
    private readonly runtimeService: ClaudeRuntimeService,
    private readonly mcpService: ClaudeMcpService,
  ) {}

  @Get('history')
  getHistory(@Param('sessionId') sessionId: string) {
    return this.runtimeService.getHistory(Number(sessionId));
  }

  @Get('runtime-state')
  getRuntimeState(@Param('sessionId') sessionId: string) {
    return this.runtimeService.getRuntimeState(Number(sessionId));
  }

  @Get('subagents/:agentId/history')
  getSubagentHistory(
    @Param('sessionId') sessionId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.runtimeService.getSubagentHistory(Number(sessionId), agentId);
  }

  @Get('snapshot')
  getSnapshot(@Param('sessionId') sessionId: string) {
    return this.runtimeService.getSnapshot(Number(sessionId));
  }

  @Get('autocomplete')
  getAutocompleteItems(@Param('sessionId') sessionId: string) {
    return this.runtimeService.getAutocompleteItems(Number(sessionId));
  }

  @Get('mcp')
  getMcpSnapshot(
    @Param('sessionId') sessionId: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    return this.mcpService.getSnapshot(
      Number(sessionId),
      forceRefresh === '1' || forceRefresh === 'true',
    );
  }

  @Post('model')
  setSelectedModel(
    @Param('sessionId') sessionId: string,
    @Body() body: { model?: string | null },
  ) {
    return this.runtimeService.setSelectedModel(
      Number(sessionId),
      body.model ?? null,
    );
  }

  @Post('permission-mode')
  setPermissionMode(
    @Param('sessionId') sessionId: string,
    @Body() body: { mode?: string | null },
  ) {
    return this.runtimeService.setPermissionMode(
      Number(sessionId),
      (body.mode ?? null) as never,
    );
  }

  @Post('mcp/:serverName/toggle')
  toggleMcpServer(
    @Param('sessionId') sessionId: string,
    @Param('serverName') serverName: string,
  ) {
    return this.mcpService.toggleServer(Number(sessionId), decodeURIComponent(serverName));
  }

  @Post('mcp/:serverName/recheck')
  recheckMcpServer(
    @Param('sessionId') sessionId: string,
    @Param('serverName') serverName: string,
  ) {
    return this.mcpService.recheckServer(Number(sessionId), decodeURIComponent(serverName));
  }

  @Post('mcp/:serverName/auth/start')
  startMcpAuth(
    @Param('sessionId') sessionId: string,
    @Param('serverName') serverName: string,
  ) {
    return this.mcpService.startAuth(Number(sessionId), decodeURIComponent(serverName));
  }

  @Post('terminal-fallback')
  openTerminalFallback(@Param('sessionId') sessionId: string) {
    return this.runtimeService.openTerminalFallback(Number(sessionId));
  }

  @Post('rewind-conversation')
  rewindConversation(
    @Param('sessionId') sessionId: string,
    @Body() body: { messageId?: string },
  ) {
    return this.runtimeService.rewindConversation(
      Number(sessionId),
      body.messageId ?? '',
    );
  }
}
