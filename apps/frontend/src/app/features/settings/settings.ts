import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideArrowUpRight,
  lucideCheckSquare,
  lucideClipboardList,
  lucideFileText,
  lucideFolderTree,
  lucideGitPullRequest,
  lucideGlobe,
  lucideGripVertical,
  lucideMinus,
  lucideMonitor,
  lucideNotebookPen,
  lucideOrbit,
  lucidePanelRight,
  lucidePlay,
  lucidePlus,
  lucideRotateCcw,
  lucideSettings,
  lucideSparkles,
  lucideSquareTerminal,
  lucideTerminal,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import {
  DefaultAgentProvider,
  DefaultClaudeSessionSurface,
  MAX_WORKTREES_PER_REPO_CEILING,
} from '@/shared/models/app-settings.model';
import { AGENT_PROVIDER_PRESENTATIONS } from '@/shared/models/agent-provider-presentation';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardCheckboxComponent } from '@/shared/components/checkbox';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentDefaults } from './components/agent-defaults.component';
import { BackendRestartComponent } from './components/backend-restart.component';
import { AppUpdateComponent } from './components/app-update.component';
import { SpeechToTextSettingsComponent } from './components/speech-to-text.component';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';
import { FRONTEND_GIT_SHA } from '../../../build-info';
import { LocalComputerBashService } from '@/shared/services/local-computer-bash.service';
import {
  SESSION_TOOLBAR_BUTTON_DEFINITION_MAP,
  SessionToolbarButtonPreference,
} from '@/shared/models/session-toolbar-button.model';

@Component({
  selector: 'app-settings',
  imports: [
    AgentDefaults,
    AppUpdateComponent,
    BackendRestartComponent,
    DragDropModule,
    FormsModule,
    NgIcon,
    ZardButtonComponent,
    ZardCheckboxComponent,
    ZardInputDirective,
    SpeechToTextSettingsComponent,
  ],
  templateUrl: './settings.html',
  host: { class: 'block flex-1 overflow-y-auto' },
  viewProviders: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideArrowUpRight,
      lucideCheckSquare,
      lucideClipboardList,
      lucideFileText,
      lucideFolderTree,
      lucideGitPullRequest,
      lucideGlobe,
      lucideGripVertical,
      lucideMinus,
      lucideMonitor,
      lucideNotebookPen,
      lucideOrbit,
      lucidePanelRight,
      lucidePlay,
      lucidePlus,
      lucideRotateCcw,
      lucideSettings,
      lucideSparkles,
      lucideSquareTerminal,
      lucideTerminal,
      lucideTriangleAlert,
    }),
  ],
})
export class Settings {
  private readonly http = inject(HttpClient);
  private readonly externalLinks = getElectronExternalLinksApi();
  readonly appSettings = inject(AppSettingsService);
  readonly localComputerBash = inject(LocalComputerBashService);

  readonly agentProviders = AGENT_PROVIDER_PRESENTATIONS;
  readonly frontendSha = FRONTEND_GIT_SHA.slice(0, 7);
  readonly backendSha = signal('...');
  readonly maxWorktreesCeiling = MAX_WORKTREES_PER_REPO_CEILING;
  readonly maxWorktreesPerRepo = computed(() => this.appSettings.settings().maxWorktreesPerRepo);
  /**
   * Kept separate from `appSettings.error()` so a rejected keystroke ("101")
   * reads as feedback on this field rather than as a failed save.
   */
  readonly maxWorktreesError = signal<string | null>(null);
  readonly toolbarButtons = this.appSettings.normalizedSessionToolbarButtons;
  readonly visibleToolbarButtons = computed(() =>
    this.toolbarButtons().filter((button) => button.visible),
  );

  constructor() {
    void this.appSettings.load().catch(() => undefined);
    this.http.get<{ backendSha: string }>('/api/info').subscribe({
      next: ({ backendSha }) => this.backendSha.set(backendSha.slice(0, 7)),
      error: () => this.backendSha.set('unknown'),
    });
  }

  selectSurface(surface: DefaultClaudeSessionSurface): void {
    if (
      this.appSettings.saving() ||
      this.appSettings.settings().defaultClaudeSessionSurface === surface
    ) {
      return;
    }

    void this.appSettings
      .saveDefaultClaudeSessionSurface(surface)
      .catch(() => toast.error('Could not save settings.'));
  }

