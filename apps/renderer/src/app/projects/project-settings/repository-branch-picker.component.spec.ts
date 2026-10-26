import { TestBed } from '@angular/core/testing';
import { InteractivityChecker } from '@angular/cdk/a11y';
import { RepositoryBranchPickerComponent } from './repository-branch-picker.component';
import type { ProjectRepository } from './project-settings.models';

const REPO: ProjectRepository = { id: 'api', name: 'api', path: '~/api', base: 'main',
  branches: ['main', ...Array.from({ length: 500 }, (_, index) => `release/version-${index}`), 'develop'] };

describe('repository starting branch picker', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
    // jsdom has no layout boxes; native focus behavior is also checked in desktop captures.
    vi.spyOn(InteractivityChecker.prototype, 'isFocusable').mockImplementation(element => element instanceof HTMLInputElement);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const fixture = TestBed.createComponent(RepositoryBranchPickerComponent);
    fixture.componentRef.setInput('repo', REPO);
    const changed = vi.fn(); fixture.componentInstance.changed.subscribe(changed);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    trigger.focus(); trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    const search = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    const type = async (value: string) => {
      search.value = value; search.dispatchEvent(new Event('input')); fixture.detectChanges(); await fixture.whenStable();
    };
    const key = async (value: string) => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })); fixture.detectChanges(); await fixture.whenStable();
    };
    return { fixture, trigger, search, changed, type, key };
  }

  it('searches beyond 100 branches, bounds the rendered list and selects an existing branch with the keyboard', async () => {
    const { search, changed, trigger, type, key } = await setup();
    expect(document.activeElement).toBe(search);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(7);
    await type('VERSION 499');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(document.getElementById(search.getAttribute('aria-activedescendant')!)?.querySelector('.mono')?.textContent).toBe('release/version-499');
    await key('Enter');
    expect(changed).toHaveBeenCalledExactlyOnceWith('release/version-499');
    expect(REPO.base).toBe('main');
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('resets keyboard highlight after filtering, handles no matches and keeps Escape local', async () => {
    const { fixture, trigger, search, changed, type, key } = await setup();
    await key('ArrowUp');
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-6$/);
    await type('develop');
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-0$/);
    await type('missing-branch');
    expect(search.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain('No branch matches');
    await key('ArrowDown'); await key('Enter');
    expect(changed).not.toHaveBeenCalled();
    const escaped = vi.fn(); document.addEventListener('keydown', escaped);
    await key('Escape'); document.removeEventListener('keydown', escaped);
    expect(escaped).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector<HTMLInputElement>('[role="combobox"]')?.value).toBe('');
  });

  it('dismisses without changes on outside click and closes when its repository becomes inactive', async () => {
    const { fixture, trigger, changed } = await setup();
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')!.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(changed).not.toHaveBeenCalled();
    trigger.click(); fixture.detectChanges(); await fixture.whenStable();
    fixture.componentRef.setInput('active', false); fixture.detectChanges(); await fixture.whenStable();
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    expect(trigger.disabled).toBe(true);
  });
});
