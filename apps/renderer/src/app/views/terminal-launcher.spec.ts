import { TestBed } from '@angular/core/testing';
import { TerminalViewComponent } from './terminal-view.component';
import { TerminalScript } from './view.models';

const scripts: readonly TerminalScript[] = [
  { id: 'dev', name: 'dev', cmd: 'pnpm dev' },
  { id: 'test', name: 'test', cmd: 'vitest run' },
  { id: 'lint', name: 'lint', cmd: 'eslint .' },
];

async function setup(items: readonly TerminalScript[] = scripts) {
  const fixture = TestBed.createComponent(TerminalViewComponent);
  fixture.componentRef.setInput('tabs', [{ id: 'one', title: 'zsh', status: 'idle' }]);
  fixture.componentRef.setInput('scripts', items);
  fixture.detectChanges();
  await fixture.whenStable();
  const root = fixture.nativeElement as HTMLElement;
  const trigger = root.querySelector<HTMLButtonElement>('[aria-label="New shell or script"]');
  const open = async () => {
    trigger!.focus();
    trigger!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    return document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  };
  const type = async (field: HTMLInputElement, value: string) => {
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const key = async (field: HTMLInputElement, init: KeyboardEventInit) => {
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(option => option.textContent?.trim());
  return { fixture, root, trigger, open, type, key, options };
}

describe('Terminal launcher', () => {
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach(node => node.replaceChildren()));

  it('sits directly after New and is omitted without project scripts', async () => {
    const withScripts = await setup();
    const strip = withScripts.root.querySelector('ex-view-tabs .row')!;
    const order = Array.from(strip.querySelectorAll('.new, ex-terminal-launcher, .spacer, .find-trigger')).map(node => node.className.split(' ')[0] || node.tagName.toLowerCase());
    expect(order).toEqual(['new', 'ex-terminal-launcher', 'spacer', 'find-trigger']);
    const without = await setup([]);
    expect(without.trigger).toBeNull();
  });

  it('focuses its search field, filters scripts and launches the active option by keyboard', async () => {
    const { fixture, trigger, open, type, key, options } = await setup();
    const requested = vi.fn();
    fixture.componentInstance.scriptRequested.subscribe(requested);
    const field = await open();
    expect(trigger!.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(field);
    expect(options()).toEqual(['New shell⌘T', 'devpnpm dev', 'testvitest run', 'linteslint .']);
    await type(field, 'vitest');
    expect(options()).toEqual(['testvitest run']);
    expect(field.getAttribute('aria-activedescendant')).toBe(document.querySelector('[role="option"]')!.id);
    await key(field, { key: 'Enter' });
    expect(requested).toHaveBeenCalledExactlyOnceWith(scripts[1]);
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('wraps arrow navigation, opens a shell, reports no matches and restores focus on Escape', async () => {
    const { fixture, trigger, open, type, key } = await setup();
    const added = vi.fn();
    const requested = vi.fn();
    fixture.componentInstance.added.subscribe(added);
    fixture.componentInstance.scriptRequested.subscribe(requested);
    let field = await open();
    await key(field, { key: 'ArrowUp' });
    expect(document.querySelector('.option.active')?.textContent).toContain('lint');
    await key(field, { key: 'ArrowDown' });
    await key(field, { key: 'Enter' });
    expect(added).toHaveBeenCalledTimes(1);
    expect(requested).not.toHaveBeenCalled();

    field = await open();
    expect(field.value).toBe('');
    await type(field, 'nothing-matches');
    expect(document.querySelector('.note')?.textContent).toContain('No scripts match');
    await key(field, { key: 'Enter' });
    expect(added).toHaveBeenCalledTimes(1);
    await key(field, { key: 'Escape' });
    expect(trigger!.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('input[role="combobox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('bounds rendered scripts and closes when disabled', async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({ id: `s${index}`, name: `script-${index}`, cmd: `run ${index}` }));
    const { fixture, open } = await setup(many);
    await open();
    expect(document.querySelectorAll('[role="option"]').length).toBe(51);
    expect(document.querySelector('.note')?.textContent).toContain('70 more');
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(document.querySelector('input[role="combobox"]')).toBeNull();
  });
});
