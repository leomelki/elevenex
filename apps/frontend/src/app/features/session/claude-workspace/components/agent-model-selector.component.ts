import { CdkTrapFocus } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronDown,
  lucideLoaderCircle,
  lucideLockKeyhole,
  lucideSearch,
  lucideX,
  lucideZap,
} from '@ng-icons/lucide';
import { AgentLogoComponent } from '@/shared/components/agent-logo/agent-logo.component';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ZardPopoverComponent, ZardPopoverDirective } from '@/shared/components/popover';
import {
  AgentAuthStatus,
  AgentPlanUsage,
  AgentProviderId,
  AgentRuntimeProviderInfo,
} from '@/shared/models/agent-runtime.model';
import { ClaudeModelOption } from '@/shared/models/claude-runtime.model';
import { AgentModelCatalogService } from '@/shared/services/agent-model-catalog.service';

interface ModelChoice {
  provider: AgentProviderId;
  id: string;
  label: string;
  description?: string;
  defaultModel?: string;
}

@Component({
  selector: 'cw-agent-model-selector',
  imports: [
    CdkTrapFocus,
    NgIcon,
    AgentLogoComponent,
    ZardButtonComponent,
    ZardInputDirective,
    ZardPopoverComponent,
    ZardPopoverDirective,
  ],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
      lucideLoaderCircle,
      lucideLockKeyhole,
      lucideSearch,
      lucideX,
      lucideZap,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './agent-model-selector.component.html',
  styleUrl: './agent-model-selector.component.scss',
})
export class AgentModelSelectorComponent {
  readonly catalog = inject(AgentModelCatalogService);
  readonly providers = input<AgentRuntimeProviderInfo[]>([]);
  readonly provider = input<AgentProviderId>('claude');
  readonly locked = input(false);
  readonly authStatus = input<AgentAuthStatus | null>(null);
  readonly models = input<ClaudeModelOption[]>([]);
  readonly selectedModel = input<string | null>(null);
  readonly effectiveModelId = input<string | null>(null);
  readonly modelLabel = input('Agent default');
  readonly effort = input<string | null>(null);
  readonly effortLabel = input('Default');
  readonly effortOptions = input<{ id: string; label: string; hint: string }[]>([]);
  readonly supportsEffort = input(false);
  readonly supportsFastMode = input(false);
  readonly fastMode = input(false);
  readonly planUsage = input<AgentPlanUsage | null>(null);
  readonly providerChange = output<AgentProviderId>();
  readonly modelChange = output<string>();
  readonly providerModelChange = output<{ provider: AgentProviderId; model: string }>();
  readonly effortChange = output<string>();
  readonly fastModeChange = output<boolean>();
  readonly connectProvider = output<void>();

  readonly popover = viewChild<ZardPopoverDirective>('modelPopover');
  readonly panel = viewChild<unknown, ElementRef<HTMLElement>>('modelPanel', { read: ElementRef });
  readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  readonly searchOpen = signal(false);
  readonly query = signal('');
  readonly providerLabel = computed(
    () => this.providers().find((p) => p.id === this.provider())?.displayName ?? this.provider(),
  );
  readonly needsLogin = computed(() => this.authStatus()?.authenticated === false);
  readonly unavailableReason = computed(
    () => this.catalog.catalogs().find((c) => c.provider === this.provider())?.unavailableReason,
  );
  readonly remaining = computed(() => {
    const usage = this.planUsage();
    return usage?.provider === this.provider() && usage.windows.length
      ? Math.max(0, Math.min(100, Math.min(...usage.windows.map((w) => w.remainingPercentage))))
      : null;
  });
  readonly usageTitle = computed(
    () =>
      this.planUsage()
        ?.windows.map((w) => {
          const minutes = w.resetsAt
            ? Math.max(0, Math.ceil((w.resetsAt * 1000 - Date.now()) / 60_000))
            : null;
          const reset =
            minutes === null
              ? ''
              : minutes < 60
                ? ` · resets in ${minutes}m`
                : ` · resets in ${Math.ceil(minutes / 60)}h`;
          return `${w.label}: ${w.remainingPercentage}% left${reset}`;
        })
        .join('\n') ?? '',
  );
  readonly effortIndex = linkedSignal(() => {
    this.provider();
    this.effectiveModelId();
    return Math.max(
      0,
      this.effortOptions().findIndex((o) => o.id === (this.effort() ?? '')),
    );
  });
  readonly previewEffortLabel = computed(() => {
    const option = this.effortOptions()[this.effortIndex()];
    return option?.id ? option.label : 'Default';
  });
  readonly effortPercent = computed(() =>
    this.effortOptions().length > 1
      ? (this.effortIndex() / (this.effortOptions().length - 1)) * 100
      : 0,
  );
  readonly choices = computed<ModelChoice[]>(() => {
    const provider = this.provider();
    const defaultId = this.catalog
      .catalogs()
      .find((c) => c.provider === provider)?.providerDefaultModelId;
    const resolvedDefault = this.models().find(
      (m) => m.isProviderDefault || m.id === defaultId,
    )?.displayName;
    const current: ModelChoice[] = [
      { provider, id: '', label: 'Agent default', defaultModel: resolvedDefault },
      ...this.models().map((m) => ({
        provider,
        id: m.id,
        label: m.displayName,
        description: m.description,
      })),
    ];
    const query = this.query().trim().toLocaleLowerCase();
    if (!query) return current;
    const others = this.locked()
      ? []
      : this.catalog
          .catalogs()
          .filter(
            (c) => c.provider !== provider && this.providers().some((p) => p.id === c.provider),
          )
          .flatMap((c) =>
            c.models.map((m) => ({
              provider: c.provider,
              id: m.id,
              label: m.displayName,
              description: m.description,
            })),
          );
    return [...current, ...others].filter((m) =>
      `${m.label} ${m.id} ${m.description ?? ''} ${m.provider}`.toLocaleLowerCase().includes(query),
    );
  });

