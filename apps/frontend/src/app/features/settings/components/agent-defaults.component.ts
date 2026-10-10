import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFileText,
  lucideNotebookPen,
  lucidePlus,
  lucideSparkles,
  lucideTrash2,
  lucideArrowLeft,
  lucideCheck,
  lucideCopy,
  lucideStar,
  lucideZap,
} from '@ng-icons/lucide';
import {
  AGENT_PROVIDER_ICONS,
  AGENT_PROVIDER_PRESENTATIONS,
} from '@/shared/models/agent-provider-presentation';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { AgentModelCatalogService } from '@/shared/services/agent-model-catalog.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { OptionSelectComponent, OptionSelectItem } from '@/shared/components/option-select';
import { PresetOptionsBadges } from './preset-options-badges.component';
import { ZardCheckboxComponent } from '@/shared/components/checkbox';
import {
  AGENT_DEFAULT_OPTION,
  toModelOption,
  withPinnedModel,
} from '@/shared/models/agent-model-options';
import { AgentModelPreset, DefaultAgentProvider } from '@/shared/models/app-settings.model';

/**
 * Icons for the providers we ship. A provider the backend reports that isn't
 * listed here still renders — it just falls back to a generic icon and its
 * server-provided display name, so nothing has to change here to support one.
 */
const PROVIDER_ICONS: Record<string, string> = AGENT_PROVIDER_ICONS;

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const EFFORT_HINTS: Record<string, string> = {
  low: 'Fastest responses',
  medium: 'Balanced reasoning',
  high: 'Deep reasoning',
  xhigh: 'More depth where supported',
  max: 'Maximum effort where supported',
};

@Component({
  selector: 'app-agent-defaults',
  imports: [
    FormsModule,
    NgIcon,
    OptionSelectComponent,
    ZardButtonComponent,
    ZardInputDirective,
    ZardCheckboxComponent,
    PresetOptionsBadges,
  ],
  templateUrl: './agent-defaults.component.html',
  viewProviders: [
    provideIcons({
      lucideFileText,
      lucideNotebookPen,
      lucidePlus,
      lucideSparkles,
      lucideTrash2,
      lucideArrowLeft,
      lucideCheck,
      lucideCopy,
      lucideStar,
      lucideZap,
    }),
  ],
})
export class AgentDefaults {
  readonly appSettings = inject(AppSettingsService);
  readonly catalog = inject(AgentModelCatalogService);

  readonly editingPresetId = signal<string | null>(null);
  readonly presetEditorOpen = signal(false);
  readonly presetName = signal('');
  readonly presetProvider = signal('claude');
  readonly presetModel = signal('');
  readonly presetEffort = signal('');
  readonly presetFastMode = signal(false);
  readonly presetIsDefault = signal(false);
  readonly presetUseForNewSessions = signal(false);
  readonly defaultPreset = computed(() =>
    this.appSettings.settings().agentModelPresets.find((preset) => this.isSessionDefault(preset)),
  );
  readonly presetProviderLabel = computed(() => this.providerLabel(this.presetProvider()));
  readonly defaultUsageOptions = computed<OptionSelectItem[]>(() => [
    {
      value: 'manual',
      label: 'Only when I choose it',
      description: 'Keep it ready in the session launcher.',
    },
    {
      value: 'agent',
      label: `Whenever I use ${this.presetProviderLabel()}`,
      description: 'The default setup for this agent.',
    },
    {
      value: 'sessions',
      label: 'Every new session',
      description: 'Start with this agent and this setup.',
    },
  ]);
  readonly selectedEffortHint = computed(
    () =>
      this.presetEffortOptions().find((option) => option.value === this.presetEffort())
        ?.description ?? 'Let the agent choose how much to think.',
  );
  readonly selectedModelLabel = computed(
    () =>
      this.presetModelOptions().find((option) => option.value === this.presetModel())?.label ??
      'Agent default',
  );
  readonly defaultUsage = computed(() =>
    this.presetUseForNewSessions() ? 'sessions' : this.presetIsDefault() ? 'agent' : 'manual',
  );
  readonly defaultProviderLabel = computed(
    () =>
      this.catalog
        .catalogs()
        .find((item) => item.provider === this.appSettings.settings().defaultAgentProvider)
        ?.displayName ?? this.appSettings.settings().defaultAgentProvider,
  );
  readonly presetSupportsFastMode = computed(() => {
    const catalog = this.presetCatalog();
    return (
      catalog?.models.find(
        (item) => item.id === (this.presetModel() || catalog.providerDefaultModelId),
      )?.supportsFastMode === true
    );
  });
  readonly canAddPreset = computed(() => this.appSettings.settings().agentModelPresets.length < 24);