  selectAgent(provider: DefaultAgentProvider): void {
    if (
      this.appSettings.saving() ||
      this.appSettings.settings().defaultAgentProvider === provider
    ) {
      return;
    }

    void this.appSettings
      .saveDefaultAgentProvider(provider)
      .catch(() => toast.error('Could not save settings.'));
  }

  setLocalBashEnabled(enabled: boolean): void {
    void this.localComputerBash
      .setEnabled(enabled)
      .catch(() => toast.error('Could not update local computer Bash access.'));
  }

  stepMaxWorktrees(delta: -1 | 1): void {
    void this.saveMaxWorktrees(this.maxWorktreesPerRepo() + delta);
  }

  /**
   * Saves on every accepted edit — like the rest of this page, which has no
   * save button. An out-of-range or half-typed value is reported inline and
   * left unsaved rather than clamped, so the field never silently disagrees
   * with what the user meant.
   */
  onMaxWorktreesInput(value: number | string | null): void {
    const parsed = typeof value === 'string' ? Number(value.trim()) : value;
    if (parsed === null || parsed === undefined || Number.isNaN(parsed)) {
      this.maxWorktreesError.set('Enter a whole number (0 removes the limit).');
      return;
    }
    void this.saveMaxWorktrees(parsed);
  }

  toolbarButtonLabel(id: string): string {
    return SESSION_TOOLBAR_BUTTON_DEFINITION_MAP.get(id)?.label ?? id;
  }

  toolbarButtonDescription(id: string): string {
    return SESSION_TOOLBAR_BUTTON_DEFINITION_MAP.get(id)?.description ?? '';
  }

  toolbarButtonIcon(id: string): string {
    return SESSION_TOOLBAR_BUTTON_DEFINITION_MAP.get(id)?.iconName ?? 'lucideSettings';
  }

  reorderToolbarButtons(event: CdkDragDrop<SessionToolbarButtonPreference[]>): void {
    if (this.appSettings.saving() || event.previousIndex === event.currentIndex) {
      return;
    }

    const next = [...this.toolbarButtons()];
    moveItemInArray(next, event.previousIndex, event.currentIndex);
    void this.saveToolbarButtons(next);
  }

  moveToolbarButton(index: number, direction: -1 | 1): void {
    if (this.appSettings.saving()) {
      return;
    }

    const nextIndex = index + direction;
    const next = [...this.toolbarButtons()];
    if (nextIndex < 0 || nextIndex >= next.length) {
      return;
    }

    moveItemInArray(next, index, nextIndex);
    void this.saveToolbarButtons(next);
  }

  setToolbarButtonVisibility(id: string, visible: boolean): Promise<void> {
    if (this.appSettings.saving()) {
      return Promise.resolve();
    }

    const next = this.toolbarButtons().map((button) =>
      button.id === id ? { ...button, visible } : button,
    );
    return this.saveToolbarButtons(next);
  }

  resetToolbarButtons(): Promise<void> {
    if (this.appSettings.saving()) {
      return Promise.resolve();
    }

    return this.appSettings
      .saveSessionToolbarButtons(null)
      .then(() => undefined)
      .catch(() => {
        toast.error('Could not reset session toolbar.');
      });
  }

  async openExternal(url: string, event: MouseEvent) {
    event.preventDefault();

    if (this.externalLinks) {
      await this.externalLinks.open(url);
      return;
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private saveMaxWorktrees(value: number): Promise<void> {
    if (this.appSettings.saving() || value === this.maxWorktreesPerRepo()) {
      return Promise.resolve();
    }
    if (!Number.isInteger(value) || value < 0 || value > this.maxWorktreesCeiling) {
      this.maxWorktreesError.set(
        `Pick a whole number between 0 and ${this.maxWorktreesCeiling} (0 removes the limit).`,
      );
      return Promise.resolve();
    }

    this.maxWorktreesError.set(null);
    return this.appSettings
      .saveMaxWorktreesPerRepo(value)
      .then(() => undefined)
      .catch(() => {
        toast.error('Could not save the worktree limit.');
      });
  }

  private saveToolbarButtons(buttons: SessionToolbarButtonPreference[]): Promise<void> {
    return this.appSettings
      .saveSessionToolbarButtons(buttons)
      .then(() => undefined)
      .catch(() => {
        toast.error('Could not save session toolbar.');
      });
  }
}
