import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
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
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import {
  BrowserViewBounds,
  BrowserViewLayout,
  BrowserViewState,
  getElectronBrowserApi,
} from '@/shared/runtime/electron-browser';
import {
  BrowserViewStateService,
  buildBrowserViewKey,
  buildBrowserViewProjectPrefix,
} from './browser-view-state.service';
import {
  ProjectBrowserStateService,
  ProjectBrowserTabState,
} from '@/shared/services/project-browser-state.service';
import { BrowserIsolationConfig } from '@/shared/models/browser-isolation.model';
import { BrowserIsolationService } from '@/shared/services/browser-isolation.service';
import { BrowserTabsStateService } from './browser-tabs-state.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';

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
  imports: [CommonModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  template: `
    <div
      class="browser-panel"
      [class.browser-panel--devtools-open]="isDevtoolsOpen()"
      [class.browser-panel--dragging]="isDraggingDevtools()"
      [style.--browser-devtools-size]="devtoolsPaneSize()"
      [style.--browser-devtools-grid-template]="devtoolsGridTemplate()"
    >
      <div class="browser-tabs-bar">
        <div class="browser-tabs-list" role="tablist" aria-label="Browser tabs">
          @for (tab of browserTabs(); track tab.tabId) {
            <div
              class="browser-tab-pill"
              [class.browser-tab-pill--active]="tab.tabId === activeTabId()"
              [class.browser-tab-pill--editing]="editingTabId() === tab.tabId"
              role="tab"
              [attr.aria-selected]="tab.tabId === activeTabId()"
              (click)="selectBrowserTab(tab.tabId)"
              (dblclick)="beginRename(tab.tabId)"
            >
              @if (editingTabId() === tab.tabId) {
                <input
                  class="browser-tab-pill-input"
                  type="text"
                  [value]="renameDraft()"
                  maxlength="80"
                  autofocus
                  (click)="$event.stopPropagation()"
                  (input)="renameDraft.set($any($event.target).value)"
                  (blur)="commitRename()"
                  (keydown.enter)="commitRename()"
                  (keydown.escape)="cancelRename()"
                />
              } @else {
                <button
                  type="button"
                  class="browser-tab-pill-main"
                  [title]="tab.label"
                  (click)="selectBrowserTab(tab.tabId)"
                >
                  <span class="browser-tab-pill-title">{{ tab.label }}</span>
                  <span class="browser-tab-pill-meta">{{ tab.secondaryLabel }}</span>
                </button>
              }

              <button
                type="button"
                class="browser-tab-pill-icon"
                [attr.aria-label]="'Close browser tab ' + tab.label"
                title="Close tab"
                (click)="closeBrowserTab($event, tab.tabId)"
              >
                <ng-icon name="lucideX" size="14" />
              </button>
            </div>
          }

          @if (canAddTab()) {
            <button
              type="button"
              class="browser-add-tab"
              aria-label="Open a new browser tab"
              title="New browser tab"
              (click)="addBrowserTab()"
            >
              <ng-icon name="lucidePlus" size="15" />
            </button>
          }
        </div>
      </div>

      <div class="browser-toolbar">
        <div class="browser-toolbar-group">
          <button
            type="button"
            class="browser-tool-button"
            [disabled]="!currentState()?.canGoBack"
            aria-label="Go back"
            title="Back"
            (click)="goBack()"
          >
            <ng-icon name="lucideArrowLeft" size="16" />
          </button>
          <button
            type="button"
            class="browser-tool-button"
            [disabled]="!currentState()?.canGoForward"
            aria-label="Go forward"
            title="Forward"
            (click)="goForward()"
          >
            <ng-icon name="lucideArrowRight" size="16" />
          </button>
          <button
            type="button"
            class="browser-tool-button"
            [disabled]="!activeTab()"
            aria-label="Reload"
            title="Reload"
            (click)="reload()"
          >
            @if (currentState()?.isLoading) {
              <ng-icon name="lucideLoaderCircle" size="16" class="browser-spinner" />
            } @else {
              <ng-icon name="lucideRefreshCw" size="16" />
            }
          </button>
        </div>

        <form class="browser-address-bar" (submit)="submitUrl($event)">
          <span class="browser-address-icon" aria-hidden="true">
            <ng-icon name="lucideGlobe" size="14" />
          </span>
          <input
            class="browser-address-input"
            type="text"
            [value]="urlInput()"
            [placeholder]="hasTabs() ? 'Enter a URL' : 'Create a tab to start browsing'"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            [disabled]="!activeTab()"
            (focus)="isEditing.set(true)"
            (blur)="handleInputBlur($event)"
            (input)="handleInput($event)"
          />
        </form>

        <div class="browser-toolbar-group browser-toolbar-group--meta">
          <div
            class="browser-chip browser-chip--context"
            [class.browser-chip--shared]="activeRuntimeContext() === 'shared'"
            [class.browser-chip--isolated]="activeRuntimeContext() === 'isolated'"
            [title]="activeRuntimeContext() === 'shared' ? 'This page is using the shared browser profile.' : 'This page is using the project-isolated browser profile.'"
          >
            <span class="browser-chip-text">{{ activeRuntimeContextLabel() }}</span>
          </div>

          @if (isDevtoolsOpen()) {
            <div class="browser-dock-toggle">
              <button
                type="button"
                class="browser-dock-button"
                [class.browser-dock-button--active]="dockPosition() === 'right'"
                aria-label="Dock DevTools to the right"
                title="Show DevTools side by side"
                (click)="setDockPosition('right')"
              >
                <ng-icon name="lucideColumns2" size="14" />
              </button>
              <button
                type="button"
                class="browser-dock-button"
                [class.browser-dock-button--active]="dockPosition() === 'bottom'"
                aria-label="Dock DevTools at the bottom"
                title="Show DevTools stacked"
                (click)="setDockPosition('bottom')"
              >
                <ng-icon name="lucideRows2" size="14" />
              </button>
            </div>
          }

          <button
            type="button"
            class="browser-devtools-toggle"
            [class.browser-devtools-toggle--active]="isDevtoolsOpen()"
            [disabled]="!hasLivePage()"
            [attr.aria-pressed]="isDevtoolsOpen()"
            [title]="isDevtoolsOpen() ? 'Hide embedded DevTools' : 'Show embedded DevTools'"
            (click)="toggleDevTools()"
          >
            <ng-icon name="lucideSquareTerminal" size="15" />
            <span>{{ isDevtoolsOpen() ? 'Hide tools' : 'Inspect' }}</span>
          </button>

          <button
            type="button"
            class="browser-tool-button"
            [class.browser-tool-button--active]="showSettingsPopover()"
            aria-label="Browser settings"
            title="Browser routing settings"
            (click)="toggleSettingsPopover($event)"
          >
            <ng-icon name="lucideSettings" size="15" />
          </button>
        </div>
      </div>

      @if (showSettingsPopover()) {
        <div class="browser-settings-popover" (click)="$event.stopPropagation()">
          <div class="browser-settings-popover-header">
            <span class="browser-settings-popover-title">Browser Routing</span>
            <button type="button" class="browser-settings-popover-close" (click)="showSettingsPopover.set(false)">
              <ng-icon name="lucideX" size="14" />
            </button>
          </div>
          <div class="browser-settings-mode-row">
            <button
              type="button"
              class="browser-settings-mode-btn"
              [class.browser-settings-mode-btn--active]="effectiveIsolationMode() === 'shared'"
              (click)="setIsolationMode('shared')"
            >
              <ng-icon name="lucideGlobe" size="14" />
              Shared
            </button>
            <button
              type="button"
              class="browser-settings-mode-btn"
              [class.browser-settings-mode-btn--active]="effectiveIsolationMode() === 'isolated'"
              (click)="setIsolationMode('isolated')"
            >
              <ng-icon name="lucideShield" size="14" />
              Isolated
            </button>
          </div>
          @if (effectiveIsolationMode() === 'isolated') {
            <div class="browser-settings-globs">
              <span class="browser-settings-globs-label">Shared browser URL patterns</span>
              <p class="browser-settings-globs-copy">
                Matching top-level URLs open in the shared browser profile. Non-matching URLs fall back to this project's isolated browser.
              </p>
              @if (effectiveSharedGlobs().length > 0) {
                <div class="browser-settings-glob-chips">
                  @for (glob of effectiveSharedGlobs(); track glob; let i = $index) {
                    <span class="browser-settings-glob-chip">
                      {{ glob }}
                      <button type="button" (click)="removeGlob(i)"><ng-icon name="lucideX" size="10" /></button>
                    </span>
                  }
                </div>
              }
              <div class="browser-settings-glob-input">
                <input
                  z-input
                  type="text"
                  placeholder="https://accounts.google.com/*"
                  [value]="settingsGlobInput()"
                  (input)="settingsGlobInput.set($any($event.target).value)"
                  (keydown.enter)="addGlob()"
                />
                <button z-button [zDisabled]="!settingsGlobInput().trim()" (click)="addGlob()">
                  <ng-icon name="lucidePlus" size="14" class="mr-1" />
                  Add
                </button>
              </div>
            </div>
          }
        </div>
      }

      <div #surface class="browser-surface">
        <div class="browser-stage-grid">
          <div #browserViewport class="browser-native-host browser-native-host--page"></div>

          <button
            type="button"
            class="browser-splitter"
            [class.browser-splitter--vertical]="isSideBySide()"
            [hidden]="!isDevtoolsOpen()"
            aria-label="Resize DevTools panel"
            title="Drag to resize DevTools"
            (pointerdown)="startDevtoolsResize($event)"
          >
            <span class="browser-splitter-grip"></span>
          </button>

          <div
            #devtoolsViewport
            class="browser-native-host browser-native-host--devtools"
            [class.browser-native-host--hidden]="!isDevtoolsOpen()"
          ></div>
        </div>

        @if (!isSupported()) {
          <div class="browser-overlay">
            <p class="browser-message">The browser panel is only available in the Electron app.</p>
          </div>
        } @else if (!hasTabs()) {
          <div class="browser-overlay">
            <div class="browser-empty-state">
              <p class="browser-message">Keep up to three live tabs attached to this project.</p>
              <p class="browser-caption">Tabs restore their URLs and custom names when you come back. DevTools stays available whenever a live page is open.</p>
              <button type="button" class="browser-empty-action" (click)="addBrowserTab()">
                <ng-icon name="lucidePlus" size="14" />
                Create first tab
              </button>
            </div>
          </div>
        } @else if (currentState()?.lastError) {
          <div class="browser-overlay browser-overlay--bottom">
            <p class="browser-error">{{ currentState()!.lastError }}</p>
          </div>
        } @else if (!currentState() || currentState()?.url === 'about:blank') {
          <div class="browser-overlay">
            <div class="browser-empty-state browser-empty-state--compact">
              <p class="browser-message">This tab is ready.</p>
              <p class="browser-caption">Enter a URL above to load a page, then rename the tab if you want a custom label.</p>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    .browser-panel {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      color: var(--foreground);
      --browser-devtools-grid-template: minmax(0, 1fr) 0 minmax(0, 0);
      background: var(--background);
    }

    .browser-tabs-bar,
    .browser-toolbar {
      padding: 0 0.5rem;
      border-bottom: 1px solid var(--border);
    }

    .browser-tabs-bar {
      display: flex;
      align-items: flex-end;
      min-height: 2rem;
      min-width: 0;
      background: color-mix(in oklch, var(--muted) 45%, var(--background));
    }

    .browser-tabs-list {
      display: flex;
      align-items: center;
      gap: 0;
      flex: 1;
      min-width: 0;
      width: 100%;
      padding-top: 0.3rem;
      overflow-x: auto;
      overflow-y: hidden;
    }

    .browser-tab-pill {
      display: flex;
      align-items: center;
      gap: 0.15rem;
      min-width: 0;
      flex: 0 1 13rem;
      max-width: 13rem;
      min-height: 1.8rem;
      padding: 0 0.25rem 0 0.55rem;
      border: 1px solid transparent;
      border-bottom: 0;
      border-radius: 0.7rem 0.7rem 0 0;
      background: color-mix(in oklch, var(--muted) 18%, transparent);
      transition: background-color 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease;
      box-shadow: inset 1px 0 0 color-mix(in oklch, var(--border) 72%, transparent);
      margin-left: -1px;
    }

    .browser-tab-pill:hover {
      background: color-mix(in oklch, var(--muted) 52%, var(--background));
    }

    .browser-tab-pill--active {
      position: relative;
      z-index: 1;
      background: var(--background);
      border-color: var(--border);
      box-shadow:
        inset 0 2px 0 color-mix(in oklch, var(--foreground) 18%, transparent),
        0 1px 0 var(--background);
    }

    .browser-tab-pill--active + .browser-tab-pill {
      box-shadow: none;
    }

    .browser-tab-pill-main {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 0.35rem;
      border: 0;
      padding: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }

    .browser-tab-pill-title,
    .browser-tab-pill-meta {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .browser-tab-pill-title {
      flex: 1;
      min-width: 0;
      font-size: 0.74rem;
      font-weight: 500;
      color: color-mix(in oklch, var(--foreground) 84%, var(--muted-foreground));
    }

    .browser-tab-pill-meta {
      flex-shrink: 0;
      max-width: 4.5rem;
      font-size: 0.68rem;
      color: color-mix(in oklch, var(--muted-foreground) 88%, transparent);
    }

    .browser-tab-pill--active .browser-tab-pill-title {
      color: var(--foreground);
      font-weight: 600;
    }

    .browser-tab-pill--active .browser-tab-pill-meta {
      color: var(--muted-foreground);
    }

    .browser-tab-pill-icon,
    .browser-add-tab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 1.45rem;
      height: 1.45rem;
      border-radius: 0.35rem;
      border: 0;
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
      transition: background-color 0.14s ease, color 0.14s ease;
    }

    .browser-tab-pill-icon:hover,
    .browser-add-tab:hover {
      color: var(--foreground);
      background: color-mix(in oklch, var(--muted) 80%, var(--background));
    }

    .browser-add-tab {
      width: 1.7rem;
      height: 1.7rem;
      margin-left: 0.25rem;
      border-radius: 9999px;
      border: 1px solid color-mix(in oklch, var(--border) 84%, transparent);
    }

    .browser-tab-pill-input {
      flex: 1;
      min-width: 0;
      height: 1.5rem;
      border-radius: 0.35rem;
      border: 1px solid var(--ring);
      background: var(--background);
      color: var(--foreground);
      padding: 0 0.5rem;
      font-size: 0.74rem;
      outline: none;
    }

    .browser-toolbar {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.4rem;
      min-width: 0;
      min-height: 2.2rem;
      background: var(--background);
    }

    .browser-toolbar-group {
      display: inline-flex;
      align-items: center;
      gap: 0.15rem;
      min-width: 0;
    }

    .browser-toolbar-group--meta {
      justify-content: flex-end;
    }

    .browser-tool-button,
    .browser-dock-button,
    .browser-devtools-toggle,
    .browser-empty-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      height: 1.7rem;
      border-radius: 0.4rem;
      border: 1px solid transparent;
      color: var(--muted-foreground);
      background: transparent;
      cursor: pointer;
      transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }

    .browser-tool-button {
      width: 1.7rem;
      flex-shrink: 0;
    }

    .browser-tool-button:hover:not(:disabled),
    .browser-dock-button:hover:not(:disabled),
    .browser-devtools-toggle:hover:not(:disabled),
    .browser-empty-action:hover {
      color: var(--foreground);
      background: color-mix(in oklch, var(--muted) 80%, var(--background));
    }

    .browser-tool-button:disabled,
    .browser-dock-button:disabled,
    .browser-devtools-toggle:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }

    .browser-tool-button--active {
      color: var(--foreground);
      background: color-mix(in oklch, var(--muted) 80%, var(--background));
    }

    .browser-address-bar {
      position: relative;
      display: flex;
      align-items: center;
      min-width: 0;
      width: 100%;
      overflow: hidden;
    }

    .browser-address-icon {
      position: absolute;
      left: 0.6rem;
      display: inline-flex;
      align-items: center;
      color: var(--muted-foreground);
      pointer-events: none;
    }

    .browser-address-input {
      width: 100%;
      min-width: 0;
      height: 1.75rem;
      padding: 0 0.75rem 0 1.9rem;
      border: 1px solid var(--border);
      border-radius: 9999px;
      background: color-mix(in oklch, var(--muted) 38%, var(--background));
      color: var(--foreground);
      font-size: 0.78rem;
      outline: none;
      transition: border-color 0.14s ease, box-shadow 0.14s ease, background-color 0.14s ease;
    }

    .browser-address-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .browser-address-input:focus {
      border-color: var(--ring);
      box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 18%, transparent);
      background: var(--background);
    }

    .browser-chip {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      max-width: 7rem;
      height: 1.55rem;
      padding: 0 0.5rem;
      border-radius: 9999px;
      border: 1px solid var(--border);
      background: var(--background);
      color: var(--muted-foreground);
      font-size: 0.68rem;
    }

    .browser-chip--context {
      font-weight: 600;
      letter-spacing: 0.01em;
    }

    .browser-chip--shared {
      color: color-mix(in oklch, oklch(0.44 0.12 210) 74%, var(--foreground));
      background: color-mix(in oklch, oklch(0.92 0.02 220) 42%, var(--background));
    }

    .browser-chip--isolated {
      color: color-mix(in oklch, oklch(0.44 0.13 160) 72%, var(--foreground));
      background: color-mix(in oklch, oklch(0.91 0.02 160) 44%, var(--background));
    }

    .browser-chip-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .browser-dock-toggle {
      display: inline-flex;
      align-items: center;
      padding: 0.1rem;
      border-radius: 9999px;
      border: 1px solid var(--border);
      background: var(--background);
    }

    .browser-dock-button {
      width: 1.5rem;
      height: 1.45rem;
      border-radius: 9999px;
    }

    .browser-dock-button--active {
      color: var(--foreground);
      background: color-mix(in oklch, var(--muted) 70%, var(--background));
    }

    .browser-devtools-toggle {
      padding: 0 0.55rem;
      min-width: 5.6rem;
      font-size: 0.73rem;
      font-weight: 500;
      border-color: var(--border);
      background: var(--background);
    }

    .browser-devtools-toggle--active,
    .browser-empty-action {
      color: var(--foreground);
      background: color-mix(in oklch, var(--muted) 80%, var(--background));
      border-color: var(--border);
    }

    .browser-settings-popover {
      position: absolute;
      z-index: 50;
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      background: var(--background);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    }

    .browser-settings-popover {
      top: 4rem;
      right: 0.6rem;
      width: 20rem;
      padding: 0.7rem;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }

    .browser-settings-popover-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .browser-settings-popover-title {
      font-size: 0.78rem;
      font-weight: 600;
      color: var(--foreground);
    }

    .browser-settings-popover-close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.4rem;
      height: 1.4rem;
      border: none;
      border-radius: 9999px;
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
    }

    .browser-settings-popover-close:hover {
      background: color-mix(in oklch, var(--muted) 80%, transparent);
      color: var(--foreground);
    }

    .browser-settings-mode-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.4rem;
    }

    .browser-settings-mode-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.35rem;
      padding: 0.42rem 0.6rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      background: transparent;
      color: var(--muted-foreground);
      font-size: 0.76rem;
      font-weight: 500;
      cursor: pointer;
    }

    .browser-settings-mode-btn--active {
      border-color: var(--primary);
      background: color-mix(in oklch, var(--primary) 10%, transparent);
      color: var(--foreground);
    }

    .browser-settings-globs {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .browser-settings-globs-copy {
      margin: 0;
      color: var(--muted-foreground);
      font-size: 0.75rem;
      line-height: 1.45;
    }

    .browser-settings-globs-label {
      font-size: 0.71rem;
      font-weight: 600;
      color: var(--muted-foreground);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .browser-settings-glob-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
    }

    .browser-settings-glob-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.18rem 0.45rem;
      border-radius: 9999px;
      border: 1px solid var(--border);
      background: color-mix(in oklch, var(--muted) 36%, var(--background));
      font-size: 0.71rem;
      color: var(--foreground);
    }

    .browser-settings-glob-chip button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0.9rem;
      height: 0.9rem;
      border: none;
      border-radius: 9999px;
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
    }

    .browser-settings-glob-chip button:hover {
      color: var(--destructive);
    }

    .browser-settings-glob-input {
      display: flex;
      gap: 0.35rem;
      align-items: center;
    }

    .browser-settings-glob-input input {
      flex: 1;
      min-width: 0;
      height: 1.7rem;
      font-size: 0.78rem;
    }

    .browser-settings-glob-input button {
      flex-shrink: 0;
      height: 1.7rem;
      font-size: 0.72rem;
      padding: 0 0.55rem;
    }

    .browser-surface {
      position: relative;
      flex: 1;
      min-height: 0;
      background: var(--background);
    }

    .browser-stage-grid {
      display: grid;
      grid-template: var(--browser-devtools-grid-template);
      height: 100%;
      min-height: 0;
      gap: 0;
      overflow: hidden;
    }

    .browser-native-host {
      position: relative;
      min-height: 0;
      overflow: hidden;
      background: var(--background);
    }

    .browser-native-host--devtools {
      background: color-mix(in oklch, var(--muted) 24%, var(--background));
    }

    .browser-native-host--hidden {
      visibility: hidden;
      pointer-events: none;
    }

    .browser-splitter {
      position: relative;
      height: 0.35rem;
      border: 0;
      padding: 0;
      background: var(--border);
      cursor: row-resize;
    }

    .browser-splitter--vertical {
      width: 0.35rem;
      height: auto;
      cursor: col-resize;
    }

    .browser-splitter-grip {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 1.2rem;
      height: 0.12rem;
      border-radius: 9999px;
      transform: translate(-50%, -50%);
      background: color-mix(in oklch, var(--muted-foreground) 48%, transparent);
    }

    .browser-splitter--vertical .browser-splitter-grip {
      width: 0.12rem;
      height: 1.2rem;
    }

    .browser-panel--dragging .browser-splitter-grip,
    .browser-splitter:hover .browser-splitter-grip {
      background: color-mix(in oklch, var(--foreground) 42%, var(--muted-foreground));
    }

    .browser-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.7rem;
      pointer-events: none;
    }

    .browser-overlay--bottom {
      align-items: flex-end;
      justify-content: flex-start;
    }

    .browser-empty-state {
      max-width: 28rem;
      display: grid;
      gap: 0.45rem;
      padding: 0.9rem 1rem;
      border-radius: 0.75rem;
      border: 1px solid var(--border);
      background: var(--background);
      pointer-events: auto;
    }

    .browser-empty-state--compact {
      max-width: 24rem;
    }

    .browser-message,
    .browser-error,
    .browser-caption {
      margin: 0;
      line-height: 1.55;
    }

    .browser-message {
      color: var(--foreground);
      font-size: 0.84rem;
      font-weight: 600;
    }

    .browser-caption {
      color: var(--muted-foreground);
      font-size: 0.74rem;
    }

    .browser-empty-action {
      pointer-events: auto;
      width: fit-content;
      padding: 0 0.7rem;
    }

    .browser-error {
      max-width: 30rem;
      padding: 0.55rem 0.75rem;
      border-radius: 0.6rem;
      border: 1px solid color-mix(in oklch, var(--destructive) 42%, var(--border));
      background: var(--background);
      color: color-mix(in oklch, var(--destructive) 82%, var(--foreground));
      pointer-events: auto;
    }

    .browser-spinner {
      animation: browser-spin 0.8s linear infinite;
    }

    @keyframes browser-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `],
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

  @ViewChild('surface', { static: true }) surface!: ElementRef<HTMLDivElement>;
  @ViewChild('browserViewport', { static: true }) browserViewport!: ElementRef<HTMLDivElement>;
  @ViewChild('devtoolsViewport', { static: true }) devtoolsViewport!: ElementRef<HTMLDivElement>;

  private readonly api = getElectronBrowserApi();
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

    this.isSupported.set(await this.api.isSupported());
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

    this.resizeObserver.observe(this.surface.nativeElement);
    this.resizeObserver.observe(this.browserViewport.nativeElement);
    this.resizeObserver.observe(this.devtoolsViewport.nativeElement);
    window.addEventListener('resize', this.handleWindowResize, { passive: true });

    await this.ensureHydrated(this.projectId());
    const currentKey = this.currentKey();
    this.currentVisibleKey = currentKey;
    await this.showCurrentBrowser(currentKey);
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
      const surfaceRect = this.surface.nativeElement.getBoundingClientRect();
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
    if (!this.api || !this.isSupported() || !this.browserViewport) {
      return;
    }

    const projectId = this.projectId();
    await this.ensureHydrated(projectId);

    const previousKey = this.currentVisibleKey;
    this.currentVisibleKey = nextKey;
    this.devtoolsIntent.set(null);
    this.isEditing.set(false);

    if (previousKey && previousKey !== nextKey) {
      await this.api.hide(previousKey);
    }

    await this.showCurrentBrowser(nextKey);
    this.scheduleDeferredBoundsSync();
  }

  private async ensureHydrated(projectId: number): Promise<void> {
    if (this.hydratedProjects.has(projectId)) {
      return;
    }

    try {
      const snapshot = await firstValueFrom(this.persistedBrowserState.get(projectId));
      this.browserTabsState.hydrate(snapshot);
      this.persistedSnapshots.set(projectId, JSON.stringify(snapshot));
    } catch {
      const emptySnapshot = this.browserTabsState.createSnapshot(projectId);
      this.browserTabsState.hydrate(emptySnapshot);
      this.persistedSnapshots.set(projectId, JSON.stringify(emptySnapshot));
    } finally {
      this.hydratedProjects.add(projectId);
    }
  }

  private async showCurrentBrowser(browserKey: string | null): Promise<void> {
    if (!this.api || !this.isSupported() || !this.browserViewport || !browserKey) {
      this.syncUrlInput(undefined);
      return;
    }

    const currentState = await this.api.getState(browserKey);
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
    const hydratedState = await this.api.getState(browserKey);
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
    if (!this.api || !this.isSupported() || !this.currentVisibleKey || !this.browserViewport) {
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
      browserBounds: this.getBounds(this.browserViewport.nativeElement),
      devtoolsBounds: this.isDevtoolsOpen() ? this.getBounds(this.devtoolsViewport.nativeElement) : undefined,
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
    if (!this.currentVisibleKey || !this.browserViewport) {
      return null;
    }

    const state = this.browserState.getState(this.currentVisibleKey);
    if (!state || state.url === 'about:blank') {
      return null;
    }

    const browserBounds = this.getBounds(this.browserViewport.nativeElement);
    const devtoolsBounds = this.isDevtoolsOpen() ? this.getBounds(this.devtoolsViewport.nativeElement) : null;
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
      void this.syncBounds();
      this.requestLayoutStabilization();

      requestAnimationFrame(() => {
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

    const value = window.localStorage.getItem(this.getDockPreferenceKey(browserKey));
    return value === 'bottom' ? 'bottom' : 'right';
  }

  private writeDockPositionPreference(browserKey: string, position: DevtoolsDockPosition): void {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(this.getDockPreferenceKey(browserKey), position);
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
