import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, Subject, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectCreateComponent } from './project-create.component';
import { NavigationService } from '@/shared/services/navigation.service';
import { OnboardingStateService } from '@/shared/services/onboarding-state.service';
import { PathAutocompleteService } from '@/shared/services/path-autocomplete.service';
import { ProjectsService } from '@/shared/services/projects.service';
import { ReposService } from '@/shared/services/repos.service';

vi.mock('ngx-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const project = { id: 1, name: 'api', createdAt: '', updatedAt: '' };
const repo = {
  id: 10,
  projectId: 1,
  name: 'api',
  path: '/work/api',
  preferredContextRootRef: null,
  createdAt: '',
};

describe('ProjectCreateComponent', () => {
  const projects = { create: vi.fn() };
  const repos = { validatePath: vi.fn(), add: vi.fn(), suggestRepositories: vi.fn() };
  const navigation = { refreshTree: vi.fn(), revealProject: vi.fn() };
  const onboarding = { snapshotState: vi.fn() };

  beforeEach(async () => {
    vi.resetAllMocks();
    projects.create.mockReturnValue(of(project));
    repos.add.mockReturnValue(of(repo));
    repos.suggestRepositories.mockReturnValue(of([]));
    repos.validatePath.mockImplementation((path: string) =>
      of({
        path: path.replace(/\/+$/, ''),
        name: path.split('/').filter(Boolean).at(-1),
      }),
    );
    onboarding.snapshotState.mockReturnValue({ mode: 'local' });
    await TestBed.configureTestingModule({
      imports: [ProjectCreateComponent],
      providers: [
        { provide: ProjectsService, useValue: projects },
        { provide: ReposService, useValue: repos },
        { provide: NavigationService, useValue: navigation },
        { provide: OnboardingStateService, useValue: onboarding },
        { provide: PathAutocompleteService, useValue: { suggestPaths: () => of([]) } },
      ],
    }).compileComponents();
  });

  async function render() {
    const fixture = TestBed.createComponent(ProjectCreateComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  function select(component: ProjectCreateComponent, path: string, index = 0) {
    const id = component.repos()[index].id;
    component.updateRepoPath(id, path);
    component.validateRepo(id);
  }

  it('selects repositories before naming and defaults a single-repository name', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    const completed = vi.fn();
    component.completed.subscribe(completed);

    select(component, '/work/api/');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#project-create-name')).toBeNull();
    expect(component.canContinue()).toBe(true);
    expect(component.canSubmit()).toBe(false);
    await component.submit();
    expect(projects.create).not.toHaveBeenCalled();
    component.nextStep();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('#project-create-name') as HTMLInputElement).value,
    ).toBe('api');
    expect(fixture.nativeElement.textContent).not.toMatch(/Port forward|Review and finish/);
    expect(component.canSubmit()).toBe(true);

    await component.submit();
    expect(projects.create).toHaveBeenCalledWith('api');
    expect(repos.add).toHaveBeenCalledWith(1, '/work/api');
    expect(navigation.revealProject).toHaveBeenCalledWith(1);
    expect(completed).toHaveBeenCalledWith(project);
  });

  it('preserves an edited name when the selected repository changes', async () => {
    const component = (await render()).componentInstance;
    select(component, '/work/api');
    component.nextStep();
    component.updateProjectName('Platform');
    component.previousStep();
    select(component, '/work/frontend');
    component.nextStep();
    expect(component.projectDisplayName()).toBe('Platform');
    component.updateProjectName('');
    expect(component.canSubmit()).toBe(false);
    await component.submit();
    expect(projects.create).not.toHaveBeenCalled();
  });

  it('shows invalid paths beside the repository before creating anything', async () => {
    repos.validatePath.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 400,
            error: { message: 'Not a git repository.' },
          }),
      ),
    );
    const fixture = await render();
    select(fixture.componentInstance, '/work/not-git');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Not a git repository.');
    await fixture.componentInstance.submit();
    expect(projects.create).not.toHaveBeenCalled();
    expect(repos.add).not.toHaveBeenCalled();
  });

  it('cancels stale checks when the path changes and ignores their later result', async () => {
    const oldCheck = new Subject<{ path: string; name: string }>();
    repos.validatePath.mockReturnValueOnce(oldCheck.asObservable());
    const component = (await render()).componentInstance;
    select(component, '/work/old');
    expect(component.canSubmit()).toBe(false);
    select(component, '/work/current');
    oldCheck.next({ path: '/work/old', name: 'old' });

    expect(component.projectDisplayName()).toBe('current');
    component.nextStep();
    await component.submit();
    expect(repos.add).toHaveBeenCalledWith(1, '/work/current');
  });

  it('rejects the same normalized repository selected twice', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    select(component, '/work/api');
    component.addRepoRow();
    select(component, '/work/api/', 1);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('This repository is already selected.');
    expect(component.canSubmit()).toBe(false);
    await component.submit();
    expect(projects.create).not.toHaveBeenCalled();

    component.removeRepoRow(component.repos()[1].id);
    component.nextStep();
    expect(component.canSubmit()).toBe(true);
  });

  it('retries only repositories that failed without creating another project or relinking successes', async () => {
    repos.add
      .mockReturnValueOnce(of(repo))
      .mockReturnValueOnce(throwError(() => new Error('Temporarily unavailable.')));
    const fixture = await render();
    const component = fixture.componentInstance;
    const completed = vi.fn();
    component.completed.subscribe(completed);
    select(component, '/work/api');
    component.addRepoRow();
    select(component, '/work/frontend', 1);
    component.nextStep();
    component.updateProjectName('Platform');

    await component.submit();
    fixture.detectChanges();
    expect(completed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Retry remaining repositories');
    expect(component.canSubmit()).toBe(true);

    await component.submit();
    expect(projects.create).toHaveBeenCalledTimes(1);
    expect(repos.add.mock.calls.map((call) => call[1])).toEqual([
      '/work/api',
      '/work/frontend',
      '/work/frontend',
    ]);
    expect(completed).toHaveBeenCalledWith(project);
  });

  it('asks for a group name when selecting multiple repositories, and restores the single-repo default', async () => {
    const fixture = await render();
    const component = fixture.componentInstance;
    select(component, '/work/api');
    component.addRepoRow();
    select(component, '/work/frontend', 1);
    component.nextStep();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement.querySelector('#project-create-name') as HTMLInputElement).value,
    ).toBe('');
    expect(component.canSubmit()).toBe(false);
    component.previousStep();
    component.removeRepoRow(component.repos()[1].id);
    component.nextStep();
    expect(component.projectDisplayName()).toBe('api');
    expect(component.canSubmit()).toBe(true);
  });

  it('offers previously used repositories as quick picks, adds several and hides selected paths', async () => {
    repos.suggestRepositories.mockReturnValue(
      of([
        { name: 'api', path: '/work/api' },
        { name: 'frontend', path: '/work/frontend' },
      ]),
    );
    const fixture = await render();
    const component = fixture.componentInstance;
    fixture.detectChanges();
    const pick = fixture.nativeElement.querySelector(
      'button[aria-label="Select api at /work/api"]',
    ) as HTMLButtonElement;
    pick.click();
    fixture.detectChanges();
    expect(component.readyRepos()).toHaveLength(1);
    expect(component.canContinue()).toBe(true);
    expect(
      fixture.nativeElement.querySelector('button[aria-label="Select api at /work/api"]'),
    ).toBeNull();
    component.selectPreviouslyUsed({ name: 'frontend', path: '/work/frontend' });
    expect(component.readyRepos()).toHaveLength(2);
    component.selectPreviouslyUsed({ name: 'api', path: '/work/api' });
    expect(component.readyRepos()).toHaveLength(2);
  });

  it('does not treat a repository name search as a folder-validation failure', async () => {
    const component = (await render()).componentInstance;
    component.updateRepoPath(component.repos()[0].id, 'api');
    expect(component.repos()[0].validation).toBe('idle');
    expect(repos.validatePath).not.toHaveBeenCalled();
    expect(component.canContinue()).toBe(false);
  });

  it('shows the remote machine while keeping project creation free of port forwarding', async () => {
    onboarding.snapshotState.mockReturnValue({ mode: 'paired', paired: { name: 'Build desktop' } });
    const fixture = await render();
    expect(fixture.nativeElement.textContent).toContain('Build desktop');
    expect(fixture.nativeElement.textContent).not.toMatch(/SSH host|Port forward/);
  });

  it('cancels pending checks when the dialog is destroyed', async () => {
    const pending = new Subject<{ path: string; name: string }>();
    repos.validatePath.mockReturnValue(pending.asObservable());
    const fixture = await render();
    select(fixture.componentInstance, '/work/api');
    expect(pending.observed).toBe(true);
    fixture.destroy();
    expect(pending.observed).toBe(false);
  });
});
