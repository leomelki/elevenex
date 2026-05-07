import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type { AgentPermissionMode } from './agent-runtime.types.js';

@Controller()
export class AgentRuntimeController {
  constructor(private readonly registry: AgentRuntimeRegistryService) {}

  @Get('agent-providers')
  listProviders() {
    return this.registry.listProviders();
  }

  @Get('sessions/:sessionId/agents/:provider/history')
  getHistory(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getHistory(Number(sessionId));
  }

  @Get('sessions/:sessionId/agents/:provider/runtime-state')
  getRuntimeState(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
  ) {
    return this.registry
      .getProvider(provider)
      .getRuntimeState(Number(sessionId));
  }

  @Get('sessions/:sessionId/agents/:provider/subagents/:agentId/history')
  getSubagentHistory(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Param('agentId') agentId: string,
  ) {
    return this.registry
      .getProvider(provider)
      .getSubagentHistory(Number(sessionId), agentId);
  }

  @Get('sessions/:sessionId/agents/:provider/snapshot')
  getSnapshot(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getSnapshot(Number(sessionId));
  }

  @Get('sessions/:sessionId/agents/:provider/autocomplete')
  getAutocompleteItems(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
  ) {
    return this.registry
      .getProvider(provider)
      .getAutocompleteItems(Number(sessionId));
  }

  @Get('sessions/:sessionId/agents/:provider/mcp')
  getMcpSnapshot(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    return this.registry
      .getProvider(provider)
      .getMcpSnapshot(
        Number(sessionId),
        forceRefresh === '1' || forceRefresh === 'true',
      );
  }

  @Post('sessions/:sessionId/agents/:provider/model')
  setSelectedModel(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Body() body: { model?: string | null },
  ) {
    return this.registry
      .getProvider(provider)
      .setSelectedModel(Number(sessionId), body.model ?? null);
  }

  @Post('sessions/:sessionId/agents/:provider/permission-mode')
  setPermissionMode(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Body() body: { mode?: string | null },
  ) {
    return this.registry
      .getProvider(provider)
      .setPermissionMode(
        Number(sessionId),
        (body.mode ?? null) as AgentPermissionMode | null,
      );
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/toggle')
  toggleMcpServer(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    return this.registry
      .getProvider(provider)
      .toggleMcpServer(Number(sessionId), decodeURIComponent(serverName));
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/recheck')
  recheckMcpServer(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    return this.registry
      .getProvider(provider)
      .recheckMcpServer(Number(sessionId), decodeURIComponent(serverName));
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/auth/start')
  startMcpAuth(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    return this.registry
      .getProvider(provider)
      .startMcpAuth(Number(sessionId), decodeURIComponent(serverName));
  }

  @Post('sessions/:sessionId/agents/:provider/terminal-fallback')
  openTerminalFallback(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
  ) {
    return this.registry
      .getProvider(provider)
      .openTerminalFallback(Number(sessionId));
  }

  @Post('sessions/:sessionId/agents/:provider/rewind-conversation')
  rewindConversation(
    @Param('sessionId') sessionId: string,
    @Param('provider') provider: string,
    @Body() body: { messageId?: string },
  ) {
    return this.registry
      .getProvider(provider)
      .rewindConversation(Number(sessionId), body.messageId ?? '');
  }
}
