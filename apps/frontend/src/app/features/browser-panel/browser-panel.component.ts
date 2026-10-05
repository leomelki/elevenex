import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { BrowserIsolationConfig } from '@/shared/models/browser-isolation.model';
import {
BrowserViewBounds,
BrowserViewLayout,
getElectronBrowserApi
} from '@/shared/runtime/electron-browser';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import {
ProjectBrowserStateService,
ProjectBrowserTabState,
} from '@/shared/services/project-browser-state.service';
import { CommonModule } from '@angular/common';
import {
AfterViewInit,ChangeDetectionStrategy,Component,computed,DestroyRef,effect,ElementRef,inject,
input,NgZone,
OnDestroy,output,
signal,viewChild
} from '@angular/core';
import { NgIcon,provideIcons } from '@ng-icons/core';
import {
lucideArrowLeft,
lucideArrowRight,
lucideColumns2,
lucideGlobe,
lucideLoaderCircle,
lucidePlus,
lucideRefreshCw,
lucideRows2,
lucideSettings,
lucideShield,
lucideSquareTerminal,
lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { firstValueFrom } from 'rxjs';
import { BrowserTabsStateService } from './browser-tabs-state.service';
import {
BrowserViewStateService,
buildBrowserViewKey,
buildBrowserViewProjectPrefix,
} from './browser-view-state.service';

const defaultDevtoolsRatio = 0.42;
const defaultDockPosition = 'right';
const minimumBrowserPaneHeight = 180;
const minimumDevtoolsPaneHeight = 220;
const minimumBrowserPaneWidth = 240;
const minimumDevtoolsPaneWidth = 320;
type DevtoolsDockPosition = 'right' | 'bottom';

@Component({
  selector: 'app-browser-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  templateUrl: './browser-panel.component.html',
  styleUrl: './browser-panel.component.scss',
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideArrowRight,
      lucideColumns2,
      lucideGlobe,
      lucideLoaderCircle,
      lucidePlus,
      lucideRefreshCw,
      lucideRows2,
      lucideSettings,
      lucideShield,
      lucideSquareTerminal,
      lucideX,
    }),
  ],
})
export class BrowserPanelComponent implements AfterViewInit, OnDestroy {
  readonly projectId = input.required<number>();
  readonly isolationConfig = input<BrowserIsolationConfig | null>(null);
  readonly isolationConfigChanged = output<BrowserIsolationConfig>();

  private readonly surface = viewChild.required<ElementRef<HTMLDivElement>>('surface');
  private readonly browserViewport = viewChild.required<ElementRef<HTMLDivElement>>('browserViewport');
  private readonly devtoolsViewport = viewChild.required<ElementRef<HTMLDivElement>>('devtoolsViewport');

  private readonly api = getElectronBrowserApi();
  private readonly destroyRef = inject(DestroyRef);
  private readonly hydrationRequests = new Map<number, Promise<void>>();
  private readonly browserState = inject(BrowserViewStateService);
  private readonly browserTabsState = inject(BrowserTabsStateService);
  private readonly persistedBrowserState = inject(ProjectBrowserStateService);
  private readonly browserIsolationService = inject(BrowserIsolationService);
  private readonly ngZone = inject(NgZone);

