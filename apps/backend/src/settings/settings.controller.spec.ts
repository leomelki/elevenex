import { Test, TestingModule } from '@nestjs/testing';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

describe('SettingsController', () => {
  let controller: SettingsController;
  let settingsService: {
    findOne: jest.Mock;
    update: jest.Mock;
    completeOnboarding: jest.Mock;
  };

  beforeEach(async () => {
    settingsService = {
      findOne: jest.fn(),
      update: jest.fn(),
      completeOnboarding: jest.fn(),
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
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: null,
      createdAt: null,
      updatedAt: null,
    });

    await expect(controller.findOne()).resolves.toEqual({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  it('updates app settings', async () => {
    settingsService.update.mockResolvedValue({
      defaultClaudeSessionSurface: 'tui',
      defaultAgentProvider: 'codex',
      sessionToolbarButtons: [{ id: 'terminal', visible: false }],
      onboardingCompletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      controller.update({
        defaultClaudeSessionSurface: 'tui',
        defaultAgentProvider: 'codex',
        sessionToolbarButtons: [{ id: 'terminal', visible: false }],
      }),
    ).resolves.toEqual({
      defaultClaudeSessionSurface: 'tui',
      defaultAgentProvider: 'codex',
      sessionToolbarButtons: [{ id: 'terminal', visible: false }],
      onboardingCompletedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(settingsService.update).toHaveBeenCalledWith({
      defaultClaudeSessionSurface: 'tui',
      defaultAgentProvider: 'codex',
      sessionToolbarButtons: [{ id: 'terminal', visible: false }],
    });
  });

  it('completes onboarding', async () => {
    settingsService.completeOnboarding.mockResolvedValue({
      defaultClaudeSessionSurface: 'tui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(
      controller.completeOnboarding({
        defaultAgentProvider: 'claude',
        defaultClaudeSessionSurface: 'tui',
      }),
    ).resolves.toMatchObject({
      defaultAgentProvider: 'claude',
      defaultClaudeSessionSurface: 'tui',
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(settingsService.completeOnboarding).toHaveBeenCalledWith({
      defaultAgentProvider: 'claude',
      defaultClaudeSessionSurface: 'tui',
    });
  });
});
