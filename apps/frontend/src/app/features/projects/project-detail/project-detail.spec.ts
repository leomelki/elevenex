import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { describe, beforeEach, afterEach, expect, it, vi } from 'vitest';

import { ProjectDetail } from './project-detail';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { ModalOverlayStateService } from '@/shared/services/modal-overlay-state.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { PathAutocompleteService } from '@/shared/services/path-autocomplete.service';
import { ProductivityStateService } from '@/features/productivity/productivity-state.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { ReposService } from '@/shared/services/repos.service';
import { SshForwardsService } from '@/shared/services/ssh-forwards.service';
import { Repo } from '@/shared/models/repo.model';
import { SshForward } from '@/shared/models/ssh-forward.model';
import { AgentControlStateService } from '@/features/agent-control/agent-control-state.service';

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

const repos: Repo[] = [
  {
    id: 10,
    projectId: 1,
    name: 'api',
    path: '/work/api',
    preferredContextRootRef: 'origin/main',
    createdAt: '2026-01-03T00:00:00Z',
  },
];

const forwards: SshForward[] = [
  {
    id: 20,
    projectId: 1,
    name: 'App',
    sshHost: 'server.example.com',
    sshPort: 22,
    sshUser: 'deploy',
    bindAddress: '127.0.0.1',
    localPort: 3000,
    remoteHost: '127.0.0.1',
    remotePort: 3000,
    createdAt: '2026-01-04T00:00:00Z',
    updatedAt: '2026-01-04T00:00:00Z',
    status: 'active',
    pid: 1234,
    startedAt: '2026-01-04T00:00:00Z',
    stoppedAt: null,
    lastError: null,
    debugDetails: null,
    destinationLabel: '127.0.0.1:3000 -> 127.0.0.1:3000',
    connectionLabel: 'deploy@server.example.com:22',
  },
];

