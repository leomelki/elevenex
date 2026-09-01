import { Test, TestingModule } from '@nestjs/testing';
import {
  BACKEND_RESTART_EXIT_CODE,
  RuntimeControlService,
} from './runtime-control.service.js';

describe('RuntimeControlService', () => {
  let service: RuntimeControlService;
  let exitSpy: jest.SpyInstance;
  const originalSupervised = process.env.ELEVENEX_BACKEND_SUPERVISED;

  beforeEach(async () => {
    jest.useFakeTimers();
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [RuntimeControlService],
    }).compile();

    service = module.get(RuntimeControlService);
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
    if (originalSupervised === undefined) {
      delete process.env.ELEVENEX_BACKEND_SUPERVISED;
    } else {
      process.env.ELEVENEX_BACKEND_SUPERVISED = originalSupervised;
    }
  });

  it('reports restart support from the launcher marker', () => {
    delete process.env.ELEVENEX_BACKEND_SUPERVISED;
    expect(service.getStatus().restartSupported).toBe(false);

    process.env.ELEVENEX_BACKEND_SUPERVISED = '1';
    expect(service.getStatus()).toMatchObject({
      restartSupported: true,
      restarting: false,
      pid: process.pid,
    });
  });

  it('closes the application and exits with the restart code', async () => {
    process.env.ELEVENEX_BACKEND_SUPERVISED = '1';
    const close = jest.fn().mockResolvedValue(undefined);
    service.bindApplication({ close });

    expect(service.requestRestart().restarting).toBe(true);
    expect(close).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(250);

    expect(close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(BACKEND_RESTART_EXIT_CODE);
  });

  it('exits anyway when shutdown hooks hang', async () => {
    process.env.ELEVENEX_BACKEND_SUPERVISED = '1';
    service.bindApplication({ close: () => new Promise<void>(() => {}) });

    service.requestRestart();
    await jest.advanceTimersByTimeAsync(250);
    expect(exitSpy).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3000);

    expect(exitSpy).toHaveBeenCalledWith(BACKEND_RESTART_EXIT_CODE);
  });

  it('ignores a restart request when nothing supervises the process', () => {
    delete process.env.ELEVENEX_BACKEND_SUPERVISED;

    expect(service.requestRestart().restarting).toBe(false);
    jest.runOnlyPendingTimers();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('only schedules one exit for repeated requests', async () => {
    process.env.ELEVENEX_BACKEND_SUPERVISED = '1';
    const close = jest.fn().mockResolvedValue(undefined);
    service.bindApplication({ close });

    service.requestRestart();
    service.requestRestart();
    await jest.advanceTimersByTimeAsync(250);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
