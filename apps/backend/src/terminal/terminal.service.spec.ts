import { TerminalService } from './terminal.service.js';

describe('TerminalService', () => {
  let service: TerminalService;
  let sessionsService: {
    findOne: jest.Mock;
    updateStatus: jest.Mock;
  };
  let ptyManager: {
    isAlive: jest.Mock;
    hasTmuxSession: jest.Mock;
    spawn: jest.Mock;
  };

  beforeEach(() => {
    sessionsService = {
      findOne: jest.fn(),
      updateStatus: jest.fn(),
    };

    ptyManager = {
      isAlive: jest.fn(),
      hasTmuxSession: jest.fn(),
      spawn: jest.fn(),
    };

    service = new TerminalService(
      sessionsService as never,
      ptyManager as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reattaches to an existing tmux session without spawning a fresh Claude resume', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 1,
      worktreePath: process.cwd(),
      claudeSessionId: 'claude-session-1',
    });
    ptyManager.isAlive.mockReturnValue(false);
    ptyManager.hasTmuxSession.mockReturnValue(true);
    ptyManager.spawn.mockImplementation(() => {});

    const result = await service.startSession(1);

    expect(ptyManager.spawn).toHaveBeenCalledWith(1, process.cwd());
    expect(result).toEqual({ success: true, resumed: true });
    expect(sessionsService.updateStatus).toHaveBeenCalledWith(1, 'active');
  });

  it('uses the stored Claude session id when tmux must be recreated', async () => {
    sessionsService.findOne.mockResolvedValue({
      id: 1,
      worktreePath: process.cwd(),
      claudeSessionId: 'claude-session-1',
    });
    ptyManager.isAlive
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    ptyManager.hasTmuxSession.mockReturnValue(false);
    ptyManager.spawn.mockImplementation(() => {});

    const result = await service.startSession(1);

    expect(ptyManager.spawn).toHaveBeenCalledWith(1, process.cwd(), 'claude-session-1');
    expect(result).toEqual({ success: true, resumed: true });
    expect(sessionsService.updateStatus).toHaveBeenCalledWith(1, 'active');
  });

  it('falls back to a fresh Claude session if resume exits immediately', async () => {
    jest.useFakeTimers();
    sessionsService.findOne.mockResolvedValue({
      id: 1,
      worktreePath: process.cwd(),
      claudeSessionId: 'claude-session-1',
    });
    ptyManager.isAlive
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    ptyManager.hasTmuxSession.mockReturnValue(false);
    ptyManager.spawn.mockImplementation(() => {});

    const resultPromise = service.startSession(1);
    await jest.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(ptyManager.spawn).toHaveBeenNthCalledWith(1, 1, process.cwd(), 'claude-session-1');
    expect(ptyManager.spawn).toHaveBeenNthCalledWith(2, 1, process.cwd());
    expect(result).toEqual({ success: true, resumed: false });
    expect(sessionsService.updateStatus).toHaveBeenCalledWith(1, 'active');
  });
});
