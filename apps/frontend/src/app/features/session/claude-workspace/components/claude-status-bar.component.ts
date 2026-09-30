import { ZardProgressBarComponent } from '@/shared/components/progress-bar';
import {
  AgentPlanUsage,
  AgentPlanUsageWindow,
  AgentProviderId,
  AgentRuntimeProviderInfo,
} from '@/shared/models/agent-runtime.model';
import {
  ClaudeContextUsage,
  ClaudeMcpSnapshot,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudeReasoningEffort,
  ClaudeStatusBarPhase,
  ClaudeTaskState,
} from '@/shared/models/claude-runtime.model';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBrain,
  lucideCheck,
  lucideChevronDown,
  lucideDownload,
  lucideEllipsis,
  lucideGauge,
  lucideListTodo,
  lucideLoaderCircle,
  lucideMap,
  lucidePlugZap,
  lucideShield,
  lucideTerminal,
  lucideTriangleAlert,
  lucideZap,
} from '@ng-icons/lucide';

interface PermissionModeOption {
  id: ClaudePermissionMode;
  label: string;
  hint: string;
}

const PERMISSION_MODES: PermissionModeOption[] = [
  { id: 'auto', label: 'Auto mode', hint: 'Continuous, autonomous execution' },
  { id: 'default', label: 'Default', hint: 'Prompt for risky tools' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Auto-allow file edits' },
  { id: 'bypassPermissions', label: 'Bypass permissions', hint: 'Skip all prompts — danger' },
];

const CODEX_PERMISSION_MODE_HINTS: Partial<Record<ClaudePermissionMode, string>> = {
  auto: 'Run sandboxed; auto-review elevated requests',
  default: 'Run commands in the workspace sandbox',
};

const REASONING_EFFORTS: { id: ClaudeReasoningEffort | ''; label: string; hint: string }[] = [
  { id: '', label: 'Default effort', hint: 'Use the provider default' },
  { id: 'low', label: 'Low', hint: 'Fastest responses' },
  { id: 'medium', label: 'Medium', hint: 'Balanced reasoning' },
  { id: 'high', label: 'High', hint: 'Deep reasoning' },
  { id: 'xhigh', label: 'Extra high', hint: 'More depth where supported' },
  { id: 'max', label: 'Max', hint: 'Maximum effort where supported' },
];

@Component({
  selector: 'cw-status-bar',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardProgressBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:mousedown)': 'onDocumentMousedown($event)',
    '(document:keydown.escape)': 'closeAllMenus()',
    '(document:keydown.shift.tab)': 'togglePlanModeFromShortcut($event)',
  },
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
      lucideDownload,
      lucideEllipsis,
      lucideGauge,
      lucideListTodo,
      lucideLoaderCircle,
      lucideMap,
      lucidePlugZap,
      lucideBrain,
      lucideZap,
      lucideShield,
      lucideTerminal,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './claude-status-bar.component.html',
  styleUrl: './claude-status-bar.component.scss',
})
export class ClaudeStatusBarComponent {
  readonly phase = input<ClaudeStatusBarPhase>('ready');
  readonly providers = input<AgentRuntimeProviderInfo[]>([]);
  readonly currentProvider = input<AgentProviderId>('claude');
  readonly providerLocked = input(false);
  readonly selectedModel = input<string | null>(null);
  readonly reasoningEffort = input<ClaudeReasoningEffort | null>(null);
  readonly fastMode = input(false);
  readonly availableModels = input<ClaudeModelOption[]>([]);
  readonly contextUsage = input<ClaudeContextUsage | null>(null);
  readonly planUsage = input<AgentPlanUsage | null>(null);
  readonly tasks = input<ClaudeTaskState[]>([]);
  /** Count of background jobs still running; shown as a persistent chip. */
  readonly backgroundWorkCount = input<number>(0);
  /** True when the current run was resumed by background work, not a prompt. */
  readonly backgroundRunActive = input<boolean>(false);
  readonly permissionMode = input<ClaudePermissionMode>('default');
  readonly planMode = input(false);
  readonly mcpSnapshot = input<ClaudeMcpSnapshot | null>(null);

