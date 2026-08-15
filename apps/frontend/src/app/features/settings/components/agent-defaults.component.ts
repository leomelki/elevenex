import { Component, computed, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideFileText,
  lucideNotebookPen,
  lucideSparkles,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { AppSettingsService } from '@/shared/services/app-settings.service';
import { AgentModelCatalogService } from '@/shared/services/agent-model-catalog.service';
import { DefaultAgentProvider } from '@/shared/models/app-settings.model';

interface ProviderMeta {
  id: DefaultAgentProvider;
  label: string;
  icon: string;
}

interface SelectOption {
  value: string;
  label: string;
  supportsEffort: boolean;
}

interface ProviderRow extends ProviderMeta {
  modelOptions: SelectOption[];
  selectedModel: string;
  hasModels: boolean;
  effortOptions: { value: string; label: string }[];
  selectedEffort: string;
  showEffort: boolean;
  /** Effort is meaningless when the chosen model can't reason. */
  effortDisabled: boolean;
}

const PROVIDERS: ProviderMeta[] = [
  { id: 'claude', label: 'Claude', icon: 'lucideSparkles' },
  { id: 'codex', label: 'Codex', icon: 'lucideFileText' },
  { id: 'pi', label: 'Pi', icon: 'lucideNotebookPen' },
];

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

@Component({
  selector: 'app-agent-defaults',
  imports: [NgIcon],
  templateUrl: './agent-defaults.component.html',
  viewProviders: [
    provideIcons({
      lucideChevronDown,
      lucideFileText,
      lucideNotebookPen,
      lucideSparkles,
    }),
  ],
})
export class AgentDefaults {
  readonly appSettings = inject(AppSettingsService);
  readonly catalog = inject(AgentModelCatalogService);

  readonly rows = computed<ProviderRow[]>(() => {
    const settings = this.appSettings.settings();
    const catalogs = this.catalog.catalogs();

    return PROVIDERS.map((meta) => {
      const catalog = catalogs.find((entry) => entry.provider === meta.id);
      const models = catalog?.models ?? [];
      const efforts = catalog?.reasoningEfforts ?? [];
      const selectedModel = settings.defaultModelByProvider[meta.id] ?? '';
      const selectedEffort =
        settings.defaultReasoningEffortByProvider[meta.id] ?? '';

      const modelOptions: SelectOption[] = models.map((model) => ({
        value: model.id,
        label: model.displayName,
        supportsEffort: model.supportsEffort !== false,
      }));
      // Keep a stored selection visible even if it's no longer advertised by
      // the catalog (renamed/removed model, or a session-scoped id).
      if (
        selectedModel &&
        !modelOptions.some((option) => option.value === selectedModel)
      ) {
        modelOptions.push({
          value: selectedModel,
          label: selectedModel,
          supportsEffort: true,
        });
      }

      const selectedOption = modelOptions.find(
        (option) => option.value === selectedModel,
      );
      const modelSupportsEffort = selectedModel
        ? (selectedOption?.supportsEffort ?? true)
        : true;

      const effortOptions = efforts.map((effort) => ({
        value: effort,
        label: EFFORT_LABELS[effort] ?? effort,
      }));
      if (
        selectedEffort &&
        !effortOptions.some((option) => option.value === selectedEffort)
      ) {
        effortOptions.push({ value: selectedEffort, label: selectedEffort });
      }

      return {
        ...meta,
        modelOptions,
        selectedModel,
        hasModels: models.length > 0,
        effortOptions,
        selectedEffort,
        showEffort: efforts.length > 0,
        effortDisabled: !modelSupportsEffort,
      };
    });
  });

  constructor() {
    void this.catalog.load().catch(() => undefined);
  }

  onModelChange(provider: DefaultAgentProvider, value: string): void {
    if (this.appSettings.saving()) {
      return;
    }
    void this.appSettings
      .saveDefaultModel(provider, value || null)
      .catch(() => toast.error('Could not save default model.'));
  }

  onEffortChange(provider: DefaultAgentProvider, value: string): void {
    if (this.appSettings.saving()) {
      return;
    }
    void this.appSettings
      .saveDefaultReasoningEffort(provider, value || null)
      .catch(() => toast.error('Could not save thinking level.'));
  }
}
