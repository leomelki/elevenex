import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router } from '@angular/router';

import { Onboarding } from './onboarding';
import { ProjectsService } from '@/shared/services/projects.service';
import { OnboardingConnectionService } from '@/shared/services/onboarding-connection.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { Project } from '@/shared/models/project.model';

describe('Onboarding', () => {
  const projectsServiceMock = {
    getAll: vi.fn(() => of([])),
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

  const snapshot: any = {
    mode: null,
    currentStep: 'choice' as const,
    activeServerId: null,
    projectHandoffAcknowledged: false,
    servers: [],
    lastSshDefaults: null,
  };

  const onboardingStateMock = {
    readSnapshot: vi.fn(() => snapshot),
    getActiveServer: vi.fn(() => null),
    setMode: vi.fn(),
    setCurrentStep: vi.fn(),
    markProjectHandoffAcknowledged: vi.fn(),
    saveServer: vi.fn(),
  };

  const routerMock = {
    navigate: vi.fn(() => Promise.resolve(true)),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [Onboarding],
      providers: [
        { provide: ProjectsService, useValue: projectsServiceMock },
        { provide: OnboardingConnectionService, useValue: onboardingConnectionMock },
        { provide: OnboardingStateService, useValue: onboardingStateMock },
        { provide: Router, useValue: routerMock },
      ],
    }).compileComponents();
  });

  it('should expose only the minimal ssh form before auth mode details are selected', async () => {
    onboardingStateMock.readSnapshot.mockReturnValue({
      ...snapshot,
      mode: 'ssh',
      currentStep: 'ssh',
    });

    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('SSH config / agent');
    expect(text).not.toContain('Passphrase');

    onboardingStateMock.readSnapshot.mockReturnValue(snapshot);
  });

  it('should show the missing install step when the forwarded backend is not reachable', async () => {
    onboardingConnectionMock.connect.mockResolvedValueOnce({
      kind: 'missing-install',
      message: 'Install Elevenex remotely first.',
    } as any);

    const fixture = TestBed.createComponent(Onboarding);
    const component = fixture.componentInstance;
    component.selectedMode.set('ssh');
    component.activeStep.set('ssh');
    component.sshHost.set('server.example.com');
    fixture.detectChanges();
    await fixture.whenStable();

    await component.connectToServer();

    expect(component.activeStep()).toBe('install');
    expect(component.installMessage()).toContain('Install Elevenex remotely first.');
  });

  it('should render the first-project wizard on the project step', async () => {
    onboardingStateMock.readSnapshot.mockReturnValue({
      ...snapshot,
      mode: 'local',
      currentStep: 'project',
      projectHandoffAcknowledged: false,
    });

    const fixture = TestBed.createComponent(Onboarding);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Create your first project');
    expect(fixture.nativeElement.textContent).not.toContain('Port forwards');
    expect(fixture.nativeElement.textContent).not.toContain('optional save any forwarded ports');

    onboardingStateMock.readSnapshot.mockReturnValue(snapshot);
  });

  it('should mark onboarding complete after the first project is created', async () => {
    const fixture = TestBed.createComponent(Onboarding);
    const component = fixture.componentInstance;
    const project: Project = {
      id: 7,
      name: 'Alpha',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };

    await component.handleProjectCreated(project);

    expect(onboardingStateMock.markProjectHandoffAcknowledged).toHaveBeenCalled();
    expect(routerMock.navigate).toHaveBeenCalledWith(['/projects', 7]);
  });
});
