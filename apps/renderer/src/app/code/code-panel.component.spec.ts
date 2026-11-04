import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { CodePresentation, CodeSurfaceState, CodeTarget, ElevenexBridge } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { CodeFramePool } from './code-frame-pool.service';
import { CodePanelComponent } from './code-panel.component';

const target: CodeTarget = { scopeId: 'scope-a', taskId: 1 };
const loading: CodeSurfaceState = { taskId: 1, identity: 'a'.repeat(64), phase: 'loading', message: 'Opening task workspace…' };
const frameUrl = 'https://w-' + 'a'.repeat(32) + '.' + 'b'.repeat(32) + '.code.elevenex.invalid/';
const ready: CodeSurfaceState = { ...loading, frameUrl, phase: 'ready', message: 'Task connected' };

describe('Code panel launch and iframe focus handoff', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1064);
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
      codePresent: vi.fn((_selected: CodeTarget, state: CodePresentation) => state.visible ? new Promise<void>(resolve => layouts.push(resolve)) : Promise.resolve()),
      codeFocus: vi.fn().mockResolvedValue(undefined),
      codeAction: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<ElevenexBridge>;
    TestBed.configureTestingModule({ providers: [{ provide: ELEVENEX_BRIDGE, useValue: bridge }, {provide:CodeFramePool,useValue:{mount:vi.fn(()=>vi.fn())}}] });
    const fixture = TestBed.createComponent(CodePanelComponent);
    fixture.componentRef.setInput('target', target); fixture.componentRef.setInput('active', true); fixture.componentRef.setInput('wide', true);
    return { fixture, bridge, layouts, publish: (state: CodeSurfaceState) => publish({ target, state }) };
  }
  it('keeps a real loading explanation until ready and offers one failed-launch recovery action', async () => {
    const { fixture, bridge, publish } = setup(); await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('h2')?.textContent).toContain('Opening your workspace');
    expect(root.querySelector('ex-progress-line')).not.toBeNull();
    expect(bridge.codePresent.mock.calls.some(([, state]) => state.visible)).toBe(false);
    publish({ ...loading, phase: 'failed', message: 'The connection stopped.' }); await settle(fixture);
    expect(root.querySelector('.launch-card [role="alert"]')?.textContent).toContain('The connection stopped.');
    expect([...root.querySelectorAll('button')].filter(button => button.textContent?.trim() === 'Try again')).toHaveLength(1);
  });
  it('focuses only after the current ready frame presentation is acknowledged, then releases it on teardown', async () => {
    const { fixture, bridge, publish, layouts } = setup(); await settle(fixture);
    publish(ready); await settle(fixture); fixture.componentInstance.focusEditor(); await settle(fixture);
    expect(bridge.codeFocus).not.toHaveBeenCalled(); expect(layouts).toHaveLength(1);
    const acknowledge = layouts.shift(); if (!acknowledge) throw new Error('Frame presentation was not requested.'); acknowledge(); await settle(fixture);
    expect(bridge.codeFocus).toHaveBeenCalledExactlyOnceWith(target);
    fixture.destroy(); expect(bridge.codePresent).toHaveBeenLastCalledWith(target, {visible:false,compact:false});
  });
  it('does not steal focus for an old task when a delayed layout acknowledgement arrives', async () => {
    const { fixture, bridge, publish, layouts } = setup(); await settle(fixture);
    publish(ready); await settle(fixture); fixture.componentInstance.focusEditor(); await settle(fixture);
    fixture.componentRef.setInput('target', { scopeId: 'scope-b', taskId: 2 }); await settle(fixture);
    const acknowledge = layouts.shift(); if (!acknowledge) throw new Error('Frame presentation was not requested.'); acknowledge(); await settle(fixture);
    expect(bridge.codeFocus).not.toHaveBeenCalled();
  });
  it('reveals only after the current viewport and compact layout are acknowledged, ignoring interrupted replies', async () => {
    const { fixture, bridge, publish, layouts } = setup(); await settle(fixture);
    publish(ready); await settle(fixture);
    const old = layouts.shift();
    fixture.componentInstance.measuredWidth.set(432); fixture.componentInstance.layoutRevision.set(1); await settle(fixture);
    expect(bridge.codePresent).toHaveBeenLastCalledWith(target,{visible:true,compact:true,viewportWidth:432});
    expect(fixture.componentInstance.layoutReady()).toBe(false);
    old?.(); await settle(fixture);
    expect(fixture.componentInstance.layoutReady()).toBe(false);
    const compact = layouts.shift();
    fixture.componentInstance.measuredWidth.set(1064); fixture.componentInstance.layoutRevision.set(2); await settle(fixture);
    compact?.(); await settle(fixture);
    expect(fixture.componentInstance.layoutReady()).toBe(false);
    const expanded = layouts.shift(); if (!expanded) throw new Error('Expanded layout was not requested');
    expanded(); await settle(fixture);
    expect(fixture.componentInstance.layoutReady()).toBe(true);
    expect(TestBed.inject(CodeFramePool).mount).toHaveBeenCalledOnce();
  });
  it('retains accessible writing and reports an error if layout settlement fails', async () => {
    const { fixture, bridge, publish } = setup(); await settle(fixture);
    publish(ready); await settle(fixture);
    bridge.codePresent.mockRejectedValueOnce(new Error('Layout timed out'));
    fixture.componentInstance.layoutRevision.set(1); await settle(fixture);
    expect(fixture.componentInstance.layoutReady()).toBe(true);
    expect(fixture.componentInstance.store.error()).toContain('finish resizing');
    expect(fixture.nativeElement.querySelector('.frame-container').hidden).toBe(false);
  });
  it('keeps the mounted frame and its focus when status or open replies change without changing the resource', async () => {
    const { fixture, publish } = setup(); await settle(fixture);
    const pool = TestBed.inject(CodeFramePool);
    publish({...ready,frameUrl}); await settle(fixture);
    publish({...ready,frameUrl,branch:'renamed'}); await settle(fixture);
    expect(pool.mount).toHaveBeenCalledOnce();
  });
  it('keeps its frame mounted but disables platform actions during the inert closing slide', async () => {
    const {fixture,bridge,publish}=setup(); await settle(fixture); publish(ready); await settle(fixture);
    const pool = TestBed.inject(CodeFramePool);
    const park = vi.mocked(pool.mount).mock.results[0]?.value;
    fixture.componentRef.setInput('retained',true);
    fixture.componentRef.setInput('active',false); await settle(fixture);
    expect(fixture.nativeElement.querySelector('.frame-container').hidden).toBe(false);
    expect(pool.mount).toHaveBeenCalledOnce(); expect(park).not.toHaveBeenCalled();
    expect(bridge.codePresent).toHaveBeenLastCalledWith(target,{visible:false,compact:false});
    await fixture.componentInstance.runAction('save');
    expect(bridge.codeAction).not.toHaveBeenCalled();
    fixture.componentRef.setInput('retained',false); await settle(fixture);
    expect(fixture.nativeElement.querySelector('.frame-container').hidden).toBe(true);
    expect(park).toHaveBeenCalledOnce();
  });
  it('shows only the iframe while its document is loading and keeps the same mount when ready', async () => {
    const { fixture, publish } = setup(); await settle(fixture);
    publish({ ...loading, frameUrl }); await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.launch-card')).toBeNull();
    expect(root.querySelector('.frame-container')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('ex-progress-line')).not.toBeNull();
    publish(ready); await settle(fixture);
    expect(TestBed.inject(CodeFramePool).mount).toHaveBeenCalledOnce();
  });
  it('opens without a native size minimum and never replaces a retained iframe with an Expand prompt', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0);
    const { fixture, bridge, publish } = setup(); await settle(fixture);
    expect(bridge.codeOpen).toHaveBeenCalledOnce();
    publish(ready); await settle(fixture);
    for (const value of [0, 180, 319, 432]) {
      width.mockReturnValue(value);
      fixture.componentInstance.measuredWidth.set(value);
      await settle(fixture);
      expect(fixture.nativeElement.querySelector('.launch-card')).toBeNull();
      expect(fixture.nativeElement.querySelector('.frame-container').hidden).toBe(false);
    }
    expect(TestBed.inject(CodeFramePool).mount).toHaveBeenCalledOnce();
    expect(bridge.codeOpen).toHaveBeenCalledOnce();
  });
  it('reopens the same task after selection was cleared without waiting for a size change', async () => {
    const { fixture, bridge, publish } = setup(); await settle(fixture);
    publish(ready); await settle(fixture);
    fixture.componentRef.setInput('target', null); await settle(fixture);
    fixture.componentRef.setInput('target', target); await settle(fixture);
    expect(bridge.codeOpen).toHaveBeenCalledTimes(2);
  });
  it('offers a local Back action when browsing over an open file, including while offline', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(432);
    const {fixture,bridge,publish}=setup(); await settle(fixture);
    publish({...ready,filesOpen:true,hasEditors:true}); await settle(fixture);
    expect(fixture.componentInstance.browseLabel()).toBe('Back to editor · Esc');
    fixture.componentRef.setInput('connected',false); await settle(fixture);
    await fixture.componentInstance.runAction('dismiss-files');
    expect(bridge.codeAction).toHaveBeenLastCalledWith(target,'dismiss-files');
    publish({...ready,filesOpen:true,hasEditors:false}); await settle(fixture);
    expect(fixture.componentInstance.browseLabel()).toContain('Browse files');
  });
  it('opens at side-panel width, offers direct file/search actions and retains it through expansion', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(424);
    const { fixture, bridge, publish, layouts } = setup();
    fixture.componentRef.setInput('wide', false); await settle(fixture);
    expect(bridge.codeOpen).toHaveBeenCalledExactlyOnceWith(target);
    publish(ready); await settle(fixture);
    const acknowledge = layouts.shift(); if (!acknowledge) throw new Error('Compact layout missing'); acknowledge(); await settle(fixture);
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('h2')).toBeNull();
    expect(root.querySelector('header')).toBeNull();
    await fixture.componentInstance.runAction('browse-files'); await settle(fixture);
    expect(bridge.codeAction).toHaveBeenLastCalledWith(target, 'browse-files');
    await fixture.componentInstance.runAction('find-file'); await settle(fixture);
    expect(bridge.codeAction).toHaveBeenLastCalledWith(target, 'find-file');
    await fixture.componentInstance.runAction('search-text'); await settle(fixture);
    expect(bridge.codeAction).toHaveBeenLastCalledWith(target, 'search-text');
    fixture.componentRef.setInput('wide', true); await settle(fixture);
    fixture.componentRef.setInput('wide', false); await settle(fixture);
    expect(bridge.codeRelease).not.toHaveBeenCalled();
    expect(bridge.codeOpen).toHaveBeenCalledOnce();
    fixture.componentRef.setInput('active', false); await settle(fixture);
    expect(bridge.codePresent).toHaveBeenLastCalledWith(target, {visible:false,compact:true});
    const calls = bridge.codeAction.mock.calls.length;
    await fixture.componentInstance.runAction('save');
    expect(bridge.codeAction.mock.calls).toHaveLength(calls);
  });
});
