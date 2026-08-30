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
import {
  AGENT_DEFAULT_OPTION,
  toModelOption,
  withPinnedModel,
} from '@/shared/models/agent-model-options';

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
      modelOptions: [
        AGENT_DEFAULT_OPTION,
        ...models.map((model) => toModelOption(model, catalog)),
      ],
      selectedModel,
      modelSelectable:
        catalog.supportsModelSelection && (models.length > 0 || !!selectedModel),
      modelNote: models.length
        ? null
        : (catalog.unavailableReason ??
          `${catalog.displayName} has not reported any models.`),
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
    return selected && !efforts.includes(selected)
      ? [...efforts, selected]
      : efforts;
  }
}
