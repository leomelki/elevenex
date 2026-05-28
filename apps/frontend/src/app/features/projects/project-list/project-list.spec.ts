import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { describe, beforeEach, expect, it, vi } from 'vitest';

import { ProjectList } from './project-list';
import { NavigationService } from '@/shared/services/navigation.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { PathAutocompleteService } from '@/shared/services/path-autocomplete.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { ReposService } from '@/shared/services/repos.service';
import { SshForwardsService } from '@/shared/services/ssh-forwards.service';

const projects = [
  { id: 1, name: 'Platform', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-05T00:00:00Z' },
  { id: 2, name: 'Storefront', createdAt: '2026-02-02T00:00:00Z', updatedAt: '2026-02-05T00:00:00Z' },
];

describe('ProjectList', () => {
  const queryParamMap = new BehaviorSubject(convertToParamMap({}));
  const navigate = vi.fn(() => Promise.resolve(true));
  const projectsServiceMock = {
    getAll: vi.fn(() => of(projects)),
    create: vi.fn(),
  };

  beforeEach(async () => {
    queryParamMap.next(convertToParamMap({}));
    vi.clearAllMocks();
    projectsServiceMock.getAll.mockReturnValue(of(projects));

    await TestBed.configureTestingModule({
      imports: [ProjectList],
      providers: [
        { provide: ProjectsService, useValue: projectsServiceMock },
        {
          provide: Router,
          useValue: {
            navigate,
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            queryParamMap: queryParamMap.asObservable(),
          },
        },
        {
          provide: OnboardingStateService,
          useValue: {
            snapshotState: () => ({
              mode: 'local',
            }),
          },
        },
        {
          provide: ReposService,
          useValue: {
            add: vi.fn(),
          },
        },
        {
          provide: SshForwardsService,
          useValue: {
            getLastDefaults: vi.fn(() => null),
            isSupported: vi.fn(() => Promise.resolve(false)),
            create: vi.fn(),
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
          provide: PathAutocompleteService,
          useValue: {
            suggestPaths: vi.fn(() => of([])),
          },
        },
      ],
    }).compileComponents();
  });

  it('renders a compact row for each loaded project', () => {
    const fixture = TestBed.createComponent(ProjectList);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('2 configured workspaces');
    expect(fixture.nativeElement.textContent).toContain('Platform');
    expect(fixture.nativeElement.textContent).toContain('Storefront');
    expect(fixture.nativeElement.textContent).toContain('Updated');
  });

  it('renders loading skeleton rows before projects resolve', () => {
    const pendingProjects = new Subject<typeof projects>();
    projectsServiceMock.getAll.mockReturnValue(pendingProjects.asObservable());

    const fixture = TestBed.createComponent(ProjectList);
    fixture.detectChanges();

    expect(fixture.debugElement.queryAll(By.css('z-skeleton')).length).toBeGreaterThan(0);

    pendingProjects.next(projects);
    pendingProjects.complete();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Platform');
  });

  it('filters projects locally and shows a no-results state', () => {
    const fixture = TestBed.createComponent(ProjectList);
    fixture.detectChanges();

    const input = fixture.debugElement.query(By.css('input[type="search"]')).nativeElement as HTMLInputElement;
    input.value = 'platform';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Platform');
    expect(fixture.nativeElement.textContent).not.toContain('Storefront');

    input.value = 'missing';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No matching projects');
  });

  it('renders the compact empty state when no projects exist', () => {
    projectsServiceMock.getAll.mockReturnValue(of([]));

    const fixture = TestBed.createComponent(ProjectList);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No projects yet');
    expect(fixture.nativeElement.textContent).toContain('Create project');
  });

  it('opens the create wizard from the query param', async () => {
    queryParamMap.next(convertToParamMap({ create: '1' }));

    const fixture = TestBed.createComponent(ProjectList);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Create a project');
  });

  it('navigates to the selected project', () => {
    const fixture = TestBed.createComponent(ProjectList);
    fixture.detectChanges();

    const row = fixture.debugElement.queryAll(By.css('button'))[1].nativeElement as HTMLButtonElement;
    row.click();

    expect(navigate).toHaveBeenCalledWith(['/projects', 1]);
  });
});
