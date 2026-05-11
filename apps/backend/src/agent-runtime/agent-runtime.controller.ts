import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import type {
  AgentLoginMode,
  AgentPermissionMode,
} from './agent-runtime.types.js';

@Controller()
export class AgentRuntimeController {
  constructor(private readonly registry: AgentRuntimeRegistryService) {}

  @Get('agent-providers')
  listProviders() {
    return this.registry.listProviders();
  }

  @Get('agent-providers/:provider/auth/status')
  getAuthStatus(@Param('provider') provider: string) {
    return this.registry
      .getProviderFeature(provider, 'getAuthStatus')
      .getAuthStatus();
  }

  @Post('agent-providers/:provider/auth/login')
  startLogin(
    @Param('provider') provider: string,
    @Body() body: { mode?: AgentLoginMode; apiKey?: string; oauthProvider?: string; apiKeyProvider?: string },
  ) {
    return this.registry
      .getProviderFeature(provider, 'startLogin')
      .startLogin({
        mode: body.mode === 'api_key' ? 'api_key' : 'oauth',
        apiKey: body.apiKey,
        oauthProvider: body.oauthProvider,
        apiKeyProvider: body.apiKeyProvider,
      });
  }

  @Post('agent-providers/:provider/auth/cancel-login')
  cancelLogin(@Param('provider') provider: string) {
    return this.registry
      .getProviderFeature(provider, 'cancelLogin')
      .cancelLogin();
  }

  @Post('agent-providers/:provider/auth/continue-login')
  continueLogin(
    @Param('provider') provider: string,
    @Body() body: { code: string },
  ) {
    return this.registry
      .getProviderFeature(provider, 'continueLogin')
      .continueLogin({ code: body.code });
  }

  @Get('sessions/:sessionId/agents/:provider/history')
  getHistory(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getHistory(sessionId);
  }

  @Get('sessions/:sessionId/agents/:provider/runtime-state')
  getRuntimeState(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getRuntimeState(sessionId);
  }

  @Get('sessions/:sessionId/agents/:provider/subagents/:agentId/history')
  getSubagentHistory(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('agentId') agentId: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'getSubagentHistory')
      .getSubagentHistory(sessionId, agentId);
  }

  @Get('sessions/:sessionId/agents/:provider/snapshot')
  getSnapshot(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getSnapshot(sessionId);
  }

  @Get('sessions/:sessionId/agents/:provider/autocomplete')
  getAutocompleteItems(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getAutocompleteItems(sessionId);
  }

  @Get('sessions/:sessionId/agents/:provider/mcp')
  getMcpSnapshot(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'getMcpSnapshot')
      .getMcpSnapshot(
        sessionId,
        forceRefresh === '1' || forceRefresh === 'true',
      );
  }

  @Post('sessions/:sessionId/agents/:provider/model')
  setSelectedModel(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { model?: string | null },
  ) {
    return this.registry
      .getProvider(provider)
      .setSelectedModel(sessionId, body.model ?? null);
  }

  @Post('sessions/:sessionId/agents/:provider/permission-mode')
  setPermissionMode(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { mode?: string | null },
  ) {
    return this.registry
      .getProviderFeature(provider, 'setPermissionMode')
      .setPermissionMode(
        sessionId,
        (body.mode ?? null) as AgentPermissionMode | null,
      );
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/toggle')
  toggleMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'toggleMcpServer')
      .toggleMcpServer(sessionId, serverName);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/recheck')
  recheckMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'recheckMcpServer')
      .recheckMcpServer(sessionId, serverName);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/auth/start')
  startMcpAuth(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'startMcpAuth')
      .startMcpAuth(sessionId, serverName);
  }

  @Post('sessions/:sessionId/agents/:provider/terminal-fallback')
  openTerminalFallback(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'openTerminalFallback')
      .openTerminalFallback(sessionId);
  }

  @Post('sessions/:sessionId/agents/:provider/rewind-conversation')
  rewindConversation(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { messageId?: string },
  ) {
    return this.registry
      .getProviderFeature(provider, 'rewindConversation')
      .rewindConversation(sessionId, body.messageId ?? '');
  }
}
