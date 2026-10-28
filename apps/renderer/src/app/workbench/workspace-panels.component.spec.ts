import { TestBed } from '@angular/core/testing';
import { WorkspacePanelsComponent } from './workspace-panels.component';

describe('Workspace side-view shells', () => {
  beforeEach(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
  it('connects each tab to one visible panel and supports keyboard navigation', () => {
    const fixture = TestBed.createComponent(WorkspacePanelsComponent);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['Terminal', 'Actions', 'Changes', 'Code', 'Browser']);
    expect(root.querySelector('[role="tabpanel"]:not([hidden])')?.getAttribute('id')).toBe('workspace-panel-changes');
    const browserTab = tabs[4]!;
    browserTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.panel()).toBe('terminal');
    expect(document.activeElement).toBe(tabs[0]);
    for (const tab of tabs) expect(root.querySelector(`#${tab.getAttribute('aria-controls')}`)).not.toBeNull();
    expect(root.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
    expect(root.querySelectorAll('[role="tabpanel"][inert]')).toHaveLength(4);
  });

  it.each(['Terminal', 'Actions', 'Changes', 'Code', 'Browser'])('expands and restores %s while preserving expansion across tab changes', label => {
    const fixture = TestBed.createComponent(WorkspacePanelsComponent);
    fixture.detectChanges();
    const wide = vi.fn();
    fixture.componentInstance.wideChange.subscribe(wide);
    const root: HTMLElement = fixture.nativeElement;
    root.querySelector<HTMLButtonElement>(`[role="tab"][aria-label="${label}"]`)!.click();
    fixture.detectChanges();
    root.querySelector<HTMLButtonElement>('[aria-label="Expand side panel"]')!.click();
    expect(wide).toHaveBeenCalledExactlyOnceWith(true);

    fixture.componentRef.setInput('wide', true);
    fixture.detectChanges();
    wide.mockClear();
    root.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Terminal"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.panel()).toBe('actions');
    expect(wide).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('[aria-label="Return to chat"]')!.click();
    expect(wide).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('emits close intent from an expanded side view', () => {
    const fixture = TestBed.createComponent(WorkspacePanelsComponent);
    fixture.componentRef.setInput('wide', true);
    fixture.detectChanges();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const root: HTMLElement = fixture.nativeElement;
    root.querySelector<HTMLButtonElement>('[aria-label="Browser"]')?.click();
    fixture.detectChanges();
    expect(root.querySelector('[aria-label="Return to chat"]')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[aria-label="Close side panel"]')?.click();
    expect(closed).toHaveBeenCalledOnce();
  });
});
