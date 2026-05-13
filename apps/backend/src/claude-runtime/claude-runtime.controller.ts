import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  forwardRef,
} from '@nestjs/common';
import { AgentRuntimeRegistryService } from '../agent-runtime/agent-runtime-registry.service.js';
import type { AgentPermissionMode } from '../agent-runtime/agent-runtime.types.js';
import { SessionsService } from '../sessions/sessions.service.js';

@Controller('sessions/:sessionId/claude')
export class ClaudeRuntimeController {
  constructor(
    private readonly registry: AgentRuntimeRegistryService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
  ) {}

  private get claudeProvider() {
    return this.registry.getProvider('claude');
  }

  @Get('history')
  getHistory(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.claudeProvider.getHistory(sessionId);
  }

  @Get('runtime-state')
  getRuntimeState(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.claudeProvider.getRuntimeState(sessionId);
  }

  @Get('subagents/:agentId/history')
  getSubagentHistory(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('agentId') agentId: string,
  ) {
    return this.registry
      .getProviderFeature('claude', 'getSubagentHistory')
      .getSubagentHistory(sessionId, agentId);
  }

  @Get('snapshot')
  getSnapshot(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.claudeProvider.getSnapshot(sessionId);
  }

  @Get('autocomplete')
  getAutocompleteItems(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.claudeProvider.getAutocompleteItems(sessionId);
  }

  @Get('mcp')
  getMcpSnapshot(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Query('forceRefresh') forceRefresh?: string,
  ) {
    return this.registry
      .getProviderFeature('claude', 'getMcpSnapshot')
      .getMcpSnapshot(
        sessionId,
        forceRefresh === '1' || forceRefresh === 'true',
      );
  }

  @Post('model')
  async setSelectedModel(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() body: { model?: string | null },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.claudeProvider.setSelectedModel(sessionId, body.model ?? null);
  }

  @Post('permission-mode')
  async setPermissionMode(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() body: { mode?: string | null },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature('claude', 'setPermissionMode')
      .setPermissionMode(
        sessionId,
        (body.mode ?? null) as AgentPermissionMode | null,
      );
  }

  @Post('mcp/:serverName/toggle')
  async toggleMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('serverName') serverName: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature('claude', 'toggleMcpServer')
      .toggleMcpServer(sessionId, serverName);
  }

  @Post('mcp/:serverName/recheck')
  async recheckMcpServer(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('serverName') serverName: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature('claude', 'recheckMcpServer')
      .recheckMcpServer(sessionId, serverName);
  }

  @Post('mcp/:serverName/auth/start')
  async startMcpAuth(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('serverName') serverName: string,
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature('claude', 'startMcpAuth')
      .startMcpAuth(sessionId, serverName);
  }

  @Post('terminal-fallback')
  async openTerminalFallback(@Param('sessionId', ParseIntPipe) sessionId: number) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature('claude', 'openTerminalFallback')
      .openTerminalFallback(sessionId);
  }

  @Post('rewind-conversation')
  async rewindConversation(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() body: { messageId?: string },
  ) {
    await this.assertSessionMutable(sessionId);
    return this.registry
      .getProviderFeature('claude', 'rewindConversation')
      .rewindConversation(sessionId, body.messageId ?? '');
  }

  private async assertSessionMutable(sessionId: number): Promise<void> {
    const session = await this.sessionsService.findOne(sessionId);
    if (session.status === 'archived') {
      throw new BadRequestException('Archived sessions are read-only');
    }
  }
}
