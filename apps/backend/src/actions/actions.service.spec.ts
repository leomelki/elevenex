import { BadRequestException } from '@nestjs/common';
import { ActionsService } from './actions.service.js';

describe('ActionsService', () => {
  let service: ActionsService;
  let ptyManager: {
    registerPersistence: jest.Mock;
    isRunning: jest.Mock;
    start: jest.Mock;
    reserveIdleAction: jest.Mock;
  };

  beforeEach(() => {
    ptyManager = {
      registerPersistence: jest.fn(),
      isRunning: jest.fn(() => false),
      start: jest.fn(),
      reserveIdleAction: jest.fn(() => jest.fn()),
    };
    service = new ActionsService({} as never, ptyManager as never);
  });

  it('maps duplicate async starts to the same already-running response as the pre-check', async () => {
    jest.spyOn(service, 'findOne').mockResolvedValue({
      id: 12,
      worktreePath: '/repo/worktree',
      command: 'pnpm test',
      name: 'Tests',
      status: 'idle',
    } as never);
    ptyManager.start.mockRejectedValue(
      new Error('Action 12 is already running'),
    );

    let caught: unknown;
    try {
      await service.run(12);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as Error).message).toBe('Action "Tests" is already running');
  });
  it('releases delete ownership if loading the action fails', async () => {
    const release = jest.fn();
    ptyManager.reserveIdleAction.mockReturnValue(release);
    jest.spyOn(service, 'findOne').mockRejectedValue(new Error('missing'));
    await expect(service.remove(12)).rejects.toThrow('missing');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