  readonly modelChange = output<string>();
  readonly reasoningEffortChange = output<ClaudeReasoningEffort | null>();
  readonly fastModeChange = output<boolean>();
  readonly providerChange = output<AgentProviderId>();
  readonly permissionModeChange = output<ClaudePermissionMode>();
  readonly planModeChange = output<boolean>();
  readonly openTerminal = output<void>();
  readonly openTasks = output<void>();
  readonly openMcp = output<void>();
  readonly export = output<void>();

  private readonly openMenu = signal<
    'model' | 'effort' | 'provider' | 'permission' | 'usage' | 'overflow' | null
  >(null);
  readonly modelOpen = computed(() => this.openMenu() === 'model');
  readonly effortOpen = computed(() => this.openMenu() === 'effort');
  readonly providerOpen = computed(() => this.openMenu() === 'provider');
  readonly permissionOpen = computed(() => this.openMenu() === 'permission');
  readonly usageOpen = computed(() => this.openMenu() === 'usage');
  readonly menuOpen = computed(() => this.openMenu() === 'overflow');

  readonly visiblePlanUsage = computed(() => {
    const usage = this.planUsage();
    const provider = this.currentProvider();
    return usage &&
      (provider === 'claude' || provider === 'codex') &&
      usage.provider === provider &&
      usage.windows.length
      ? usage
      : null;
  });

  private readonly host = inject(ElementRef<HTMLElement>);

