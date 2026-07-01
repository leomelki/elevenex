import { Global, Module } from '@nestjs/common';
import { AgentFocusService } from './agent-focus.service.js';

/**
 * Holds the ephemeral "UI focus" store. Marked `@Global` because the three
 * places that touch it live in different modules and would otherwise force
 * import wiring or a cycle:
 *  - the agent-runtime gateway and the missions service WRITE focus on each
 *    user message,
 *  - the MCP `get_focused_session` tool (via `McpToolServices`) READS it.
 * The service is a dependency-free in-memory map, so a global singleton is safe.
 */
@Global()
@Module({
  providers: [AgentFocusService],
  exports: [AgentFocusService],
})
export class AgentFocusModule {}