  readonly providerOptions = computed<OptionSelectItem[]>(() =>
    this.catalog.catalogs().map((catalog) => ({
      value: catalog.provider,
      label: catalog.displayName || catalog.provider,
    })),
  );
  readonly presetCatalog = computed(() =>
    this.catalog.catalogs().find((catalog) => catalog.provider === this.presetProvider()),
  );
  readonly presetCanChooseEffort = computed(
    () =>
      this.presetCatalog()?.models.find((item) => item.id === this.presetModel())
        ?.supportsEffort !== false,
  );
  readonly presetModelOptions = computed<OptionSelectItem[]>(() => {
    const catalog = this.presetCatalog();
    if (!catalog) return [AGENT_DEFAULT_OPTION];
    return [
      AGENT_DEFAULT_OPTION,
      ...withPinnedModel(catalog.models, this.presetModel()).map((model) =>
        toModelOption(model, catalog),
      ),
    ];
  });
  readonly presetEffortOptions = computed<OptionSelectItem[]>(() => {
    const catalog = this.presetCatalog();
    const model = catalog?.models.find((item) => item.id === this.presetModel());
    if (model?.supportsEffort === false) return [AGENT_DEFAULT_OPTION];
    const efforts = model?.reasoningEfforts?.length
      ? model.reasoningEfforts
      : (catalog?.reasoningEfforts ?? []);
    const selected = this.presetEffort();
    const available = selected && !efforts.includes(selected) ? [...efforts, selected] : efforts;
    return [
      AGENT_DEFAULT_OPTION,
      ...available.map((effort) => ({
        value: effort,
        label: EFFORT_LABELS[effort] ?? effort,
        description: EFFORT_HINTS[effort],
      })),
    ];
  });

  constructor() {
    void this.appSettings.load().catch(() => undefined);
    void this.catalog.load().catch(() => undefined);
  }

  reload(): void {
    void this.catalog.refresh().catch(() => undefined);
  }

  openNewPreset(): void {
    if (this.appSettings.saving() || !this.canAddPreset()) return;
    const provider = this.appSettings.settings().defaultAgentProvider;
    this.editingPresetId.set(null);
    this.presetName.set('');
    this.presetFastMode.set(false);
    this.presetIsDefault.set(false);
    this.presetUseForNewSessions.set(false);
    this.presetProvider.set(provider);
    this.presetModel.set('');
    this.presetEffort.set('');
    this.presetEditorOpen.set(true);
  }

  editPreset(preset: AgentModelPreset): void {
    if (this.appSettings.saving()) return;
    this.editingPresetId.set(preset.id);
    this.presetName.set(preset.name);
    this.presetFastMode.set(preset.fastMode ?? false);
    this.presetIsDefault.set(preset.isDefault ?? false);
    this.presetUseForNewSessions.set(this.isSessionDefault(preset));
    this.presetProvider.set(preset.provider);
    this.presetModel.set(preset.model ?? '');
    this.presetEffort.set(preset.reasoningEffort ?? '');
    this.presetEditorOpen.set(true);
  }

  onPresetProviderChange(provider: string): void {
    if (provider === this.presetProvider()) return;
    this.presetProvider.set(provider);
    this.presetModel.set('');
    this.presetEffort.set('');
    this.presetFastMode.set(false);
  }

  onPresetModelChange(model: string): void {
    this.presetModel.set(model);
    this.presetEffort.set('');
    if (!this.presetSupportsFastMode()) this.presetFastMode.set(false);
  }

  onDefaultUsageChange(value: string): void {
    this.presetIsDefault.set(value !== 'manual');
    this.presetUseForNewSessions.set(value === 'sessions');
  }

