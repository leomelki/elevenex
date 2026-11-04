import '@angular/compiler';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZard } from '@/shared/core/provider/providezard';
import { AgentModelSelectorComponent } from './agent-model-selector.component';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function render() {
  await TestBed.configureTestingModule({
    imports: [AgentModelSelectorComponent],
    providers: [provideZard(), provideHttpClient(), provideHttpClientTesting()],
  }).compileComponents();
  const fixture = TestBed.createComponent(AgentModelSelectorComponent);
  const picker = fixture.componentInstance;
  vi.spyOn(picker.catalog, 'load').mockResolvedValue([]);
  fixture.componentRef.setInput('providers', [
    { id: 'claude', displayName: 'Claude', capabilities: {} },
    { id: 'codex', displayName: 'Codex', capabilities: {} },
  ]);
  fixture.componentRef.setInput('models', [
    { id: 'opus', displayName: 'Opus', description: 'Complex tasks', supportsEffort: true },
    { id: 'sonnet', displayName: 'Sonnet', supportsEffort: true },
  ]);
  fixture.componentRef.setInput('selectedModel', 'opus');
  fixture.componentRef.setInput('effectiveModelId', 'opus');
  picker.catalog.catalogs.set([
    {
      provider: 'codex',
      displayName: 'Codex',
      models: [{ id: 'codex-model', displayName: 'Codex Model', description: '' }],
      reasoningEfforts: [],
      providerDefaultModelId: null,
      supportsModelSelection: true,
    },
  ]);
  fixture.detectChanges();
  fixture.nativeElement.querySelector('button').click();
  fixture.detectChanges();
  const overlay = TestBed.inject(OverlayContainer).getContainerElement();
  return { fixture, picker, overlay };
}

describe('AgentModelSelectorComponent', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('searches across available agents and reports one combined selection', async () => {
    const { fixture, picker, overlay } = await render();
    const selected: unknown[] = [];
    picker.providerModelChange.subscribe((value) => selected.push(value));
    picker.startSearch('c');
    fixture.detectChanges();
    const input = overlay.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    input.value = 'codex';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(picker.query()).toBe('codex');
    expect(picker.catalog.load).toHaveBeenLastCalledWith();
    const choices = overlay.querySelectorAll<HTMLButtonElement>('[data-model-choice]');
    expect(choices).toHaveLength(1);
    expect(choices[0].textContent).toContain('Codex Model');
    choices[0].click();
    expect(selected).toEqual([{ provider: 'codex', model: 'codex-model' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('limits locked search to the conversation agent and hides the rail', async () => {
    const { fixture, picker, overlay } = await render();
    fixture.componentRef.setInput('locked', true);
    fixture.detectChanges();
    picker.startSearch('codex');
    fixture.detectChanges();
    expect(overlay.querySelector('[data-agent-choice]')).toBeNull();
    expect(picker.choices()).toEqual([]);
    expect(overlay.textContent).toContain('No models match');
    expect(picker.catalog.load).toHaveBeenCalledTimes(1);
  });

  it.each(['light', 'dark'])(
    'previews slider changes before committing and keeps fast mode open in %s mode',
    async (theme) => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const { fixture, picker, overlay } = await render();
      fixture.componentRef.setInput('supportsEffort', true);
      fixture.componentRef.setInput('supportsFastMode', true);
      fixture.componentRef.setInput('effortOptions', [
        { id: '', label: 'Default', hint: 'Agent default' },
        { id: 'low', label: 'Low', hint: 'Faster' },
        { id: 'high', label: 'High', hint: 'Deeper' },
      ]);
      const efforts: string[] = [];
      const fast: boolean[] = [];
      picker.effortChange.subscribe((value) => efforts.push(value));
      picker.fastModeChange.subscribe((value) => fast.push(value));
      fixture.detectChanges();
      const slider = overlay.querySelector<HTMLInputElement>('input[type="range"]')!;
      slider.value = '2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      expect(slider.getAttribute('aria-valuetext')).toBe('High');
      expect(efforts).toEqual([]);
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      expect(efforts).toEqual(['high']);
      overlay.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.click();
      expect(fast).toEqual([true]);
      expect(fixture.nativeElement.querySelector('button').getAttribute('aria-expanded')).toBe(
        'true',
      );
      fixture.componentRef.setInput('supportsFastMode', false);
      fixture.detectChanges();
      expect(overlay.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!.disabled).toBe(
        true,
      );
    },
  );

  it('shows an actionable sign-in state without exposing unusable model choices', async () => {
    const { fixture, picker, overlay } = await render();
    fixture.componentRef.setInput('authStatus', {
      authenticated: false,
      installed: true,
      isAuthenticating: false,
      output: [],
    });
    let connects = 0;
    picker.connectProvider.subscribe(() => connects++);
    fixture.detectChanges();
    expect(overlay.querySelector('[data-model-choice]')).toBeNull();
    const signIn = [...overlay.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Sign in',
    )!;
    signIn.click();
    expect(connects).toBe(1);
  });

  it('starts searching from typing and clears search with Escape before closing', async () => {
    const { fixture, picker, overlay } = await render();
    const dialog = overlay.querySelector<HTMLElement>('[aria-label="Agent, model and thinking"]')!;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    fixture.detectChanges();
    expect(picker.query()).toBe('s');
    expect(overlay.querySelector('[aria-label="Thinking"]')).toBeNull();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(picker.query()).toBe('');
    expect(picker.searchOpen()).toBe(false);
    expect(fixture.nativeElement.querySelector('button').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('keeps quota in the header and hides unreported usage', async () => {
    const { fixture, overlay } = await render();
    expect(overlay.querySelector('circle[pathLength]')).toBeNull();
    fixture.componentRef.setInput('planUsage', {
      provider: 'claude',
      planName: 'Pro',
      status: 'exhausted',
      credits: null,
      updatedAt: '',
      windows: [{ id: 'session', label: 'Session', remainingPercentage: 0, resetsAt: null }],
    });
    fixture.detectChanges();
    const quota = overlay.querySelector<HTMLElement>('[data-plan-remaining]')!;
    expect(quota.textContent).toContain('0% left');
    expect(quota.getAttribute('aria-label')).toBe('Claude plan: 0% remaining');
    expect(quota.classList.contains('text-destructive')).toBe(true);
    expect(quota.classList.contains('text-muted-foreground')).toBe(false);
    expect(overlay.querySelector('[data-agent-choice] svg')).toBeNull();
    fixture.componentRef.setInput('provider', 'codex');
    fixture.detectChanges();
    expect(overlay.querySelector('[data-plan-remaining]')).toBeNull();
  });
});
