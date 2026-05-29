import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { AgentControlDrawerComponent } from './agent-control-drawer.component';
import { AgentControlStateService } from './agent-control-state.service';

function installLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
      clear: vi.fn(() => values.clear()),
    },
  });
}

describe('AgentControlDrawerComponent', () => {
  let originalLocalStorage: Storage | undefined;

  beforeEach(async () => {
    originalLocalStorage = globalThis.localStorage;
    installLocalStorage();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [AgentControlDrawerComponent],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    });
  });

  it('renders the preview drawer empty state when opened', () => {
    const service = TestBed.inject(AgentControlStateService);
    service.openGlobal();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Elevenex agent');
    expect(text).toContain('Preview mode');
    expect(text).toContain('No preview missions');
  });

  it('creates a local mission from the composer', () => {
    const service = TestBed.inject(AgentControlStateService);
    service.openGlobal();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();

    const textarea = (fixture.nativeElement as HTMLElement).querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.value = 'Run the agent and review the changes';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    const submit = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Generate preview')) as HTMLButtonElement;
    submit.click();
    fixture.detectChanges();

    expect(service.missions()).toHaveLength(1);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Run the agent and review the changes',
    );
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Create worktree');
  });

  it('advances a composer-created preview locally', () => {
    const service = TestBed.inject(AgentControlStateService);
    service.openGlobal();

    const fixture = TestBed.createComponent(AgentControlDrawerComponent);
    fixture.detectChanges();

    const textarea = (fixture.nativeElement as HTMLElement).querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
    textarea.value = 'Create a focused worktree from the best base ref';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    const submit = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Generate preview')) as HTMLButtonElement;
    submit.click();
    fixture.detectChanges();

    expect(service.selectedMission()?.status).toBe('waiting_approval');

    const approve = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('Approve preview')) as HTMLButtonElement;
    approve.click();
    fixture.detectChanges();

    expect(service.selectedMission()?.status).toBe('planned');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Preview-only approval');
  });
});