describe('ProjectDetail', () => {
  let originalLocalStorage: Storage | undefined;

  const paramMap = new BehaviorSubject(convertToParamMap({ id: '1' }));
  const fragment = new BehaviorSubject<string | null>(null);
  const navigate = vi.fn(() => Promise.resolve(true));
  const navigateByUrl = vi.fn(() => Promise.resolve(true));
  const projectsServiceMock = {
    getOne: vi.fn(() => of(project)),
    delete: vi.fn(() => of(project)),
  };
  const reposServiceMock = {
    getByProject: vi.fn(() => of(repos)),
    add: vi.fn(),
    remove: vi.fn(() => of(undefined)),
    updatePreferredContextRootRef: vi.fn(() => of({ ...repos[0], preferredContextRootRef: 'origin/develop' })),
  };
  const sshForwardsServiceMock = {
    isSupported: vi.fn(() => Promise.resolve(true)),
    getByProject: vi.fn(() => of(forwards)),
    getLastDefaults: vi.fn(() => null),
    start: vi.fn(() => of({ ...forwards[0], status: 'active' as const })),
    stop: vi.fn(() => of({ ...forwards[0], status: 'inactive' as const })),
    create: vi.fn(),
    remove: vi.fn(() => of(undefined)),
  };
  const browserIsolationServiceMock = {
    get: vi.fn(() => of({ projectId: 1, mode: 'shared' as const, sharedGlobs: [] })),
    save: vi.fn((projectId: number, mode: 'shared' | 'isolated', sharedGlobs: string[]) =>
      of({ projectId, mode, sharedGlobs }),
    ),
  };
  const productivityStateMock = {
    getPanelState: vi.fn(() => ({ scratchpad: false, todos: false })),
    togglePanel: vi.fn(),
  };

  beforeEach(async () => {
    paramMap.next(convertToParamMap({ id: '1' }));
    fragment.next(null);
    vi.clearAllMocks();

    originalLocalStorage = globalThis.localStorage;
    const localValues = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => localValues.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => localValues.set(key, value)),
        removeItem: vi.fn((key: string) => localValues.delete(key)),
        clear: vi.fn(() => localValues.clear()),
      },
    });

    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() {
        this.open = false;
      },
    });

    await TestBed.configureTestingModule({
      imports: [ProjectDetail],
      providers: [
        { provide: ProjectsService, useValue: projectsServiceMock },
        { provide: ReposService, useValue: reposServiceMock },
        { provide: SshForwardsService, useValue: sshForwardsServiceMock },
        { provide: BrowserIsolationService, useValue: browserIsolationServiceMock },
        { provide: ProductivityStateService, useValue: productivityStateMock },
        {
          provide: Router,
          useValue: {
            navigate,
            navigateByUrl,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            paramMap: paramMap.asObservable(),
            fragment: fragment.asObservable(),
          },
        },
        {
          provide: NavigationService,
          useValue: {
            refreshTree: vi.fn(),
            revealProject: vi.fn(),
          },
        },
        {
          provide: OnboardingStateService,
          useValue: {
            readSnapshot: vi.fn(() => ({ remoteConnectionReady: false })),
            getActiveServer: vi.fn(() => null),
          },
        },
        {
          provide: PathAutocompleteService,
          useValue: {
            suggestPaths: vi.fn(() => of([])),
          },
        },
        {
          provide: ModalOverlayStateService,
          useValue: {
            openModal: vi.fn(() => vi.fn()),
          },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(ProjectDetail);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('loads the project, defaults to repositories, and omits GitHub diagnostics', async () => {
    const fixture = await render();

    expect(fixture.componentInstance.activeSection()).toBe('repos');
    expect(fixture.nativeElement.textContent).toContain('Platform');
    expect(fixture.nativeElement.textContent).toContain('api');
    expect(fixture.nativeElement.textContent).not.toContain('GitHub Diagnostics');
  });

  it('maps the SSH fragment to the SSH forwarding section', async () => {
    fragment.next('ssh-forwarding');

    const fixture = await render();

    expect(fixture.componentInstance.activeSection()).toBe('ssh');
    expect(fixture.nativeElement.textContent).toContain('SSH Port Forwarding');
    expect(fixture.nativeElement.textContent).toContain('App');
    expect(fixture.nativeElement.textContent).toContain('Live');
  });

  it('opens the app-wide agent drawer with the current project context', async () => {
    const fixture = await render();

    const button = fixture.nativeElement.querySelector(
      '[aria-label="Open agent drawer"]',
    ) as HTMLButtonElement;
    button.click();

    const agentControl = TestBed.inject(AgentControlStateService);
    expect(agentControl.isOpen()).toBe(true);
    expect(agentControl.context()).toMatchObject({
      kind: 'project',
      projectId: 1,
      projectName: 'Platform',
    });
  });

  it('updates the fragment when switching sections', async () => {
    const fixture = await render();

    const browserTab = fixture.debugElement
      .queryAll(By.css('.project-section-tabs button'))
      .find(button => button.nativeElement.textContent.includes('Browser Isolation'))!
      .nativeElement as HTMLButtonElement;
    browserTab.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.activeSection()).toBe('browser');
    expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ fragment: 'browser-settings' }));
  });

  it('saves repository default context roots and removes repositories', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;

    component.updateRepoContextRootDraft(repos[0].id, 'origin/develop');
    await component.saveRepoContextRoot(repos[0]);

    expect(reposServiceMock.updatePreferredContextRootRef).toHaveBeenCalledWith(10, 'origin/develop');

    component.showRemoveRepoDialog.set(repos[0]);
    component.removeRepo();

    expect(reposServiceMock.remove).toHaveBeenCalledWith(10);
  });

  it('renders SSH forward actions and toggles active forwards', async () => {
    fragment.next('ssh-forwarding');
    const fixture = await render();

    const stopButton = fixture.debugElement
      .queryAll(By.css('button'))
      .find(button => button.nativeElement.textContent.includes('Stop'))!
      .nativeElement as HTMLButtonElement;
    stopButton.click();

    expect(sshForwardsServiceMock.stop).toHaveBeenCalledWith(20);
  });

  it('changes browser isolation mode through the compact control', async () => {
    fragment.next('browser-settings');
    const fixture = await render();

    const isolatedButton = fixture.debugElement
      .queryAll(By.css('.browser-mode-option'))
      .find(button => button.nativeElement.textContent.includes('Isolated'))!
      .nativeElement as HTMLButtonElement;
    isolatedButton.click();

    expect(browserIsolationServiceMock.save).toHaveBeenCalledWith(1, 'isolated', []);
  });
});
