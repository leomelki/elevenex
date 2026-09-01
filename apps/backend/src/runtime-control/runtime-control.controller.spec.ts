import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RuntimeControlController } from './runtime-control.controller.js';
import { RuntimeControlService } from './runtime-control.service.js';

describe('RuntimeControlController', () => {
  let controller: RuntimeControlController;
  let runtimeControl: {
    getStatus: jest.Mock;
    isRestartSupported: jest.Mock;
    requestRestart: jest.Mock;
  };

  beforeEach(async () => {
    runtimeControl = {
      getStatus: jest.fn(),
      isRestartSupported: jest.fn(),
      requestRestart: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RuntimeControlController],
      providers: [{ provide: RuntimeControlService, useValue: runtimeControl }],
    }).compile();

    controller = module.get(RuntimeControlController);
  });

  it('returns the runtime status', () => {
    const status = {
      restartSupported: true,
      restarting: false,
      pid: 42,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    runtimeControl.getStatus.mockReturnValue(status);

    expect(controller.getStatus()).toEqual(status);
  });

  it('accepts a restart when a launcher supervises the backend', () => {
    const status = {
      restartSupported: true,
      restarting: true,
      pid: 42,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    runtimeControl.isRestartSupported.mockReturnValue(true);
    runtimeControl.requestRestart.mockReturnValue(status);

    expect(controller.restart()).toEqual(status);
  });

  it('refuses a restart that nothing would recover from', () => {
    runtimeControl.isRestartSupported.mockReturnValue(false);

    expect(() => controller.restart()).toThrow(ServiceUnavailableException);
    expect(runtimeControl.requestRestart).not.toHaveBeenCalled();
  });
});
