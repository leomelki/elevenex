import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { AgentPermissionMode } from '../agent-runtime/agent-runtime.types.js';

@Controller('sessions/:sessionId/claude')
export class ClaudeRuntimeController {
  constructor(private readonly registry: AgentRuntimeRegistryService) {}

  private get claudeProvider() {
    return this.registry.getProvider('claude');
  }

  @Get('history')
  getHistory(@Param('sessionId') sessionId: string) {
    return this.claudeProvider.getHistory(Number(sessionId));
  }

  @Get('runtime-state')
  getRuntimeState(@Param('sessionId') sessionId: string) {
    return this.claudeProvider.getRuntimeState(Number(sessionId));
  }

  @Get('subagents/:agentId/history')
  getSubagentHistory(
    @Param('sessionId') sessionId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.claudeProvider.getSubagentHistory(Number(sessionId), agentId);
  }

  @Get('snapshot')
  getSnapshot(@Param('sessionId') sessionId: string) {
    return this.claudeProvider.getSnapshot(Number(sessionId));
  }

  @Get('autocomplete')
  getAutocompleteItems(@Param('sessionId') sessionId: string) {
    return this.claudeProvider.getAutocompleteItems(Number(sessionId));
  }

  @Get('mcp')
  getMcpSnapshot(
    @Param('sessionId') sessionId: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    return this.claudeProvider.getMcpSnapshot(
      Number(sessionId),
      forceRefresh === '1' || forceRefresh === 'true',
    );
  }

  @Post('model')
  setSelectedModel(
    @Param('sessionId') sessionId: string,
    @Body() body: { model?: string | null },
  ) {
    return this.claudeProvider.setSelectedModel(
      Number(sessionId),
      body.model ?? null,
    );
  }

  @Post('permission-mode')
  setPermissionMode(
    @Param('sessionId') sessionId: string,
    @Body() body: { mode?: string | null },
  ) {
    return this.claudeProvider.setPermissionMode(
      Number(sessionId),
      (body.mode ?? null) as AgentPermissionMode | null,
    );
  }

  @Post('mcp/:serverName/toggle')
  toggleMcpServer(
    @Param('sessionId') sessionId: string,
    @Param('serverName') serverName: string,
  ) {
    return this.claudeProvider.toggleMcpServer(
      Number(sessionId),
      decodeURIComponent(serverName),
    );
  }

  @Post('mcp/:serverName/recheck')
  recheckMcpServer(
    @Param('sessionId') sessionId: string,
    @Param('serverName') serverName: string,
  ) {
    return this.claudeProvider.recheckMcpServer(
      Number(sessionId),
      decodeURIComponent(serverName),
    );
  }

  @Post('mcp/:serverName/auth/start')
  startMcpAuth(
    @Param('sessionId') sessionId: string,
    @Param('serverName') serverName: string,
  ) {
    return this.claudeProvider.startMcpAuth(
      Number(sessionId),
      decodeURIComponent(serverName),
    );
  }

  @Post('terminal-fallback')
  openTerminalFallback(@Param('sessionId') sessionId: string) {
    return this.claudeProvider.openTerminalFallback(Number(sessionId));
  }

  @Post('rewind-conversation')
  rewindConversation(
    @Param('sessionId') sessionId: string,
    @Body() body: { messageId?: string },
  ) {
    return this.claudeProvider.rewindConversation(
      Number(sessionId),
      body.messageId ?? '',
    );
  }
}
