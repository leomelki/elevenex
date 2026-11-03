import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { CodeBounds, CodeSurfaceState, CodeTarget, ElevenexBridge } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { CodePanelComponent } from './code-panel.component';

const target: CodeTarget = { scopeId: 'scope-a', taskId: 1 };
const loading: CodeSurfaceState = { taskId: 1, identity: 'a'.repeat(64), phase: 'loading', message: 'Opening task workspace…' };
const ready: CodeSurfaceState = { ...loading, phase: 'ready', message: 'Task connected' };

describe('Code panel launch and native focus handoff', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(352, 132, 1064, 752));
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function settle(fixture: ComponentFixture<CodePanelComponent>) { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); await fixture.whenStable(); }
  function setup() {
    let publish!: (event: { target: CodeTarget; state: CodeSurfaceState }) => void;
    const layouts: (() => void)[] = [];
    const bridge = {
      platform: 'darwin' as const,
      onCodeChanged: vi.fn(listener => { publish = listener; return vi.fn(); }),
      codeOpen: vi.fn(async (selected: CodeTarget) => ({ ok: true as const, value: { ...loading, taskId: selected.taskId } })),
      codeRelease: vi.fn().mockResolvedValue(undefined),
      codeLayout: vi.fn((_selected: CodeTarget, bounds: CodeBounds | null) => bounds ? new Promise<void>(resolve => layouts.push(resolve)) : Promise.resolve()),
      codeFocus: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<ElevenexBridge>;
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: bridge }] });
    const fixture = TestBed.createComponent(CodePanelComponent);
    fixture.componentRef.setInput('target', target); fixture.componentRef.setInput('active', true); fixture.componentRef.setInput('wide', true);
    return { fixture, bridge, layouts, publish: (state: CodeSurfaceState) => publish({ target, state }) };
  }
  it('keeps a real loading explanation until ready and offers one failed-launch recovery action', async () => {
    const { fixture, bridge, publish } = setup(); await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('h2')?.textContent).toContain('Opening your workspace');
    expect(root.querySelector('ex-progress-line')).not.toBeNull();
    expect(bridge.codeLayout.mock.calls.some(([, bounds]) => bounds !== null)).toBe(false);
    publish({ ...loading, phase: 'failed', message: 'The connection stopped.' }); await settle(fixture);
    expect(root.querySelector('.launch-card [role="alert"]')?.textContent).toContain('The connection stopped.');
    expect([...root.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Try again')).toHaveLength(1);
  });
  it('focuses only after the current ready native layout is acknowledged, then releases it on teardown', async () => {
    const { fixture, bridge, publish, layouts } = setup(); await settle(fixture);
    publish(ready); await settle(fixture); fixture.componentInstance.focusEditor(); await settle(fixture);
    expect(bridge.codeFocus).not.toHaveBeenCalled(); expect(layouts).toHaveLength(1);
    const acknowledge = layouts.shift(); if (!acknowledge) throw new Error('Native layout was not requested.'); acknowledge(); await settle(fixture);
    expect(bridge.codeFocus).toHaveBeenCalledExactlyOnceWith(target);
    fixture.destroy(); expect(bridge.codeLayout).toHaveBeenLastCalledWith(target, null);
  });
  it('does not steal focus for an old task when a delayed layout acknowledgement arrives', async () => {
    const { fixture, bridge, publish, layouts } = setup(); await settle(fixture);
    publish(ready); await settle(fixture); fixture.componentInstance.focusEditor(); await settle(fixture);
    fixture.componentRef.setInput('target', { scopeId: 'scope-b', taskId: 2 }); await settle(fixture);
    const acknowledge = layouts.shift(); if (!acknowledge) throw new Error('Native layout was not requested.'); acknowledge(); await settle(fixture);
    expect(bridge.codeFocus).not.toHaveBeenCalled();
  });
  it('shows only the current platform shortcuts and no focus control for a hidden editor', async () => {
    const { fixture } = setup(); fixture.componentRef.setInput('wide', false); await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('[aria-label="Focus editor"]')).toBeNull();
    expect(root.querySelector('.shortcuts')?.textContent).toContain('⌘P');
    expect(root.querySelector('.shortcuts')?.textContent).not.toContain('Ctrl');
  });
});