  opened(visible: boolean): void {
    if (!visible) return;
    this.searchOpen.set(false);
    this.query.set('');
    void this.catalog.load(this.provider()).catch(() => undefined);
  }

  openFromKeyboard(event: KeyboardEvent): void {
    if (!['ArrowDown', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    this.popover()?.show();
  }

  startSearch(value = ''): void {
    this.searchOpen.set(true);
    this.query.set(value);
    // Shared catalog requests are cached and coalesced. Locked conversations never
    // discover other providers because their models cannot be selected here.
    if (!this.locked()) void this.catalog.load().catch(() => undefined);
    setTimeout(() => this.searchInput()?.nativeElement.focus());
  }

  clearSearch(): void {
    this.query.set('');
    this.searchOpen.set(false);
    setTimeout(() =>
      this.panel()
        ?.nativeElement.querySelector<HTMLElement>('[data-model-choice], [data-search-trigger]')
        ?.focus(),
    );
  }

  pick(choice: ModelChoice): void {
    if (choice.provider === this.provider()) this.modelChange.emit(choice.id);
    else if (!this.locked())
      this.providerModelChange.emit({ provider: choice.provider, model: choice.id });
    this.popover()?.hide();
  }

  selectProvider(provider: AgentProviderId): void {
    if (this.locked() || provider === this.provider()) return;
    this.query.set('');
    this.searchOpen.set(false);
    void this.catalog.load(provider).catch(() => undefined);
    this.providerChange.emit(provider);
  }

  selectEffort(event: Event): void {
    const option = this.effortOptions()[Number((event.target as HTMLInputElement).value)];
    if (option && option.id !== (this.effort() ?? '')) this.effortChange.emit(option.id);
  }

  keydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (event.key === 'Escape' && this.searchOpen()) {
      event.preventDefault();
      event.stopPropagation();
      this.clearSearch();
      return;
    }
    if (event.key === 'Tab') {
      // Keep Shift+Tab local; the status bar also uses it as a plan shortcut.
      event.stopPropagation();
      return;
    }
    if (target.matches('input[type="range"]')) return;
    if (event.key === 'Enter' || event.key === ' ') {
      if (target.matches('[data-model-choice], [data-agent-choice]')) {
        event.preventDefault();
        target.click();
        return;
      }
      if (event.key === 'Enter' && target.matches('input')) {
        event.preventDefault();
        const first = this.choices()[0];
        if (first) this.pick(first);
        return;
      }
    }
    if (
      ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) &&
      !target.matches('[data-agent-choice]')
    ) {
      if (target.matches('input') && ['Home', 'End'].includes(event.key)) return;
      const buttons = [
        ...(target
          .closest('[role="dialog"]')
          ?.querySelectorAll<HTMLElement>('[data-model-choice]') ?? []),
      ];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(target.ownerDocument.activeElement as HTMLElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : event.key === 'ArrowDown'
              ? (current + 1) % buttons.length
              : (current - 1 + buttons.length) % buttons.length;
      buttons[index].focus();
      buttons[index].scrollIntoView?.({ block: 'nearest' });
    } else if (
      target.matches('[data-agent-choice]') &&
      ['ArrowDown', 'ArrowUp'].includes(event.key)
    ) {
      event.preventDefault();
      const buttons = [
        ...target.parentElement!.querySelectorAll<HTMLElement>('[data-agent-choice]'),
      ];
      buttons[
        (buttons.indexOf(target) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
          buttons.length
      ].focus();
    } else if (
      !target.matches('input') &&
      event.key.length === 1 &&
      event.key !== ' ' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      this.startSearch(this.query() + event.key);
    }
  }
}
