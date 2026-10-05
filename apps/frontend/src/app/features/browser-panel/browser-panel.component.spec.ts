import type { BrowserViewState, ElectronBrowserApi } from '@/shared/runtime/electron-browser';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { ProjectBrowserStateService } from '@/shared/services/project-browser-state.service';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPanelComponent } from './browser-panel.component';

const flush = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

describe('BrowserPanelComponent native view lifetime', () => {
  const removeStateListener = vi.fn();
  const observe = vi.fn();
  const disconnect = vi.fn();
  let api: ElectronBrowserApi;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    api = {
      isSupported: vi.fn(async () => true),
      show: vi.fn(async () => null),
      hide: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      navigate: vi.fn(async () => null),
      back: vi.fn(async () => null),
      forward: vi.fn(async () => null),
      reload: vi.fn(async () => null),
      getState: vi.fn(
        async (key: string): Promise<BrowserViewState> => ({
          key,
          url: 'https://example.com',
          title: 'Example',
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
          lastError: null,
          devtoolsOpen: false,
          runtimeContext: 'shared',
        }),
      ),
      setDevToolsVisible: vi.fn(async () => null),
      updateIsolationConfig: vi.fn(async () => undefined),
      onStateChanged: vi.fn(() => removeStateListener),
    };
    window.__ELEVENEX_ELECTRON__ = { browser: api };
    const snapshot = {
      projectId: 1,
      activeTabId: 'first',
      tabs: [{ tabId: 'first', url: 'https://example.com', position: 0, customTitle: null }],
    };
    TestBed.configureTestingModule({
      imports: [BrowserPanelComponent],
      providers: [
        {
          provide: ProjectBrowserStateService,
          useValue: { get: vi.fn(() => of(snapshot)), save: vi.fn(() => of(snapshot)) },
        },
        { provide: BrowserIsolationService, useValue: {} },
      ],
    });
  });

  afterEach(() => {
    delete window.__ELEVENEX_ELECTRON__;
    vi.unstubAllGlobals();
  });

  it('binds its signal queries to native view bounds and cleans up native listeners', async () => {
    const fixture = TestBed.createComponent(BrowserPanelComponent);
    fixture.componentRef.setInput('projectId', 1);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();
    await flush();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(api.show).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'project:1:tab:first',
        browserBounds: { x: 0, y: 0, width: 0, height: 0 },
        devtoolsVisible: false,
      }),
    );
    expect(fixture.nativeElement.querySelector('.browser-native-host--page')).not.toBeNull();
    fixture.destroy();
    expect(removeStateListener).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('does not attach native views after the panel is destroyed during support detection', async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(api.isSupported).mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    const fixture = TestBed.createComponent(BrowserPanelComponent);
    fixture.componentRef.setInput('projectId', 1);
    fixture.detectChanges();
    fixture.destroy();
    resolve(true);
    await flush();
    expect(api.onStateChanged).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(api.show).not.toHaveBeenCalled();
  });
});