  protected readonly isSupported = signal(false);
  protected readonly urlInput = signal('');
  protected readonly isEditing = signal(false);
  protected readonly showSettingsPopover = signal(false);
  protected readonly settingsGlobInput = signal('');
  protected readonly editingTabId = signal<string | null>(null);
  protected readonly renameDraft = signal('');
  protected readonly effectiveIsolationMode = computed(() => this.isolationConfig()?.mode ?? 'shared');
  protected readonly effectiveSharedGlobs = computed(() => this.isolationConfig()?.sharedGlobs ?? []);
  protected readonly activeTabId = computed(() => this.browserTabsState.getActiveTabId(this.projectId()));
  protected readonly activeTab = computed(() => this.browserTabsState.getActiveTab(this.projectId()));
  protected readonly browserTabs = computed(() =>
    this.browserTabsState.getTabs(this.projectId()).map(tab => ({
      ...tab,
      label: this.getTabLabel(tab),
      secondaryLabel: this.getSecondaryLabel(tab),
    })),
  );
  protected readonly hasTabs = computed(() => this.browserTabs().length > 0);
  protected readonly canAddTab = computed(() => this.browserTabsState.canAddTab(this.projectId()));
  protected readonly activeRuntimeContext = computed<'shared' | 'isolated'>(() =>
    this.currentState()?.runtimeContext ?? (this.effectiveIsolationMode() === 'shared' ? 'shared' : 'isolated'),
  );
  protected readonly activeRuntimeContextLabel = computed(() =>
    this.activeRuntimeContext() === 'shared' ? 'Shared' : 'Isolated',
  );
  protected readonly isDraggingDevtools = signal(false);
  protected readonly devtoolsRatio = signal(defaultDevtoolsRatio);
  protected readonly devtoolsIntent = signal<boolean | null>(null);
  protected readonly dockPosition = signal<DevtoolsDockPosition>(defaultDockPosition);
  protected readonly currentKey = computed(() => {
    const activeTabId = this.activeTabId();
    return activeTabId ? buildBrowserViewKey(this.projectId(), activeTabId) : null;
  });
  protected readonly currentState = computed(() => {
    const key = this.currentKey();
    return key ? this.browserState.getState(key) : null;
  });
  protected readonly isDevtoolsOpen = computed(
    () => this.devtoolsIntent() ?? this.currentState()?.devtoolsOpen ?? false,
  );
  protected readonly hasLivePage = computed(() => {
    const state = this.currentState();
    return Boolean(state && state.url !== 'about:blank');
  });
  protected readonly devtoolsPaneSize = computed(() =>
    this.isDevtoolsOpen() ? `${Math.round(this.devtoolsRatio() * 100)}%` : '0px',
  );
  protected readonly isSideBySide = computed(() => this.dockPosition() === 'right');
  protected readonly devtoolsGridTemplate = computed(() => {
    if (!this.isDevtoolsOpen()) {
      return this.isSideBySide() ? 'minmax(0, 1fr) 0 minmax(0, 0) / minmax(0, 1fr) 0 0' : 'minmax(0, 1fr) 0 minmax(0, 0) / minmax(0, 1fr)';
    }

    if (this.isSideBySide()) {
      return `minmax(0, 1fr) / minmax(0, 1fr) auto minmax(0, ${this.devtoolsPaneSize()})`;
    }

    return `minmax(0, 1fr) auto minmax(0, ${this.devtoolsPaneSize()}) / minmax(0, 1fr)`;
  });
  protected readonly pageLabel = computed(() => {
    const state = this.currentState();
    if (!state || state.url === 'about:blank') {
      return '';
    }

    return state.title || this.getUrlLabel(state.url);
  });

  private readonly resizeObserver = new ResizeObserver(() => {
    this.requestLayoutStabilization();
  });
  private readonly hydratedProjects = new Set<number>();
  private readonly hydratedBrowserKeys = new Set<string>();
  private readonly persistedSnapshots = new Map<number, string>();
  private readonly persistTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private removeStateListener: (() => void) | null = null;
  private currentVisibleKey: string | null = null;
  private removeDragListeners: (() => void) | null = null;
  private lastLoadedDockPreferenceKey: string | null = null;
  private layoutBurstFrame: number | null = null;
  private layoutBurstFramesRemaining = 0;
  private layoutHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastObservedLayoutSignature: string | null = null;

