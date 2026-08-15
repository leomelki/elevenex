import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  DragDropModule,
  CdkDragDrop,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
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
  lucideGem,
  lucideGitPullRequest,
  lucideGlobe,
  lucideGripVertical,
  lucideMonitor,
  lucideNotebookPen,
  lucidePanelRight,
  lucidePlay,
  lucideRotateCcw,
  lucideSettings,
  lucideSparkles,
  lucideSquareTerminal,
  lucideTerminal,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { DefaultAgentProvider, DefaultClaudeSessionSurface } from '@/shared/models/app-settings.model';
import { AGENT_PROVIDER_PRESENTATIONS } from '@/shared/models/agent-provider-presentation';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardCheckboxComponent } from '@/shared/components/checkbox';
import { AgentDefaults } from './components/agent-defaults.component';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';
import { FRONTEND_GIT_SHA } from '../../../build-info';
import {
  SESSION_TOOLBAR_BUTTON_DEFINITION_MAP,
  SessionToolbarButtonPreference,
} from '@/shared/models/session-toolbar-button.model';

@Component({
  selector: 'app-settings',
  imports: [
    AgentDefaults,
    DragDropModule,
    FormsModule,
    NgIcon,
    ZardButtonComponent,
    ZardCheckboxComponent,
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
      lucideGem,
      lucideGitPullRequest,
      lucideGlobe,
      lucideGripVertical,
      lucideMonitor,
      lucideNotebookPen,
      lucidePanelRight,
      lucidePlay,
      lucideRotateCcw,
      lucideSettings,
      lucideSparkles,
      lucideSquareTerminal,
      lucideTerminal,
    }),
  ],
})
export class Settings {
  private readonly http = inject(HttpClient);
  private readonly externalLinks = getElectronExternalLinksApi();
  readonly appSettings = inject(AppSettingsService);

  readonly agentProviders = AGENT_PROVIDER_PRESENTATIONS;
  readonly frontendSha = FRONTEND_GIT_SHA.slice(0, 7);
  readonly backendSha = signal('...');
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

  private saveToolbarButtons(
    buttons: SessionToolbarButtonPreference[],
  ): Promise<void> {
    return this.appSettings
      .saveSessionToolbarButtons(buttons)
      .then(() => undefined)
      .catch(() => {
        toast.error('Could not save session toolbar.');
      });
  }
}