  onDocumentMousedown(event: MouseEvent): void {
    if (!this.openMenu()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.closeAllMenus();
  }

  closeAllMenus(): void {
    this.openMenu.set(null);
  }

  toggleMenu(which: 'model' | 'effort' | 'provider' | 'permission' | 'usage' | 'overflow'): void {
    if (which === 'provider' && this.providerLocked()) return;
    this.openMenu.update((current) => (current === which ? null : which));
  }

  readonly lowestRemainingPercentage = computed(() => {
    const windows = this.visiblePlanUsage()?.windows ?? [];
    return windows.length ? Math.min(...windows.map((window) => window.remainingPercentage)) : 0;
  });

  readonly usageTriggerTitle = computed(() => {
    const usage = this.visiblePlanUsage();
    if (!usage) return '';
    const provider = usage.provider === 'codex' ? 'Codex' : 'Claude';
    return `${provider} plan: ${this.lowestRemainingPercentage()}% remaining`;
  });

  usageProgressType(window: AgentPlanUsageWindow): 'success' | 'warning' | 'destructive' {
    if (window.remainingPercentage <= 5) return 'destructive';
    if (window.remainingPercentage <= 20) return 'warning';
    return 'success';
  }

  formatResetTime(timestampSeconds: number): string {
    const remainingMs = timestampSeconds * 1000 - Date.now();
    if (remainingMs <= 0) return 'Resetting soon';
    const totalMinutes = Math.ceil(remainingMs / 60_000);
    if (totalMinutes < 60) return `Resets in ${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return `Resets in ${hours}h${minutes ? ` ${minutes}m` : ''}`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `Resets in ${days}d${remainingHours ? ` ${remainingHours}h` : ''}`;
  }

  formatResetTitle(timestampSeconds: number): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestampSeconds * 1000));
  }

  readonly permissionOptions = computed(() => {
    if (this.currentProvider() === 'codex') {
      return PERMISSION_MODES.filter((opt) =>
        ['auto', 'default', 'acceptEdits', 'bypassPermissions'].includes(opt.id),
      ).map((opt) => ({
        ...opt,
        hint: CODEX_PERMISSION_MODE_HINTS[opt.id] ?? opt.hint,
      }));
    }
    const modelId = this.selectedModel();
    const models = this.availableModels();
    const effectiveModel = modelId ? models.find((m) => m.id === modelId) : models[0];
    const supportsAuto = effectiveModel?.supportsAutoMode ?? false;
    const current = this.permissionMode();
    return PERMISSION_MODES.filter(
      (opt) => opt.id !== 'auto' || supportsAuto || current === 'auto',
    );
  });
  readonly activePermissionLabel = computed(() => {
    const mode = this.permissionMode();
    return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode;
  });

  readonly phaseLabel = computed(() => {
    const p = this.phase();
    // A run resumed by background work is an ordinary run in every way; the
    // label just says where it came from so it doesn't look unexplained.
    if (p === 'running') return this.backgroundRunActive() ? 'resumed' : 'running';
    if (p === 'initializing') return 'initializing';
    if (p === 'waiting') return 'awaiting input';
    if (p === 'error') return 'error';
    if (p === 'idle') return 'idle';
    return 'ready';
  });

  readonly taskCount = computed(
    () => this.tasks().filter((t) => t.status === 'running' || t.status === 'pending').length,
  );
  readonly mcpSummary = computed(() => this.mcpSnapshot()?.summary ?? null);
  readonly mcpIssueCount = computed(() => {
    const s = this.mcpSummary();
    return s ? s.failed + s.needsAuth + s.malformed : 0;
  });

  readonly selectedModelLabel = computed(() => {
    const id = this.selectedModel();
    if (!id) return 'default model';
    const m = this.availableModels().find((x) => x.id === id);
    return m?.displayName ?? id;
  });
  readonly selectedModelOption = computed(() => {
    const id = this.selectedModel();
    const models = this.availableModels();
    return id ? models.find((m) => m.id === id) : models[0];
  });
  readonly selectedModelSupportsEffort = computed(
    () => this.selectedModelOption()?.supportsEffort ?? false,
  );
  readonly selectedModelSupportsFastMode = computed(
    () => this.selectedModelOption()?.supportsFastMode ?? false,
  );
  readonly reasoningEffortOptions = computed(() => {
    const effort = this.reasoningEffort();
    // Some providers report the levels a model actually accepts; honor that
    // rather than offering levels the model would reject. "Default effort"
    // (the empty id) always stays available.
    const supported = this.selectedModelOption()?.reasoningEfforts;
    const base = supported?.length
      ? REASONING_EFFORTS.filter(
          (option) => option.id === '' || supported.includes(option.id as string),
        )
      : REASONING_EFFORTS;
    return effort && !base.some((option) => option.id === effort)
      ? [{ id: effort, label: effort, hint: 'Custom effort' }, ...base]
      : base;
  });
  readonly reasoningEffortLabel = computed(() => {
    const effort = this.reasoningEffort();
    if (!effort) return 'default effort';
    return REASONING_EFFORTS.find((option) => option.id === effort)?.label ?? effort;
  });

  readonly activeProviderLabel = computed(() => {
    return (
      this.providers().find((provider) => provider.id === this.currentProvider())?.displayName ??
      this.currentProvider()
    );
  });
  readonly currentProviderCapabilities = computed(
    () =>
      this.providers().find((provider) => provider.id === this.currentProvider())?.capabilities ??
      null,
  );

  pickModel(id: string): void {
    this.closeAllMenus();
    this.modelChange.emit(id);
  }

  pickReasoningEffort(effort: ClaudeReasoningEffort | ''): void {
    this.closeAllMenus();
    this.reasoningEffortChange.emit(effort || null);
  }

  toggleFastMode(): void {
    this.fastModeChange.emit(!this.fastMode());
  }

  pickProvider(id: AgentProviderId): void {
    this.closeAllMenus();
    if (this.providerLocked()) return;
    if (id !== this.currentProvider()) {
      this.providerChange.emit(id);
    }
  }

  providerCapabilityHint(provider: AgentRuntimeProviderInfo): string {
    const parts = [
      provider.capabilities.permissions ? 'interactive permissions' : 'sandbox policy',
      provider.capabilities.mcp ? 'MCP' : '',
      provider.capabilities.multimodalPrompts ? 'images' : '',
    ].filter(Boolean);
    return parts.join(' · ');
  }

  pickPermissionMode(mode: ClaudePermissionMode): void {
    this.closeAllMenus();
    this.permissionModeChange.emit(mode);
  }

  togglePlanMode(): void {
    if (!this.currentProviderCapabilities()?.permissions) return;
    this.planModeChange.emit(!this.planMode());
  }

  togglePlanModeFromShortcut(event: Event): void {
    if (!this.currentProviderCapabilities()?.permissions) return;
    event.preventDefault();
    this.togglePlanMode();
  }
}
