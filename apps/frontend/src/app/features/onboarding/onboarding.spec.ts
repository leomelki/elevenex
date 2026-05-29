import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router } from '@angular/router';

import { Onboarding } from './onboarding';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';

describe('Onboarding', () => {
  const snapshot: any = {
    mode: 'local',
    currentStep: 'project' as const,
    activeServerId: null,
    remoteConnectionReady: true,
    projectHandoffAcknowledged: false,
    servers: [],
    lastSshDefaults: null,
  };

  const appSettingsMock = {
    load: vi.fn(),
    completeOnboarding: vi.fn(),
    saving: signal(false),
  };

  const onboardingConnectionMock = {
    isSupported: vi.fn(async () => true),
    pickIdentityFile: vi.fn(async () => '/tmp/id_ed25519'),
    connect: vi.fn(async (): Promise<any> => ({
      kind: 'success' as const,
      serverId: 99,
      localPort: 4310,
      installStatus: 'available' as const,
    })),
  };

  const onboardingStateMock = {
    readSnapshot: vi.fn(() => snapshot),
    getActiveServer: vi.fn(() => null),
    setMode: vi.fn(),
    setCurrentStep: vi.fn(),
    saveServer: vi.fn(),
  };

  const routerMock = {
    navigate: vi.fn(() => Promise.resolve(true)),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    appSettingsMock.saving.set(false);
    appSettingsMock.load.mockResolvedValue({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: null,
      createdAt: null,
      updatedAt: null,
    });
    appSettingsMock.completeOnboarding.mockResolvedValue({
      defaultClaudeSessionSurface: 'claude-ui',
      defaultAgentProvider: 'claude',
      sessionToolbarButtons: null,
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
      createdAt: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    onboardingStateMock.readSnapshot.mockReturnValue(snapshot);

    await TestBed.configureTestingModule({
      imports: [Onboarding],
      providers: [
        { provide: AppSettingsService, useValue: appSettingsMock },
        { provide: OnboardingConnectionService, useValue: onboardingConnectionMock },
        { provide: OnboardingStateService, useValue: onboardingStateMock },
        { provide: Router, useValue: routerMock },
      ],
    }).compileComponents();
  });

  async function settleOnboarding(fixture: ComponentFixture<Onboarding>) {
    await fixture.whenStable();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    fixture.detectChanges();
  }

  it('shows the backend-scoped default agent step after a backend is connected', async () => {
    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await settleOnboarding(fixture);

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Choose the agent for new sessions.');
    expect(text).toContain('Claude');
    expect(text).toContain('Codex');
    expect(text).toContain('Pi');
  });

  it('asks for Claude UI versus TUI only after Claude is selected', async () => {
    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await settleOnboarding(fixture);

    fixture.componentInstance.continueFromAgent();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Choose how Claude opens.');
    expect(text).toContain('Claude UI uses API pricing');
    expect(text).toContain('Claude TUI uses your plan quota');
  });

  it('skips the Claude surface choice and shows the quota reminder for Codex', async () => {
    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await settleOnboarding(fixture);

    fixture.componentInstance.selectAgent('codex');
    fixture.componentInstance.continueFromAgent();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Your default agent is Codex.');
    expect(text).toContain('Codex and Pi do not have a separate UI/TUI setting');
    expect(text).toContain('Claude TUI uses your plan quota');
    expect(text).not.toContain('Choose how Claude opens.');
  });

  it('finishes onboarding with the selected Claude surface', async () => {
    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await settleOnboarding(fixture);

    fixture.componentInstance.selectSurface('tui');
    await fixture.componentInstance.finishOnboarding();

    expect(appSettingsMock.completeOnboarding).toHaveBeenCalledWith({
      defaultAgentProvider: 'claude',
      defaultClaudeSessionSurface: 'tui',
    });
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects']);
  });

  it('finishes onboarding for non-Claude agents without a Claude surface payload', async () => {
    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await settleOnboarding(fixture);

    fixture.componentInstance.selectAgent('pi');
    await fixture.componentInstance.finishOnboarding();

    expect(appSettingsMock.completeOnboarding).toHaveBeenCalledWith({
      defaultAgentProvider: 'pi',
      defaultClaudeSessionSurface: undefined,
    });
  });
});
