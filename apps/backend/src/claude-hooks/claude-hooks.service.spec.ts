import { Test, TestingModule } from '@nestjs/testing';
import { ClaudeHooksService } from './claude-hooks.service.js';
import { SessionsService } from '../sessions/sessions.service.js';

describe('ClaudeHooksService', () => {
  let service: ClaudeHooksService;
  let sessionsService: {
    markCompletionUnreviewed: jest.Mock;
    markLastStateChange: jest.Mock;
    updateClaudeSessionId: jest.Mock;
  };

  beforeEach(async () => {
    sessionsService = {
      markCompletionUnreviewed: jest.fn(),
      markLastStateChange: jest.fn(),
      updateClaudeSessionId: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeHooksService,
        { provide: SessionsService, useValue: sessionsService },
      ],
    }).compile();

    service = module.get(ClaudeHooksService);
  });

  it('marks a session unreviewed when running transitions to idle', async () => {
    await service.updateStatus(1, 'running');
    await service.updateStatus(1, 'idle');

    expect(sessionsService.markLastStateChange).toHaveBeenCalledTimes(2);
    expect(sessionsService.markCompletionUnreviewed).toHaveBeenCalledWith(
      1,
      'completed',
    );
  });

  it('marks a session unreviewed when waiting transitions to idle', async () => {
    await service.updateStatus(1, 'running');
    await service.updateStatus(1, 'waiting');
    await service.updateStatus(1, 'idle');

    expect(sessionsService.markLastStateChange).toHaveBeenCalledTimes(3);
    expect(sessionsService.markCompletionUnreviewed).toHaveBeenCalledWith(
      1,
      'completed',
    );
  });

  it('does not mark unreviewed completion for idle without a prior active state', async () => {
    await service.updateStatus(1, 'idle');

    expect(sessionsService.markLastStateChange).toHaveBeenCalledTimes(1);
    expect(sessionsService.markCompletionUnreviewed).not.toHaveBeenCalled();
  });

  it('does not persist a timestamp for duplicate statuses', async () => {
    await service.updateStatus(1, 'running');
    await service.updateStatus(1, 'running');

    expect(sessionsService.markLastStateChange).toHaveBeenCalledTimes(1);
  });

  it('ignores waiting when there was no prior running status', async () => {
    await service.updateStatus(1, 'waiting');

    expect(sessionsService.markLastStateChange).not.toHaveBeenCalled();
    expect(sessionsService.markCompletionUnreviewed).not.toHaveBeenCalled();
  });

  it('sets a running session back to idle on interrupt without marking completion', async () => {
    await service.updateStatus(1, 'running');
    await service.handleInterrupt(1);

    expect(service.getStatus(1)).toBe('idle');
    expect(sessionsService.markLastStateChange).toHaveBeenCalledTimes(2);
    expect(sessionsService.markCompletionUnreviewed).not.toHaveBeenCalled();
  });

  it('ignores duplicate interrupts while already idle', async () => {
    await service.handleInterrupt(1);
    await service.handleInterrupt(1);

    expect(service.getStatus(1)).toBe('idle');
    expect(sessionsService.markLastStateChange).toHaveBeenCalledTimes(1);
    expect(sessionsService.markCompletionUnreviewed).not.toHaveBeenCalled();
  });

  it('stores the Claude session id when SessionStart arrives', async () => {
    await service.handleHookEvent(42, {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      source: 'startup',
    });

    expect(sessionsService.updateClaudeSessionId).toHaveBeenCalledWith(
      42,
      'claude-session-1',
    );
    expect(sessionsService.markLastStateChange).not.toHaveBeenCalled();
  });

  it('replaces the stored Claude session id after a manual resume', async () => {
    await service.handleHookEvent(42, {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      source: 'startup',
    });
    await service.handleHookEvent(42, {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-2',
      source: 'resume',
    });

    expect(sessionsService.updateClaudeSessionId).toHaveBeenNthCalledWith(
      1,
      42,
      'claude-session-1',
    );
    expect(sessionsService.updateClaudeSessionId).toHaveBeenNthCalledWith(
      2,
      42,
      'claude-session-2',
    );
  });

  it('does not overwrite the stored Claude session id when the hook payload omits it', async () => {
    await service.handleHookEvent(42, {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session-1',
      source: 'startup',
    });
    await service.handleHookEvent(42, {
      hook_event_name: 'Stop',
    });

    expect(sessionsService.updateClaudeSessionId).toHaveBeenCalledTimes(1);
    expect(sessionsService.updateClaudeSessionId).toHaveBeenCalledWith(
      42,
      'claude-session-1',
    );
  });

  it('emits raw hook events for downstream runtime normalization', async () => {
    const listener = jest.fn();
    service.on('hook-event', listener);

    await service.handleHookEvent(9, {
      hook_event_name: 'SubagentStart',
      session_id: 'claude-session-9',
      agent_id: 'agent-1',
      agent_type: 'code-reviewer',
      cwd: '/tmp/project',
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 9,
        payload: expect.objectContaining({
          hook_event_name: 'SubagentStart',
          agent_id: 'agent-1',
          agent_type: 'code-reviewer',
          cwd: '/tmp/project',
        }),
        timestamp: expect.any(String),
      }),
    );
  });

  it('treats permission request hooks as waiting when a session is already running', async () => {
    await service.updateStatus(5, 'running');
    await service.handleHookEvent(5, {
      hook_event_name: 'PermissionRequest',
      session_id: 'claude-session-5',
    });

    expect(service.getStatus(5)).toBe('waiting');
  });

  it('ignores late hook events after a session is cleared', async () => {
    service.clearStatus(42);

    await service.handleHookEvent(42, {
      hook_event_name: 'Stop',
      session_id: 'claude-session-42',
    });

    expect(sessionsService.updateClaudeSessionId).not.toHaveBeenCalled();
    expect(sessionsService.markLastStateChange).not.toHaveBeenCalled();
  });
});
