import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFileText,
  lucideNotebookPen,
  lucideOrbit,
  lucidePencil,
  lucidePlus,
  lucideRefreshCw,
  lucideSparkles,
  lucideTriangleAlert,
  lucideTrash2,
} from '@ng-icons/lucide';
import { AGENT_PROVIDER_ICONS } from '@/shared/models/agent-provider-presentation';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { AgentModelCatalogService } from '@/shared/services/agent-model-catalog.service';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { OptionSelectComponent, OptionSelectItem } from '@/shared/components/option-select';
import { AgentProviderModelCatalog } from '@/shared/models/agent-model-catalog.model';
import {
  AGENT_DEFAULT_OPTION,
  toModelOption,
  withPinnedModel,
} from '@/shared/models/agent-model-options';
import { AgentModelPreset } from '@/shared/models/app-settings.model';

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

interface ProviderRow {
  id: string;
  label: string;
  icon: string;
  modelOptions: OptionSelectItem[];
  selectedModel: string;
  modelSelectable: boolean;
  modelNote: string | null;
  effortOptions: OptionSelectItem[];
  selectedEffort: string;
  showEffort: boolean;
  /** Set when the chosen model can't reason — explains the disabled picker. */
  effortNote: string | null;
}

@Component({
  selector: 'app-agent-defaults',
  imports: [FormsModule, NgIcon, OptionSelectComponent, ZardButtonComponent, ZardInputDirective],
  templateUrl: './agent-defaults.component.html',
  viewProviders: [
    provideIcons({
      lucideFileText,
      lucideNotebookPen,
      lucideOrbit,
      lucidePencil,
      lucidePlus,
      lucideRefreshCw,
      lucideSparkles,
      lucideTriangleAlert,
      lucideTrash2,
    }),
  ],
})
export class AgentDefaults {
  readonly appSettings = inject(AppSettingsService);
  readonly catalog = inject(AgentModelCatalogService);

  readonly rows = computed<ProviderRow[]>(() =>
    this.catalog.catalogs().map((catalog) => this.toRow(catalog)),
  );
  readonly editingPresetId = signal<string | null>(null);
  readonly presetEditorOpen = signal(false);
  readonly presetName = signal('');
  readonly presetProvider = signal('claude');
  readonly presetModel = signal('');
  readonly presetEffort = signal('');
  readonly providerOptions = computed<OptionSelectItem[]>(() =>
    this.catalog.catalogs().map((catalog) => ({
      value: catalog.provider,
      label: catalog.displayName || catalog.provider,
    })),
  );
  readonly presetCatalog = computed(() =>
    this.catalog.catalogs().find((catalog) => catalog.provider === this.presetProvider()),
  );
  readonly presetCanChooseEffort = computed(() =>
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

  onModelChange(provider: string, value: string): void {
    void this.appSettings
      .saveDefaultModel(provider, value || null)
      .catch(() => toast.error('Could not save the default model.'));
  }

  onEffortChange(provider: string, value: string): void {
    void this.appSettings
      .saveDefaultReasoningEffort(provider, value || null)
      .catch(() => toast.error('Could not save the default thinking level.'));
  }

  openNewPreset(): void {
    const provider = this.catalog.catalogs()[0]?.provider ?? 'claude';
    this.editingPresetId.set(null);
    this.presetName.set('');
    this.presetProvider.set(provider);
    this.presetModel.set('');
    this.presetEffort.set('');
    this.presetEditorOpen.set(true);
  }

  editPreset(preset: AgentModelPreset): void {
    this.editingPresetId.set(preset.id);
    this.presetName.set(preset.name);
    this.presetProvider.set(preset.provider);
    this.presetModel.set(preset.model ?? '');
    this.presetEffort.set(preset.reasoningEffort ?? '');
    this.presetEditorOpen.set(true);
  }

  onPresetProviderChange(provider: string): void {
    this.presetProvider.set(provider);
    this.presetModel.set('');
    this.presetEffort.set('');
  }

  savePreset(): void {
    const name = this.presetName().trim();
    if (!name || this.appSettings.saving()) return;
    const id = this.editingPresetId() ?? crypto.randomUUID();
    const preset: AgentModelPreset = {
      id,
      name,
      provider: this.presetProvider(),
      model: this.presetModel() || null,
      reasoningEffort: this.presetCanChooseEffort() ? this.presetEffort() || null : null,
    };
    const current = this.appSettings.settings().agentModelPresets;
    const next = current.some((item) => item.id === id)
      ? current.map((item) => (item.id === id ? preset : item))
      : [...current, preset];
    void this.appSettings
      .saveAgentModelPresets(next)
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
    return parts.join(' · ');
  }

  presetIcon(provider: string): string {
    return PROVIDER_ICONS[provider] || 'lucideSparkles';
  }

  private toRow(catalog: AgentProviderModelCatalog): ProviderRow {
    const settings = this.appSettings.settings();
    const selectedModel = settings.defaultModelByProvider[catalog.provider] ?? '';
    const selectedEffort = settings.defaultReasoningEffortByProvider[catalog.provider] ?? '';

    const models = withPinnedModel(catalog.models, selectedModel);
    const selected = models.find((model) => model.id === selectedModel);

    // A model's own list wins over the provider-wide one, so picking a model
    // that only reasons at low/medium can't leave "Max" selectable.
    const efforts = selected?.reasoningEfforts?.length
      ? selected.reasoningEfforts
      : catalog.reasoningEfforts;
    const modelRejectsEffort = selected?.supportsEffort === false;

    return {
      id: catalog.provider,
      label: catalog.displayName || catalog.provider,
      icon: PROVIDER_ICONS[catalog.provider] ?? 'lucideSparkles',
      modelOptions: [AGENT_DEFAULT_OPTION, ...models.map((model) => toModelOption(model, catalog))],
      selectedModel,
      modelSelectable: catalog.supportsModelSelection && (models.length > 0 || !!selectedModel),
      modelNote: models.length
        ? null
        : (catalog.unavailableReason ?? `${catalog.displayName} has not reported any models.`),
      effortOptions: [
        AGENT_DEFAULT_OPTION,
        ...this.withPinnedEffort(efforts, selectedEffort).map((effort) => ({
          value: effort,
          label: EFFORT_LABELS[effort] ?? effort,
          description: EFFORT_HINTS[effort],
        })),
      ],
      selectedEffort,
      showEffort: efforts.length > 0 || !!selectedEffort,
      effortNote: modelRejectsEffort
        ? `${selected?.displayName ?? 'This model'} runs at a fixed thinking level.`
        : null,
    };
  }

  private withPinnedEffort(efforts: string[], selected: string): string[] {
    return selected && !efforts.includes(selected) ? [...efforts, selected] : efforts;
  }
}
