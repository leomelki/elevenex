import { NotFoundException } from '@nestjs/common';
// Standby DI transitively imports the ESM Claude SDK.
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: jest.fn(),
  getSubagentMessages: jest.fn(),
  getSessionMessages: jest.fn(),
  query: jest.fn(),
}));
import { ElevenexAgentMissionsService } from './elevenex-agent-missions.service.js';

describe('ElevenexAgentMissionsService', () => {
  const makeBag = (defaultProvider = 'claude') => {
    const agentService = {
      ensureAgentRepo: jest
        .fn()
        .mockResolvedValue({ projectId: 1, repoId: 7, worktreePath: '/ws' }),
    };
    // Standby returns no warm session so tests exercise the cold-start path.
    const standby = {
      claimStandby: jest.fn().mockReturnValue(null),
      scheduleStandby: jest.fn(),
    };
    const sessionsService = {
      create: jest.fn().mockResolvedValue({ id: 42, name: 'Do a thing' }),
      update: jest.fn().mockResolvedValue({}),
      updateAgentAutonomyMode: jest.fn().mockResolvedValue({}),
      findBySurface: jest.fn(),
      // getMission() (called at the end of createMission) resolves the freshly
      // created agent session via findOne; default it to a valid mission row.
      findOne: jest.fn().mockResolvedValue({
        id: 42,
        name: 'Do a thing',
        surface: 'agent',
        activeAgentProvider: defaultProvider,
        status: 'active',
        agentAutonomyMode: 'plan',
        repoId: 7,
        worktreePath: '/ws',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      start: jest.fn().mockResolvedValue({ success: true }),
      archiveAndStop: jest.fn().mockResolvedValue({}),
    };
    const tokenService = {
      ensureToken: jest.fn().mockResolvedValue('evx_token'),
    };
    const claudeRuntime = {
      setAgentAutonomy: jest.fn().mockResolvedValue({}),
      setSelectedModel: jest.fn().mockResolvedValue({}),
      submitPrompt: jest.fn().mockResolvedValue(undefined),
      interrupt: jest.fn().mockResolvedValue(undefined),
      getRuntimeState: jest.fn().mockResolvedValue({
        runPhase: 'running',
        pendingPermissionRequest: null,
        pendingUserInputRequest: null,
      }),
    };
    const runtimes = { getProvider: jest.fn(() => claudeRuntime) };
    const settings = {
      findOne: jest
        .fn()
        .mockResolvedValue({ defaultAgentProvider: defaultProvider }),
    };
    const agentFocus = {
      record: jest.fn(),
      get: jest.fn(),
      clear: jest.fn(),
    };
    const service = new ElevenexAgentMissionsService(
      agentService as never,
      standby as never,
      sessionsService as never,
      tokenService as never,
      runtimes as never,
      agentFocus as never,
      settings as never,
    );
    return {
      service,
      agentService,
      standby,
      sessionsService,
      tokenService,
      claudeRuntime,
      agentFocus,
      runtimes,
      settings,
    };
  };

  it('createMission provisions, mints a token, persists autonomy, starts, prompts', async () => {
    const bag = makeBag();
    const handle = await bag.service.createMission({
      prompt: 'Do a thing\nmore detail',
      autonomyMode: 'plan',
      focusedSessionId: 7,
    });

    expect(bag.agentService.ensureAgentRepo).toHaveBeenCalled();
    expect(bag.sessionsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 7,
        worktreePath: '/ws',
        surface: 'agent',
        activeAgentProvider: 'claude',
        name: 'Do a thing',
      }),
    );
    expect(bag.tokenService.ensureToken).toHaveBeenCalledWith(42);
    expect(bag.sessionsService.updateAgentAutonomyMode).toHaveBeenCalledWith(
      42,
      'plan',
    );
    expect(bag.claudeRuntime.setAgentAutonomy).toHaveBeenCalledWith(42, 'plan');
    expect(bag.sessionsService.start).toHaveBeenCalledWith(42);
    expect(bag.claudeRuntime.submitPrompt).toHaveBeenCalledWith(
      42,
      'Do a thing\nmore detail',
    );
    // Focus is recorded out-of-band (not concatenated into the prompt).
    expect(bag.agentFocus.record).toHaveBeenCalledWith(42, 7);
    expect(handle).toMatchObject({ sessionId: 42, deepLink: '/sessions/42' });
  });

  it('createMission defaults autonomy to review and does not set a model unless provided', async () => {
    const bag = makeBag();
    await bag.service.createMission({ prompt: 'hello' });
    expect(bag.sessionsService.updateAgentAutonomyMode).toHaveBeenCalledWith(
      42,
      'review',
    );
    expect(bag.claudeRuntime.setSelectedModel).not.toHaveBeenCalled();
  });

  it('createMission sets the model when provided', async () => {
    const bag = makeBag();
    await bag.service.createMission({ prompt: 'hi', model: 'claude-opus-4-8' });
    expect(bag.claudeRuntime.setSelectedModel).toHaveBeenCalledWith(
      42,
      'claude-opus-4-8',
    );
  });

  it.each(['pi', 'codex'])(
    'launches missions using the %s default',
    async (provider) => {
      const bag = makeBag(provider);
      const mission = await bag.service.createMission({
        prompt: 'hello',
        autonomyMode: 'full',
      });
      expect(bag.sessionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ activeAgentProvider: provider }),
      );
      expect(bag.standby.claimStandby).toHaveBeenCalledWith('full', provider);
      expect(bag.standby.scheduleStandby).toHaveBeenCalledWith(
        'full',
        provider,
      );
      expect(bag.runtimes.getProvider).toHaveBeenCalledWith(provider);
      expect(bag.claudeRuntime.setAgentAutonomy).toHaveBeenCalledWith(
        42,
        'full',
      );
      expect(bag.claudeRuntime.submitPrompt).toHaveBeenCalledWith(42, 'hello');
      expect(mission.activeAgentProvider).toBe(provider);
    },
  );

  it('keeps existing missions on their persisted provider after defaults change', async () => {
    const bag = makeBag('pi');
    bag.settings.findOne.mockResolvedValue({ defaultAgentProvider: 'codex' });
    await bag.service.setAutonomy(42, 'full');
    await bag.service.interruptMission(42);
    expect(bag.runtimes.getProvider).toHaveBeenCalledWith('pi');
    expect(bag.runtimes.getProvider).not.toHaveBeenCalledWith('codex');
    expect(bag.claudeRuntime.interrupt).toHaveBeenCalledWith(42);
  });

  it('reuses the Claude standby without creating another mission session', async () => {
    const bag = makeBag();
    bag.standby.claimStandby.mockReturnValue(42);
    await bag.service.createMission({ prompt: 'hello', model: 'opus' });
    expect(bag.sessionsService.create).not.toHaveBeenCalled();
    expect(bag.claudeRuntime.setSelectedModel).toHaveBeenCalledWith(42, 'opus');
    expect(bag.claudeRuntime.submitPrompt).toHaveBeenCalledWith(42, 'hello');
  });

  it('listMissions maps agent sessions to summaries, newest first', async () => {
    const bag = makeBag();
    bag.sessionsService.findBySurface.mockResolvedValue([
      {
        id: 1,
        name: 'Old',
        status: 'active',
        agentAutonomyMode: 'review',
        repoId: 7,
        worktreePath: '/ws',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        name: 'New',
        status: 'active',
        agentAutonomyMode: 'full',
        repoId: 7,
        worktreePath: '/ws',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
    const list = await bag.service.listMissions();
    expect(bag.sessionsService.findBySurface).toHaveBeenCalledWith('agent');
    expect(list.map((m) => m.sessionId)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({
      title: 'New',
      autonomyMode: 'full',
      runPhase: 'running',
      deepLink: '/sessions/2',
    });
  });

  it('guards mission operations against non-agent sessions', async () => {
    const bag = makeBag();
    bag.sessionsService.findOne.mockResolvedValue({
      id: 99,
      surface: 'session',
    });
    await expect(bag.service.getMission(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(bag.service.interruptMission(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
