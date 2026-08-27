import { Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFileText,
  lucideNotebookPen,
  lucideOrbit,
  lucideRefreshCw,
  lucideSparkles,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { AGENT_PROVIDER_ICONS } from '@/shared/models/agent-provider-presentation';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { AgentModelCatalogService } from '@/shared/services/agent-model-catalog.service';
import { ZardButtonComponent } from '@/shared/components/button';
import {
  OptionSelectComponent,
  OptionSelectItem,
} from '@/shared/components/option-select';
import { AgentProviderModelCatalog } from '@/shared/models/agent-model-catalog.model';
import { ClaudeModelOption } from '@/shared/models/claude-runtime.model';

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

const USE_AGENT_DEFAULT: OptionSelectItem = {
  value: '',
  label: 'Agent default',
  description: "Whatever the agent picks on its own",
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
  imports: [NgIcon, OptionSelectComponent, ZardButtonComponent],
  templateUrl: './agent-defaults.component.html',
  viewProviders: [
    provideIcons({
      lucideFileText,
      lucideNotebookPen,
      lucideOrbit,
      lucideRefreshCw,
      lucideSparkles,
      lucideTriangleAlert,
    }),
  ],
})
export class AgentDefaults {
  readonly appSettings = inject(AppSettingsService);
  readonly catalog = inject(AgentModelCatalogService);

  readonly rows = computed<ProviderRow[]>(() =>
    this.catalog.catalogs().map((catalog) => this.toRow(catalog)),
  );

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

  private toRow(catalog: AgentProviderModelCatalog): ProviderRow {
    const settings = this.appSettings.settings();
    const selectedModel = settings.defaultModelByProvider[catalog.provider] ?? '';
    const selectedEffort =
      settings.defaultReasoningEffortByProvider[catalog.provider] ?? '';

    const models = this.withPinnedModel(catalog.models, selectedModel);
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
      modelOptions: [
        USE_AGENT_DEFAULT,
        ...models.map((model) => this.toModelOption(model, catalog)),
      ],
      selectedModel,
      modelSelectable:
        catalog.supportsModelSelection && (models.length > 0 || !!selectedModel),
      modelNote: models.length
        ? null
        : (catalog.unavailableReason ??
          `${catalog.displayName} has not reported any models.`),
      effortOptions: [
        USE_AGENT_DEFAULT,
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

  private toModelOption(
    model: ClaudeModelOption,
    catalog: AgentProviderModelCatalog,
  ): OptionSelectItem {
    const isProviderDefault =
      model.isProviderDefault === true ||
      (!!catalog.providerDefaultModelId &&
        model.id === catalog.providerDefaultModelId);

    return {
      value: model.id,
      label: model.displayName || model.id,
      description: model.description || undefined,
      badge: isProviderDefault ? 'Default' : undefined,
    };
  }

  /**
   * Keeps a saved selection visible even when the catalog no longer advertises
   * it — a renamed model, a provider that's temporarily unreachable, or an id
   * typed in before this build knew about it. Dropping it from the list would
   * misrepresent the setting as unset while it is still in force.
   */
  private withPinnedModel(
    models: ClaudeModelOption[],
    selectedModel: string,
  ): ClaudeModelOption[] {
    if (!selectedModel || models.some((model) => model.id === selectedModel)) {
      return models;
    }

    return [
      ...models,
      {
        id: selectedModel,
        displayName: selectedModel,
        description: 'Saved earlier; this agent is not offering it right now.',
      },
    ];
  }

  private withPinnedEffort(efforts: string[], selected: string): string[] {
    return selected && !efforts.includes(selected)
      ? [...efforts, selected]
      : efforts;
  }
}
