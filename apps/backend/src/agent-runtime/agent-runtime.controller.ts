import { McpManagementService } from '../mcp/config/mcp-management.service.js';
import type { McpServerDefinition } from '../mcp/config/mcp-config.types.js';
import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Inject,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  forwardRef,
} from '@nestjs/common';
import { AgentRuntimeRegistryService } from './agent-runtime-registry.service.js';
import { ConversationExportService } from './conversation-export.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import type { AgentLoginMode } from './agent-runtime.types.js';

@Controller()
export class AgentRuntimeController {
  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    private readonly exportService: ConversationExportService,
    private readonly mcp: McpManagementService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
  ) {}

  @Get('agent-providers')
  listProviders() {
    return this.registry.listProviders();
  }

  @Get('agent-providers/models')
  listModelCatalogs() {
    return this.registry.listModelCatalogs();
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
    @Body()
    body: {
      mode?: AgentLoginMode;
      apiKey?: string;
      oauthProvider?: string;
      apiKeyProvider?: string;
    },
  ) {
    return this.registry.getProviderFeature(provider, 'startLogin').startLogin({
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

  @Get('sessions/:sessionId/mention')
  getConversationMention(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.exportService.buildMention(sessionId);
  }

  @Get('sessions/:sessionId/agents/:provider/history')
  getHistory(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getHistory(sessionId);
  }

  @Get('sessions/:sessionId/agents/:provider/export')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  exportConversation(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Query('precision') precision?: string,
    @Query('includeChanges') includeChanges?: string,
    @Query('includeIds') includeIds?: string,
  ): Promise<string> {
    const flag = (value?: string) =>
      value == null || value === '1' || value === 'true'; // default on
    return this.exportService.export(sessionId, provider, {
      precision:
        precision === 'full' || precision === 'small' ? precision : 'medium',
      includeChanges: flag(includeChanges),
      includeIds: flag(includeIds),
    });
  }

  @Get('sessions/:sessionId/agents/:provider/runtime-state')
  getRuntimeState(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    return this.registry.getProvider(provider).getRuntimeState(sessionId);
  }

  @Post('sessions/:sessionId/agents/:provider/tasks/:taskId/stop')
  async stopBackgroundTask(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('taskId') taskId: string,
  ) {
    await this.sessionsService.findOne(sessionId);
    return this.registry
      .getProviderFeature(provider, 'stopBackgroundTask')
      .stopBackgroundTask(sessionId, taskId);
  }

  @Post('sessions/:sessionId/agents/:provider/subagents/:agentId/stop')
  async stopSubagent(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('agentId') agentId: string,
  ) {
    // Stopping remains available if the checkout has drifted.
    await this.sessionsService.findOne(sessionId);
    return this.registry
      .getProviderFeature(provider, 'stopSubagent')
      .stopSubagent(sessionId, agentId);
  }

  @Post('sessions/:sessionId/agents/:provider/subagents/:agentId/background')
  async backgroundSubagent(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('agentId') agentId: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'backgroundSubagent')
      .backgroundSubagent(sessionId, agentId);
  }

  @Get('sessions/:sessionId/agents/:provider/subagents/:agentId/history')
  getSubagentHistory(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('agentId') agentId: string,
    @Query('before') before?: string,
  ) {
    return this.registry
      .getProviderFeature(provider, 'getSubagentHistory')
      .getSubagentHistory(sessionId, agentId, { before });
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
    return this.mcp.getSnapshot(sessionId, provider, forceRefresh === 'true' || forceRefresh === '1');
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/servers')
  async createMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: McpServerDefinition,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.save(sessionId, provider, body);
  }

  @Get('sessions/:sessionId/agents/:provider/mcp/servers/:entryId')
  @Header('Cache-Control', 'no-store')
  getMcpServerDefinition(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('entryId') entryId: string,
  ) { return this.mcp.getDefinition(sessionId, provider, entryId); }

  @Post('sessions/:sessionId/agents/:provider/mcp/servers/:entryId')
  async updateMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('entryId') entryId: string,
    @Body() body: McpServerDefinition,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.save(sessionId, provider, body, entryId);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/servers/:entryId/remove')
  async removeMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('entryId') entryId: string,
    @Body() body: { revision: string },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.remove(sessionId, provider, entryId, body.revision);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/reload')
  async reloadMcpConfiguration(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.reload(sessionId, provider);
  }

  @Post('sessions/:sessionId/agents/:provider/model')
  async setSelectedModel(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { model?: string | null },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProvider(provider)
      .setSelectedModel(sessionId, body.model ?? null);
  }

  @Post('sessions/:sessionId/agents/:provider/permission-mode')
  async setPermissionMode(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { mode?: string | null },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'setPermissionMode')
      .setPermissionMode(sessionId, body.mode ?? null);
  }

  @Post('sessions/:sessionId/agents/:provider/plan-mode')
  async setPlanMode(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { enabled?: boolean },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'setPlanMode')
      .setPlanMode(sessionId, body.enabled === true);
  }

  @Post('sessions/:sessionId/agents/:provider/reasoning-effort')
  async setReasoningEffort(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { effort?: string | null },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'setReasoningEffort')
      .setReasoningEffort(sessionId, body.effort ?? null);
  }

  @Post('sessions/:sessionId/agents/:provider/fast-mode')
  async setFastMode(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { enabled?: boolean },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'setFastMode')
      .setFastMode(sessionId, body.enabled === true);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/toggle')
  async toggleMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.toggle(sessionId, provider, serverName);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/recheck')
  async recheckMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.recheck(sessionId, provider, serverName);
  }

  @Post('sessions/:sessionId/agents/:provider/mcp/:serverName/auth/start')
  async startMcpAuth(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Param('serverName') serverName: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.mcp.startAuth(sessionId, provider, serverName);
  }

  @Post('sessions/:sessionId/agents/:provider/terminal-fallback')
  async openTerminalFallback(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'openTerminalFallback')
      .openTerminalFallback(sessionId);
  }

  @Post('sessions/:sessionId/agents/:provider/rewind-conversation')
  async rewindConversation(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('provider') provider: string,
    @Body() body: { messageId?: string },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature(provider, 'rewindConversation')
      .rewindConversation(sessionId, body.messageId ?? '');
  }

  private async assertSessionMutable(sessionId: number): Promise<void> {
    await this.sessionsService.assertSessionWorkspaceLinked(sessionId);
    const session = await this.sessionsService.findOne(sessionId);
    if (session.status === 'archived') {
      throw new BadRequestException('Archived sessions are read-only');
    }
  }
}
