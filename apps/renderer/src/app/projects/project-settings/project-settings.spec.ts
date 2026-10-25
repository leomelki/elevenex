import { TestBed } from '@angular/core/testing';
import { AddProjectRepositoryComponent } from './add-project-repository.component';
import { ProjectRepositoryComponent } from './project-repository.component';
import { ProjectSettingsComponent } from './project-settings.component';
import type { FolderEntry, FolderProvider } from '../project.models';
import type { ProjectRepository } from './project-settings.models';

const REPO: ProjectRepository = {id: 'api', name: 'payments-api', path: '~/code/api', short: 'api', base: 'main', branches: ['main', 'develop'], setup: 'pnpm install'};

describe('project settings supplied data and intents', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined })));
  afterEach(() => vi.unstubAllGlobals());

  it('uses the shared dropdown for preferences, emits patches and keeps Escape local to its menu', async () => {
    const fixture = TestBed.createComponent(ProjectSettingsComponent);
    fixture.componentRef.setInput('project', { name: 'Checkout' });
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('section', 'git');
    const changed = vi.fn(); const closed = vi.fn();
    fixture.componentInstance.preferencesChanged.subscribe(changed);
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges(); await fixture.whenStable();
    const trigger = document.querySelector<HTMLButtonElement>('ex-set-choice button[aria-label^="Merging sub-tasks:"]')!;
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    const items = document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect(items).toHaveLength(3);
    items[1]!.click(); fixture.detectChanges();
    expect(changed).toHaveBeenCalledExactlyOnceWith({ subtaskMerge: 'merge' });
    expect(trigger.textContent).toContain('Squash and merge');
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(closed).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentRef.setInput('open', false); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('aborts stale folder lookups, rejects late replies and emits the keyboard selection', async () => {
    const requests: {query: string; signal: AbortSignal; resolve: (entries: readonly FolderEntry[]) => void}[] = [];
    const provider: FolderProvider = (query, signal) => new Promise(resolve => requests.push({query, signal, resolve}));
    const fixture = TestBed.createComponent(AddProjectRepositoryComponent);
    fixture.componentRef.setInput('listId', 'test-folders'); fixture.componentRef.setInput('adding', true); fixture.componentRef.setInput('query', '~/'); fixture.componentRef.setInput('listFolders', provider);
    const added = vi.fn(); fixture.componentInstance.added.subscribe(added); fixture.detectChanges(); await fixture.whenStable();
    const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    field.value = '~/code/'; field.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable();
    expect(requests[0]!.signal.aborted).toBe(true);
    requests[1]!.resolve([{path: '~/code/api', git: 'main'}, {path: '~/code/web', git: 'main'}]);
    await vi.waitFor(() => { fixture.detectChanges(); expect(fixture.nativeElement.querySelectorAll('[role="option"]')).toHaveLength(2); });
    requests[0]!.resolve([{path: '~/stale'}]); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('~/stale');
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true})); fixture.detectChanges();
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(added).toHaveBeenCalledExactlyOnceWith({path: '~/code/web', git: 'main'});
    fixture.componentRef.setInput('context', 'another-project'); fixture.detectChanges(); await fixture.whenStable();
    expect(requests[1]!.signal.aborted).toBe(true);
    fixture.destroy(); expect(requests[2]!.signal.aborted).toBe(true);
  });

  it('descends supplied folder entries and makes Escape local to the add row', async () => {
    const fixture = TestBed.createComponent(AddProjectRepositoryComponent);
    fixture.componentRef.setInput('listId', 'test-folders'); fixture.componentRef.setInput('adding', true); fixture.componentRef.setInput('listFolders', () => [{path: '~/code', dir: true}]);
    const added = vi.fn(); const cancelled = vi.fn(); fixture.componentInstance.added.subscribe(added); fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); fixture.detectChanges();
    expect(field.value).toBe('~/code/'); expect(added).not.toHaveBeenCalled();
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); expect(cancelled).toHaveBeenCalledOnce();
    const repository = {path: '~/code/api', dir: true, git: 'main'};
    fixture.componentRef.setInput('listFolders', () => [repository]); fixture.detectChanges();
    await vi.waitFor(() => { fixture.detectChanges(); expect(fixture.nativeElement.querySelector('[role="option"]')?.textContent).toContain('~/code/api'); });
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(added).toHaveBeenCalledExactlyOnceWith(repository);
  });

  it('aborts inactive requests while retaining the row presentation and rejecting late replies or intents', async () => {
    const requests: {signal: AbortSignal; resolve: (entries: readonly FolderEntry[]) => void}[] = [];
    const provider: FolderProvider = (_query, signal) => new Promise(resolve => requests.push({signal, resolve}));
    const fixture = TestBed.createComponent(AddProjectRepositoryComponent);
    fixture.componentRef.setInput('listId', 'retained-folders'); fixture.componentRef.setInput('adding', true); fixture.componentRef.setInput('query', '~/code/'); fixture.componentRef.setInput('listFolders', provider);
    const added = vi.fn(); const cancelled = vi.fn(); fixture.componentInstance.added.subscribe(added); fixture.componentInstance.cancelled.subscribe(cancelled);
    fixture.detectChanges(); await fixture.whenStable();
    requests[0]!.resolve([{path: '~/code/api', git: 'main'}]);
    await vi.waitFor(() => { fixture.detectChanges(); expect(fixture.nativeElement.querySelectorAll('[role="option"]')).toHaveLength(1); });
    const field = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const focus = vi.spyOn(field, 'focus');
    fixture.componentRef.setInput('active', false); fixture.detectChanges(); await fixture.whenStable();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(fixture.nativeElement.hasAttribute('inert')).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="option"]')?.textContent).toContain('~/code/api');
    expect(field.value).toBe('~/code/'); expect(focus).not.toHaveBeenCalled();
    (fixture.nativeElement.querySelector('[role="option"]') as HTMLButtonElement).click();
    field.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(added).not.toHaveBeenCalled(); expect(cancelled).not.toHaveBeenCalled();
    fixture.componentRef.setInput('active', true); fixture.detectChanges(); await fixture.whenStable();
    expect(requests).toHaveLength(2);
    fixture.componentRef.setInput('active', false); fixture.detectChanges(); await fixture.whenStable();
    expect(requests[1]!.signal.aborted).toBe(true);
    requests[1]!.resolve([{path: '~/code/stale', git: 'main'}]); await Promise.resolve(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('~/code/stale');
    expect(fixture.nativeElement.textContent).toContain('Finding folders…');
    expect(fixture.nativeElement.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');
  });

  it('emits repository branch and command patches without changing supplied data', async () => {
    const fixture = TestBed.createComponent(ProjectRepositoryComponent); fixture.componentRef.setInput('repo', REPO); fixture.componentRef.setInput('open', true);
    const changed = vi.fn(); fixture.componentInstance.changed.subscribe(changed); fixture.detectChanges();
    (fixture.nativeElement.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).click(); fixture.detectChanges(); await fixture.whenStable();
    const branch = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(option => option.textContent?.includes('develop'))!; branch.click(); fixture.detectChanges();
    expect(changed).toHaveBeenLastCalledWith({base: 'develop'}); expect(REPO.base).toBe('main');
    const setup = fixture.nativeElement.querySelector('[aria-label="Setup: pnpm install, edit"]') as HTMLButtonElement; setup.click(); fixture.detectChanges();
    const command = fixture.nativeElement.querySelector('input[aria-label="Setup"]') as HTMLInputElement; command.value = 'pnpm fetch'; command.dispatchEvent(new Event('input')); command.dispatchEvent(new Event('blur'));
    expect(changed).toHaveBeenLastCalledWith({setup: 'pnpm fetch'}); expect(REPO.setup).toBe('pnpm install');
  });

  it('confirms repository removal in a nested layer and leaves its sheet open', async () => {
    const fixture = TestBed.createComponent(ProjectSettingsComponent); fixture.componentRef.setInput('project', {name: 'Checkout'}); fixture.componentRef.setInput('repos', [REPO]); fixture.componentRef.setInput('open', true); fixture.componentRef.setInput('openRepo', 'api'); fixture.componentRef.setInput('section', 'repos');
    const removed = vi.fn(); fixture.componentInstance.repoRemoved.subscribe(removed); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const remove = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('Remove from project'))!;
    remove.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(removed).not.toHaveBeenCalled();
    const confirm = document.querySelector<HTMLButtonElement>('.remove-dialog button[data-variant="danger"]')!; confirm.click(); fixture.detectChanges();
    expect(removed).toHaveBeenCalledExactlyOnceWith(REPO); expect(document.querySelector('[role="dialog"][aria-label="Checkout settings"]')).not.toBeNull();
  });

  it('preserves local repository and add-row state for exit and unspecified requests, then resets explicit or new-project context', async () => {
    const fixture = TestBed.createComponent(ProjectSettingsComponent);
    fixture.componentRef.setInput('project', {id: 'checkout', name: 'Checkout'}); fixture.componentRef.setInput('repos', [REPO]); fixture.componentRef.setInput('open', true); fixture.componentRef.setInput('section', 'repos');
    fixture.detectChanges(); await fixture.whenStable();
    (document.querySelector('ex-project-repository .head') as HTMLButtonElement).click();
    (document.querySelector('ex-add-project-repository .add-row') as HTMLButtonElement).click(); fixture.detectChanges();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Folder or clone URL"]')!;
    input.value = '~/draft/'; input.dispatchEvent(new Event('input')); fixture.detectChanges();
    fixture.componentRef.setInput('section', 'tasks'); fixture.detectChanges();
    expect(document.querySelector('ex-project-repository .head')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('input[aria-label="Folder or clone URL"]')).toBe(input);
    fixture.componentRef.setInput('open', false); fixture.detectChanges();
    expect(document.querySelector('ex-project-repository .head')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder or clone URL"]')?.value).toBe('~/draft/');
    expect(document.querySelector('ex-add-project-repository')?.hasAttribute('inert')).toBe(true);
    fixture.componentRef.setInput('open', true); fixture.detectChanges();
    expect(document.querySelector('ex-project-repository .head')?.getAttribute('aria-expanded')).toBe('true');
    fixture.componentRef.setInput('openRepo', null); fixture.componentRef.setInput('adding', false); fixture.detectChanges();
    expect(document.querySelector('ex-project-repository .head')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('input[aria-label="Folder or clone URL"]')).toBeNull();
    fixture.componentRef.setInput('openRepo', undefined); fixture.componentRef.setInput('adding', undefined); fixture.detectChanges();
    (document.querySelector('ex-project-repository .head') as HTMLButtonElement).click();
    (document.querySelector('ex-add-project-repository .add-row') as HTMLButtonElement).click(); fixture.detectChanges();
    fixture.componentRef.setInput('project', {id: 'other', name: 'Another project'}); fixture.detectChanges();
    expect(document.querySelector('ex-project-repository .head')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('input[aria-label="Folder or clone URL"]')).toBeNull();
  });
});