  savePreset(): void {
    const name = this.presetName().trim() || this.suggestedName();
    if (this.appSettings.saving() || (!this.editingPresetId() && !this.canAddPreset())) return;
    const id = this.editingPresetId() ?? crypto.randomUUID();
    const preset: AgentModelPreset = {
      id,
      name,
      provider: this.presetProvider(),
      model: this.presetModel() || null,
      fastMode: this.presetSupportsFastMode() && this.presetFastMode(),
      isDefault: this.presetIsDefault() || this.presetUseForNewSessions(),
      reasoningEffort: this.presetCanChooseEffort() ? this.presetEffort() || null : null,
    };
    const current = this.appSettings.settings().agentModelPresets;
    const next = current.some((item) => item.id === id)
      ? current.map((item) => (item.id === id ? preset : item))
      : [...current, preset];
    void this.appSettings
      .savePresetConfiguration({
        agentModelPresets: next.map((item) =>
          item.id !== id && item.provider === preset.provider && preset.isDefault
            ? { ...item, isDefault: false }
            : item,
        ),
        ...(this.presetUseForNewSessions()
          ? { defaultAgentProvider: preset.provider as DefaultAgentProvider }
          : {}),
      })
      .then(() => {
        this.presetEditorOpen.set(false);
      })
      .catch(() => toast.error('Could not save the preset.'));
  }

  deletePreset(preset: AgentModelPreset): void {
    if (this.appSettings.saving()) return;
    const next = this.appSettings
      .settings()
      .agentModelPresets.filter((item) => item.id !== preset.id);
    void this.appSettings
      .saveAgentModelPresets(next)
      .then(() => {
        if (this.editingPresetId() === preset.id) this.presetEditorOpen.set(false);
      })
      .catch(() => toast.error('Could not delete the preset.'));
  }

  presetSummary(preset: AgentModelPreset): string {
    const provider = this.catalog.catalogs().find((item) => item.provider === preset.provider);
    const model = provider?.models.find((item) => item.id === preset.model);
    const parts = [
      provider?.displayName ?? preset.provider,
      model?.displayName ?? preset.model ?? 'Agent default',
    ];
    if (preset.reasoningEffort)
      parts.push(EFFORT_LABELS[preset.reasoningEffort] ?? preset.reasoningEffort);
    if (preset.fastMode) parts.push('Fast mode');
    return parts.join(' · ');
  }

  presetIcon(provider: string): string {
    return PROVIDER_ICONS[provider] || 'lucideSparkles';
  }

  isSessionDefault(preset: AgentModelPreset): boolean {
    return (
      preset.isDefault === true &&
      preset.provider === this.appSettings.settings().defaultAgentProvider
    );
  }

  makeDefault(preset: AgentModelPreset): void {
    if (this.appSettings.saving()) return;
    void this.appSettings
      .savePresetConfiguration({
        defaultAgentProvider: preset.provider as DefaultAgentProvider,
        agentModelPresets: this.appSettings
          .settings()
          .agentModelPresets.map((item) =>
            item.provider === preset.provider
              ? { ...item, isDefault: item.id === preset.id }
              : item,
          ),
      })
      .catch(() => toast.error('Could not change the default preset.'));
  }

  duplicatePreset(preset: AgentModelPreset): void {
    if (this.appSettings.saving() || !this.canAddPreset()) return;
    this.editPreset({ ...preset, name: `${preset.name.slice(0, 43)} copy`, isDefault: false });
    this.editingPresetId.set(null);
    this.presetUseForNewSessions.set(false);
  }

  providerLabel(provider: string): string {
    return (
      AGENT_PROVIDER_PRESENTATIONS.find((item) => item.id === provider)?.label ??
      this.catalog.catalogs().find((item) => item.provider === provider)?.displayName ??
      provider
    );
  }

  modelLabel(preset: AgentModelPreset): string {
    return (
      this.catalog
        .catalogs()
        .find((item) => item.provider === preset.provider)
        ?.models.find((item) => item.id === preset.model)?.displayName ??
      preset.model ??
      'Agent default'
    );
  }

  effortLabel(effort: string | null): string {
    return effort ? (EFFORT_LABELS[effort] ?? effort) : 'Automatic thinking';
  }

  suggestedName(): string {
    const catalog = this.presetCatalog();
    const model = catalog?.models.find((item) => item.id === this.presetModel());
    return [
      catalog?.displayName ?? this.presetProvider(),
      model?.displayName,
      this.presetFastMode() ? 'Fast' : null,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 48);
  }
}