  constructor() {
    effect(() => {
      const key = this.currentKey();
      if (!key || key === this.lastLoadedDockPreferenceKey) {
        return;
      }

      this.lastLoadedDockPreferenceKey = key;
      this.dockPosition.set(this.readDockPositionPreference(key));
    });

    effect(() => {
      const key = this.currentKey();
      if (!key) {
        return;
      }

      this.writeDockPositionPreference(key, this.dockPosition());
    });

    effect(() => {
      this.syncUrlInput(this.currentState()?.url);
    });

    effect(() => {
      const nextKey = this.currentKey();
      void this.handleKeyChange(nextKey);
    });

    effect(() => {
      const projectId = this.projectId();
      const currentProjects = this.browserTabsState.projects();
      const state = currentProjects.get(projectId);
      if (!state || !this.hydratedProjects.has(projectId)) {
        return;
      }

      const snapshot = JSON.stringify(this.browserTabsState.createSnapshot(projectId));
      if (this.persistedSnapshots.get(projectId) === snapshot) {
        return;
      }

      this.queuePersistSnapshot(projectId, snapshot);
    });

    effect(() => {
      const state = this.currentState();
      const activeTab = this.activeTab();
      if (!state || !activeTab || state.url === 'about:blank' || state.isLoading) {
        return;
      }

      if (activeTab.url !== state.url) {
        this.browserTabsState.updateTabUrl(this.projectId(), activeTab.tabId, state.url);
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    if (!this.api) {
      return;
    }

    const supported = await this.api.isSupported();
    if (this.destroyRef.destroyed) return;
    this.isSupported.set(supported);
    if (!this.isSupported()) {
      return;
    }

    this.removeStateListener = this.api.onStateChanged(state => {
      this.ngZone.run(() => {
        this.browserState.upsertState(state);
        const parsed = this.parseBrowserKey(state.key);
        if (!parsed) {
          return;
        }

        const tab = this.browserTabsState.getTab(parsed.projectId, parsed.tabId);
        if (tab && tab.url !== state.url && state.url !== 'about:blank') {
          this.browserTabsState.updateTabUrl(parsed.projectId, parsed.tabId, state.url);
        }

        if (state.key === this.currentVisibleKey && state.url !== 'about:blank') {
          this.scheduleDeferredBoundsSync();
        }
      });
    });

    this.resizeObserver.observe(this.surface().nativeElement);
    this.resizeObserver.observe(this.browserViewport().nativeElement);
    this.resizeObserver.observe(this.devtoolsViewport().nativeElement);
    window.addEventListener('resize', this.handleWindowResize, { passive: true });

    await this.ensureHydrated(this.projectId());
    if (this.destroyRef.destroyed) return;
    const currentKey = this.currentKey();
    this.currentVisibleKey = currentKey;
    await this.showCurrentBrowser(currentKey);
    if (this.destroyRef.destroyed) return;
    this.startLayoutHeartbeat();
    this.scheduleDeferredBoundsSync();
  }

  ngOnDestroy(): void {
    this.cleanup();
  }

  protected handleInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.urlInput.set(target?.value ?? '');
  }

  protected handleInputBlur(event: Event): void {
    this.isEditing.set(false);
    const target = event.target as HTMLInputElement | null;
    const nextValue = target?.value?.trim() ?? '';
    if (!nextValue) {
      this.syncUrlInput(this.currentState()?.url);
    }
  }

  async navigateToUrl(url: string): Promise<void> {
    if (!this.api || !this.isSupported()) {
      return;
    }

    let activeTab = this.activeTab();
    if (!activeTab) {
      activeTab = this.browserTabsState.addTab(this.projectId());
      if (!activeTab) {
        return;
      }
    }

    const key = buildBrowserViewKey(this.projectId(), activeTab.tabId);
    const hadLivePageBefore = activeTab.url !== 'about:blank';

    try {
      const state = await this.api.navigate({
        key,
        url,
        ...this.getLayout(),
        isolationConfig: this.isolationConfig() ?? undefined,
      });
      this.browserTabsState.updateTabUrl(this.projectId(), activeTab.tabId, url);
      if (state) {
        this.browserState.upsertState(state);
      }

      if (!hadLivePageBefore && state?.url && state.url !== 'about:blank') {
        await this.api.hide(key);
        await this.waitForLayoutFrame();
      }

      await this.showCurrentBrowser(key);
      this.scheduleDeferredBoundsSync();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to open URL');
    }
  }

  protected async submitUrl(event: Event): Promise<void> {
    event.preventDefault();
    const url = this.urlInput().trim();
    if (!url) {
      return;
    }
    this.isEditing.set(false);
    await this.navigateToUrl(url);
  }

  protected async goBack(): Promise<void> {
    const key = this.currentKey();
    if (!this.api || !key || !this.currentState()?.canGoBack) {
      return;
    }

    try {
      const state = await this.api.back(key);
      if (state) {
        this.browserState.upsertState(state);
      }
    } catch {
      toast.error('Unable to navigate back');
    }
  }

  protected async goForward(): Promise<void> {
    const key = this.currentKey();
    if (!this.api || !key || !this.currentState()?.canGoForward) {
      return;
    }

    try {
      const state = await this.api.forward(key);
      if (state) {
        this.browserState.upsertState(state);
      }
    } catch {
      toast.error('Unable to navigate forward');
    }
  }

  protected async reload(): Promise<void> {
    const key = this.currentKey();
    if (!this.api || !key || !this.isSupported()) {
      return;
    }

    try {
      const state = await this.api.reload(key);
      if (state) {
        this.browserState.upsertState(state);
      }
    } catch {
      toast.error('Unable to reload the page');
    }
  }

  protected async toggleDevTools(): Promise<void> {
    const key = this.currentKey();
    if (!this.api || !key || !this.hasLivePage()) {
      return;
    }

    const nextVisible = !this.isDevtoolsOpen();
    this.devtoolsIntent.set(nextVisible);

    try {
      await this.waitForLayoutFrame();
      const state = await this.api.setDevToolsVisible({
        key,
        ...this.getLayout(),
        devtoolsVisible: nextVisible,
      });
      if (state) {
        this.browserState.upsertState(state);
      }
      this.scheduleDeferredBoundsSync();
    } catch {
      toast.error(nextVisible ? 'Unable to open DevTools' : 'Unable to hide DevTools');
    } finally {
      this.devtoolsIntent.set(null);
    }
  }

  protected setDockPosition(position: DevtoolsDockPosition): void {
    if (position === this.dockPosition()) {
      return;
    }

    this.dockPosition.set(position);
    this.scheduleDeferredBoundsSync();
  }

  protected toggleSettingsPopover(event: Event): void {
    event.stopPropagation();
    this.showSettingsPopover.update(v => !v);
  }

  protected addBrowserTab(): void {
    const nextTab = this.browserTabsState.addTab(this.projectId());
    if (!nextTab) {
      return;
    }

    this.syncUrlInput(undefined);
  }

  protected selectBrowserTab(tabId: string): void {
    this.browserTabsState.selectTab(this.projectId(), tabId);
  }

  protected closeBrowserTab(event: Event, tabId: string): void {
    event.stopPropagation();
    if (this.editingTabId() === tabId) {
      this.cancelRename();
    }

    const key = buildBrowserViewKey(this.projectId(), tabId);
    this.browserTabsState.closeTab(this.projectId(), tabId);
    this.browserState.removeState(key);
    this.hydratedBrowserKeys.delete(key);
    void this.api?.close(key);
  }

  protected beginRename(tabId: string): void {
    const tab = this.browserTabsState.getTab(this.projectId(), tabId);
    if (!tab) {
      return;
    }

    this.editingTabId.set(tabId);
    this.renameDraft.set(tab.customTitle ?? this.getTabLabel(tab));
  }

  protected commitRename(): void {
    const tabId = this.editingTabId();
    if (!tabId) {
      return;
    }

    this.browserTabsState.renameTab(this.projectId(), tabId, this.renameDraft());
    this.editingTabId.set(null);
    this.renameDraft.set('');
  }

  protected cancelRename(): void {
    this.editingTabId.set(null);
    this.renameDraft.set('');
  }

  protected setIsolationMode(mode: 'shared' | 'isolated'): void {
    const config = this.isolationConfig();
    if (!config || config.mode === mode) return;
    const projectId = this.projectId();
    this.browserIsolationService.save(projectId, mode, config.sharedGlobs).subscribe({
      next: saved => {
        this.isolationConfigChanged.emit(saved);
        void getElectronBrowserApi()?.updateIsolationConfig({ projectId, mode: saved.mode, sharedGlobs: saved.sharedGlobs });
        this.browserState.removeStatesByPrefix(buildBrowserViewProjectPrefix(projectId));
        for (const tab of this.browserTabsState.getTabs(projectId)) {
          this.hydratedBrowserKeys.delete(buildBrowserViewKey(projectId, tab.tabId));
        }
        toast.success(mode === 'isolated' ? 'Browser switched to isolated routing' : 'Browser switched to shared routing');
      },
      error: () => toast.error('Could not update isolation setting.'),
    });
  }

  protected addGlob(): void {
    const glob = this.settingsGlobInput().trim();
    if (!glob) return;
    const config = this.isolationConfig();
    const projectId = this.projectId();
    if (!config) return;
    if (config.sharedGlobs.includes(glob)) {
      toast.error('Pattern already exists.');
      return;
    }
    const updated = [...config.sharedGlobs, glob];
    this.browserIsolationService.save(projectId, config.mode, updated).subscribe({
      next: saved => {
        this.settingsGlobInput.set('');
        this.isolationConfigChanged.emit(saved);
        void getElectronBrowserApi()?.updateIsolationConfig({ projectId, mode: saved.mode, sharedGlobs: saved.sharedGlobs });
      },
      error: () => toast.error('Could not save pattern.'),
    });
  }

  protected removeGlob(index: number): void {
    const config = this.isolationConfig();
    const projectId = this.projectId();
    if (!config) return;
    const updated = config.sharedGlobs.filter((_, i) => i !== index);
    this.browserIsolationService.save(projectId, config.mode, updated).subscribe({
      next: saved => {
        this.isolationConfigChanged.emit(saved);
        void getElectronBrowserApi()?.updateIsolationConfig({ projectId, mode: saved.mode, sharedGlobs: saved.sharedGlobs });
      },
      error: () => toast.error('Could not remove pattern.'),
    });
  }

  protected startDevtoolsResize(event: PointerEvent): void {
    if (!this.isDevtoolsOpen()) {
      return;
    }

    event.preventDefault();
    this.stopDraggingDevtools();
    this.isDraggingDevtools.set(true);

    const onPointerMove = (nextEvent: PointerEvent) => {
      const surfaceRect = this.surface().nativeElement.getBoundingClientRect();
      const nextRatio = this.isSideBySide()
        ? (surfaceRect.right - nextEvent.clientX) / surfaceRect.width
        : (surfaceRect.bottom - nextEvent.clientY) / surfaceRect.height;
      this.devtoolsRatio.set(this.clampDevtoolsRatio(nextRatio, surfaceRect));
      void this.syncBounds();
    };

    const finish = () => {
      this.stopDraggingDevtools();
      this.scheduleDeferredBoundsSync();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
    this.removeDragListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }

  private readonly handleWindowResize = (): void => {
    this.requestLayoutStabilization();
  };

  private async handleKeyChange(nextKey: string | null): Promise<void> {
    if (!this.api || !this.isSupported() || !this.browserViewport()) {
      return;
    }

    const projectId = this.projectId();
    await this.ensureHydrated(projectId);
    if (this.destroyRef.destroyed || projectId !== this.projectId() || nextKey !== this.currentKey()) return;

    const previousKey = this.currentVisibleKey;
    this.currentVisibleKey = nextKey;
    this.devtoolsIntent.set(null);
    this.isEditing.set(false);

    if (previousKey && previousKey !== nextKey) {
      await this.api.hide(previousKey);
    }

    if (!this.isCurrentBrowser(nextKey)) return;
    await this.showCurrentBrowser(nextKey);
    if (this.isCurrentBrowser(nextKey)) this.scheduleDeferredBoundsSync();
  }

  private async ensureHydrated(projectId: number): Promise<void> {
    if (this.hydratedProjects.has(projectId)) return;
    const pending = this.hydrationRequests.get(projectId);
    if (pending) return pending;
    const request = (async () => {
      try {
        const snapshot = await firstValueFrom(this.persistedBrowserState.get(projectId));
        if (this.destroyRef.destroyed) return;
        this.browserTabsState.hydrate(snapshot);
        this.persistedSnapshots.set(projectId, JSON.stringify(snapshot));
      } catch {
        if (this.destroyRef.destroyed) return;
        const snapshot = this.browserTabsState.createSnapshot(projectId);
        this.browserTabsState.hydrate(snapshot);
        this.persistedSnapshots.set(projectId, JSON.stringify(snapshot));
      } finally {
        if (!this.destroyRef.destroyed) this.hydratedProjects.add(projectId);
      }
    })();
    this.hydrationRequests.set(projectId, request);
    try { await request; } finally { this.hydrationRequests.delete(projectId); }
  }

  private isCurrentBrowser(key: string | null): boolean {
    return !this.destroyRef.destroyed && key === this.currentKey() && key === this.currentVisibleKey;
  }

  private async showCurrentBrowser(browserKey: string | null): Promise<void> {
    if (!this.api || !this.isSupported() || !this.browserViewport() || !browserKey) {
      this.syncUrlInput(undefined);
      return;
    }

    const currentState = await this.api.getState(browserKey);
    if (!this.isCurrentBrowser(browserKey)) return;
    if (currentState) {
      this.browserState.upsertState(currentState);
      if (currentState.url !== 'about:blank') {
        const shown = await this.api.show({
          key: browserKey,
          ...this.getLayout(),
          devtoolsVisible: this.isDevtoolsOpen(),
          isolationConfig: this.isolationConfig() ?? undefined,
        });
        if (shown) {
          this.browserState.upsertState(shown);
        }
        return;
      }
    }

    await this.hydratePersistedTab(browserKey);
    if (!this.isCurrentBrowser(browserKey)) return;
    const hydratedState = await this.api.getState(browserKey);
    if (!this.isCurrentBrowser(browserKey)) return;
    if (hydratedState?.url && hydratedState.url !== 'about:blank') {
      const shown = await this.api.show({
        key: browserKey,
        ...this.getLayout(),
        devtoolsVisible: this.isDevtoolsOpen(),
        isolationConfig: this.isolationConfig() ?? undefined,
      });
      if (shown) {
        this.browserState.upsertState(shown);
      }
    } else {
      await this.api.hide(browserKey);
    }
  }

  private async hydratePersistedTab(browserKey: string): Promise<void> {
    if (!this.api || this.hydratedBrowserKeys.has(browserKey)) {
      return;
    }

    this.hydratedBrowserKeys.add(browserKey);
    const parsed = this.parseBrowserKey(browserKey);
    if (!parsed) {
      return;
    }

    const tab = this.browserTabsState.getTab(parsed.projectId, parsed.tabId);
    if (!tab?.url || tab.url === 'about:blank') {
      return;
    }

    try {
      await this.api.navigate({
        key: browserKey,
        url: tab.url,
        ...this.getLayout(),
        isolationConfig: this.isolationConfig() ?? undefined,
      });
    } catch {
      // Ignore hydration failures.
    }
  }

  private async syncBounds(): Promise<void> {
    if (!this.api || !this.isSupported() || !this.currentVisibleKey || !this.browserViewport()) {
      return;
    }

    const state = this.browserState.getState(this.currentVisibleKey);
    if (!state || state.url === 'about:blank') {
      return;
    }

    this.lastObservedLayoutSignature = this.getLayoutSignature();
    await this.api.show({
      key: this.currentVisibleKey,
      ...this.getLayout(),
      devtoolsVisible: this.isDevtoolsOpen(),
      isolationConfig: this.isolationConfig() ?? undefined,
    });
  }

  private getLayout(): BrowserViewLayout {
    return {
      browserBounds: this.getBounds(this.browserViewport().nativeElement),
      devtoolsBounds: this.isDevtoolsOpen() ? this.getBounds(this.devtoolsViewport().nativeElement) : undefined,
      devtoolsVisible: this.isDevtoolsOpen(),
    };
  }

  private getBounds(element: HTMLDivElement): BrowserViewBounds {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  private getLayoutSignature(): string | null {
    if (!this.currentVisibleKey || !this.browserViewport()) {
      return null;
    }

    const state = this.browserState.getState(this.currentVisibleKey);
    if (!state || state.url === 'about:blank') {
      return null;
    }

    const browserBounds = this.getBounds(this.browserViewport().nativeElement);
    const devtoolsBounds = this.isDevtoolsOpen() ? this.getBounds(this.devtoolsViewport().nativeElement) : null;
    return JSON.stringify({
      key: this.currentVisibleKey,
      dockPosition: this.dockPosition(),
      devtoolsOpen: this.isDevtoolsOpen(),
      browserBounds,
      devtoolsBounds,
    });
  }

  private cleanup(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.handleWindowResize);
    this.removeStateListener?.();
    this.removeStateListener = null;
    this.stopDraggingDevtools();
    this.stopLayoutHeartbeat();
    this.stopLayoutBurst();

    if (this.api && this.currentVisibleKey) {
      void this.api.hide(this.currentVisibleKey);
    }

    for (const timeoutId of this.persistTimers.values()) {
      clearTimeout(timeoutId);
    }
    this.persistTimers.clear();

    this.currentVisibleKey = null;
    this.lastObservedLayoutSignature = null;
  }

  private scheduleDeferredBoundsSync(): void {
    requestAnimationFrame(() => {
      if (this.destroyRef.destroyed) return;
      void this.syncBounds();
      this.requestLayoutStabilization();

      requestAnimationFrame(() => {
        if (this.destroyRef.destroyed) return;
        void this.syncBounds();
        this.requestLayoutStabilization();
      });
    });
  }

  private stopDraggingDevtools(): void {
    this.removeDragListeners?.();
    this.removeDragListeners = null;
    this.isDraggingDevtools.set(false);
  }

  private startLayoutHeartbeat(): void {
    if (this.layoutHeartbeatTimer !== null) {
      return;
    }

    this.layoutHeartbeatTimer = setInterval(() => {
      void this.syncBoundsIfLayoutChanged();
    }, 1000);
  }

  private stopLayoutHeartbeat(): void {
    if (this.layoutHeartbeatTimer === null) {
      return;
    }

    clearInterval(this.layoutHeartbeatTimer);
    this.layoutHeartbeatTimer = null;
  }

  private requestLayoutStabilization(frames = 45): void {
    this.layoutBurstFramesRemaining = Math.max(this.layoutBurstFramesRemaining, frames);
    if (this.layoutBurstFrame !== null) {
      return;
    }

    const tick = () => {
      this.layoutBurstFrame = null;
      if (this.layoutBurstFramesRemaining <= 0) {
        return;
      }

      this.layoutBurstFramesRemaining -= 1;
      void this.syncBoundsIfLayoutChanged();

      if (this.layoutBurstFramesRemaining > 0) {
        this.layoutBurstFrame = requestAnimationFrame(tick);
      }
    };

    this.layoutBurstFrame = requestAnimationFrame(tick);
  }

  private stopLayoutBurst(): void {
    if (this.layoutBurstFrame === null) {
      return;
    }

    cancelAnimationFrame(this.layoutBurstFrame);
    this.layoutBurstFrame = null;
    this.layoutBurstFramesRemaining = 0;
  }

  private async syncBoundsIfLayoutChanged(): Promise<void> {
    const nextSignature = this.getLayoutSignature();
    if (!nextSignature || nextSignature === this.lastObservedLayoutSignature) {
      return;
    }

    this.lastObservedLayoutSignature = nextSignature;
    await this.syncBounds();
  }

  private syncUrlInput(url: string | undefined): void {
    if (this.isEditing()) {
      return;
    }

    this.urlInput.set(url && url !== 'about:blank' ? url : '');
  }

  private queuePersistSnapshot(projectId: number, snapshot: string): void {
    const existingTimer = this.persistTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timeoutId = setTimeout(() => {
      this.persistTimers.delete(projectId);
      this.persistedBrowserState.save(this.browserTabsState.createSnapshot(projectId)).subscribe({
        next: savedSnapshot => {
          this.persistedSnapshots.set(projectId, JSON.stringify(savedSnapshot));
        },
        error: () => {
          // Ignore save failures; browser still works in memory.
        },
      });
    }, 400);

    this.persistTimers.set(projectId, timeoutId);
    this.persistedSnapshots.set(projectId, snapshot);
  }

  private parseBrowserKey(browserKey: string): { projectId: number; tabId: string } | null {
    const match = /^project:(\d+):tab:(.+)$/.exec(browserKey);
    if (!match) {
      return null;
    }

    return {
      projectId: Number(match[1]),
      tabId: match[2],
    };
  }

  private getTabLabel(tab: ProjectBrowserTabState): string {
    if (tab.customTitle?.trim()) {
      return tab.customTitle.trim();
    }

    const state = this.browserState.getState(buildBrowserViewKey(this.projectId(), tab.tabId));
    if (state?.title?.trim()) {
      return state.title.trim();
    }

    if (tab.url && tab.url !== 'about:blank') {
      return this.getUrlLabel(tab.url);
    }

    return 'New tab';
  }

  private getSecondaryLabel(tab: ProjectBrowserTabState): string {
    if (!tab.url || tab.url === 'about:blank') {
      return 'Ready';
    }

    return tab.customTitle?.trim() ? this.getUrlLabel(tab.url) : tab.url.replace(/^https?:\/\//, '');
  }

  private getUrlLabel(rawUrl: string): string {
    try {
      const url = new URL(rawUrl);
      return url.host || rawUrl;
    } catch {
      return rawUrl;
    }
  }

  private waitForLayoutFrame(): Promise<void> {
    return new Promise(resolve => {
      requestAnimationFrame(() => resolve());
    });
  }

  private readDockPositionPreference(browserKey: string): DevtoolsDockPosition {
    if (typeof window === 'undefined') {
      return defaultDockPosition;
    }

    try {
      const value = window.localStorage?.getItem(this.getDockPreferenceKey(browserKey));
      return value === 'bottom' ? 'bottom' : 'right';
    } catch { return defaultDockPosition; }
  }

  private writeDockPositionPreference(browserKey: string, position: DevtoolsDockPosition): void {
    if (typeof window === 'undefined') {
      return;
    }

    try { window.localStorage?.setItem(this.getDockPreferenceKey(browserKey), position); }
    catch { /* Unavailable preference storage must not interrupt native view layout. */ }
  }

  private getDockPreferenceKey(browserKey: string): string {
    return `elevenex:browser-devtools-dock:${browserKey}`;
  }

  private clampDevtoolsRatio(nextRatio: number, surfaceRect: DOMRect): number {
    if (this.isSideBySide()) {
      const minRatio = minimumDevtoolsPaneWidth / Math.max(surfaceRect.width, 1);
      const maxRatio = 1 - minimumBrowserPaneWidth / Math.max(surfaceRect.width, 1);
      return Math.min(Math.max(nextRatio, minRatio), Math.max(minRatio, maxRatio));
    }

    const minRatio = minimumDevtoolsPaneHeight / Math.max(surfaceRect.height, 1);
    const maxRatio = 1 - minimumBrowserPaneHeight / Math.max(surfaceRect.height, 1);
    return Math.min(Math.max(nextRatio, minRatio), Math.max(minRatio, maxRatio));
  }
}
