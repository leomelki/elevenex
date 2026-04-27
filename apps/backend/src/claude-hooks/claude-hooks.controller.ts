import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ClaudeHooksService } from './claude-hooks.service.js';

@Controller('claude-hooks')
export class ClaudeHooksController {
  constructor(private readonly hooksService: ClaudeHooksService) {}

  @Post('event')
  async handleEvent(
    @Headers('x-elevenex-session-id') sessionIdHeader: string,
    @Body()
    body: Record<string, unknown> & {
      hook_event_name?: string;
      notification_type?: string;
      session_id?: string;
      source?: string;
      cwd?: string;
      permission_mode?: string;
      agent_id?: string;
      agent_type?: string;
    },
  ): Promise<{ continue: boolean }> {
    const sessionId = parseInt(sessionIdHeader, 10);
    if (!sessionId || isNaN(sessionId)) {
      return { continue: true };
    }

    await this.hooksService.handleHookEvent(sessionId, body);
    return { continue: true };
  }
}
