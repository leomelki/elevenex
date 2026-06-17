import { Module } from '@nestjs/common';
import { ElevenexAgentService } from './elevenex-agent.service.js';

/**
 * Hosts the agent-workspace bootstrap. Downstream-only and dependency-free, so
 * it adds no cycles. Token minting for agent sessions lives in
 * `McpAgentTokenService` (MCP module) to keep this a pure leaf.
 */
@Module({
  providers: [ElevenexAgentService],
  exports: [ElevenexAgentService],
})
export class ElevenexAgentModule {}
