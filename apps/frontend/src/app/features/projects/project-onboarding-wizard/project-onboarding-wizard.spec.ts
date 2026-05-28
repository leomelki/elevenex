import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, beforeEach, expect, it, vi } from 'vitest';

import { ProjectOnboardingWizard } from './project-onboarding-wizard';
import { NavigationService } from '@/shared/services/navigation.service';
import { PathAutocompleteService } from '@/shared/services/path-autocomplete.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { ReposService } from '@/shared/services/repos.service';
import { SshForwardsService } from '@/shared/services/ssh-forwards.service';

vi.mock('ngx-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const project = {
  id: 1,
  name: 'Platform',
  createdAt: '2026-01-02T00:00:00Z',
  updatedAt: '2026-01-05T00:00:00Z',
};

const repo = {
  id: 10,
  projectId: 1,
  name: 'api',
  path: '/work/api',
  preferredContextRootRef: null,
  createdAt: '2026-01-03T00:00:00Z',
};

const forward = {
  id: 20,
  projectId: 1,
  name: 'Port 3000',
  sshHost: 'server.example.com',
  sshPort: 22,
  sshUser: 'deploy',
  bindAddress: '127.0.0.1',
  localPort: 3000,
  remoteHost: '127.0.0.1',
  remotePort: 3000,
  createdAt: '2026-01-04T00:00:00Z',
  updatedAt: '2026-01-04T00:00:00Z',
  status: 'active' as const,
  pid: 1234,
  startedAt: '2026-01-04T00:00:00Z',
  stoppedAt: null,
  lastError: null,
  debugDetails: null,
  destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
  connectionLabel: 'deploy@server.example.com:22',
};

describe('ProjectOnboardingWizard', () => {
  const projectsServiceMock = {
    create: vi.fn(() => of(project)),
  };
  const reposServiceMock = {
    add: vi.fn(() => of(repo)),
  };
  const sshForwardsServiceMock = {
    getLastDefaults: vi.fn(() => ({
      sshHost: 'server.example.com',
      sshUser: 'deploy',
      sshPort: 22,
      bindAddress: '127.0.0.1',
      remoteHost: '127.0.0.1',
      startImmediately: true,
    })),
    isSupported: vi.fn(() => Promise.resolve(true)),
    create: vi.fn(() => of(forward)),
  };
  const navigationServiceMock = {
    refreshTree: vi.fn(),
    revealProject: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [ProjectOnboardingWizard],
      providers: [
        { provide: ProjectsService, useValue: projectsServiceMock },
        { provide: ReposService, useValue: reposServiceMock },
        { provide: SshForwardsService, useValue: sshForwardsServiceMock },
        { provide: NavigationService, useValue: navigationServiceMock },
        {
          provide: PathAutocompleteService,
          useValue: {
            suggestPaths: vi.fn(() => of([])),
          },
        },
      ],
    }).compileComponents();
  });

  async function render(inputs: Partial<{
    embedded: boolean;
    showPortForwardStep: boolean;
  }> = {}) {
    const fixture = TestBed.createComponent(ProjectOnboardingWizard);
    for (const [key, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(key, value);
    }
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('advances through project, repository, and review without port forwards', async () => {
    const fixture = await render({ showPortForwardStep: false });
    const component = fixture.componentInstance;
    const completed = vi.fn();
    component.completed.subscribe(completed);

    expect(component.canAdvance()).toBe(false);

    component.updateProjectName('Platform');
    component.goToNextStep();
    expect(component.activeStep()).toBe('repos');
    expect(component.canAdvance()).toBe(false);

    component.updateRepoPath(component.repos()[0].id, '/work/api');
    expect(component.canAdvance()).toBe(true);
    component.goToNextStep();
    expect(component.activeStep()).toBe('review');

    await component.submit();

    expect(projectsServiceMock.create).toHaveBeenCalledWith('Platform');
    expect(reposServiceMock.add).toHaveBeenCalledWith(1, '/work/api');
    expect(navigationServiceMock.refreshTree).toHaveBeenCalled();
    expect(completed).toHaveBeenCalledWith(project);
  });

  it('keeps port forwards optional but validates added forwards', async () => {
    const fixture = await render({ showPortForwardStep: true });
    const component = fixture.componentInstance;

    component.updateProjectName('Platform');
    component.goToNextStep();
    component.updateRepoPath(component.repos()[0].id, '/work/api');
    component.goToNextStep();

    expect(component.activeStep()).toBe('ports');
    expect(component.canAdvance()).toBe(true);

    component.addForwardRow();
    expect(component.forwards()[0].sshHost).toBe('server.example.com');
    expect(component.canAdvance()).toBe(true);

    component.goToNextStep();
    await component.submit();

    expect(sshForwardsServiceMock.create).toHaveBeenCalledWith(1, expect.objectContaining({
      name: 'Port 3000',
      localPort: 3000,
      remotePort: 3000,
    }));
  });

  it('supports embedded rendering and cancellation output', async () => {
    const fixture = await render({ embedded: true });
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    expect(fixture.nativeElement.querySelector('.project-wizard-shell--embedded')).not.toBeNull();

    fixture.componentInstance.close();

    expect(cancelled).toHaveBeenCalled();
  });
});
