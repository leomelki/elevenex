import { Test, TestingModule } from '@nestjs/testing';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

describe('SettingsController', () => {
  let controller: SettingsController;
  let settingsService: {
    findOne: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    settingsService = {
      findOne: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: SettingsService, useValue: settingsService },
      ],
    }).compile();

    controller = module.get(SettingsController);
  });

  it('returns app settings', async () => {
    settingsService.findOne.mockResolvedValue({
      defaultClaudeSessionSurface: 'claude-ui',
      createdAt: null,
      updatedAt: null,
    });

    await expect(controller.findOne()).resolves.toEqual({
      defaultClaudeSessionSurface: 'claude-ui',
      createdAt: null,
      updatedAt: null,
    });
  });

  it('updates app settings', async () => {
    settingsService.update.mockResolvedValue({
      defaultClaudeSessionSurface: 'tui',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      controller.update({ defaultClaudeSessionSurface: 'tui' }),
    ).resolves.toEqual({
      defaultClaudeSessionSurface: 'tui',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(settingsService.update).toHaveBeenCalledWith('tui');
  });
});
