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
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronDown,
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
} from '@ng-icons/lucide';
import {
  ClaudeContextUsage,
  ClaudeMcpSnapshot,
  ClaudeModelOption,
  ClaudePermissionMode,
  ClaudeReasoningEffort,
  ClaudeRunPhase,
  ClaudeTaskState,
} from '@/shared/models/claude-runtime.model';
import {
  AgentProviderId,
  AgentRuntimeProviderInfo,
} from '@/shared/models/agent-runtime.model';

interface PermissionModeOption {
  id: ClaudePermissionMode;
  label: string;
  hint: string;
}

const PERMISSION_MODES: PermissionModeOption[] = [
  { id: 'auto', label: 'Auto mode', hint: 'Continuous, autonomous execution' },
  { id: 'default', label: 'Default', hint: 'Prompt for risky tools' },
  { id: 'plan', label: 'Plan mode', hint: 'Read-only — draft a plan before editing' },
  { id: 'planBypass', label: 'Plan + bypass', hint: 'Auto-approve during planning, then review plan' },
  { id: 'acceptEdits', label: 'Accept edits', hint: 'Auto-allow file edits' },
  { id: 'bypassPermissions', label: 'Bypass permissions', hint: 'Skip all prompts — danger' },
];

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
  imports: [CommonModule, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:mousedown)': 'onDocumentMousedown($event)',
    '(document:keydown.escape)': 'closeAllMenus()',
    '(document:keydown.shift.tab)': 'cyclePermissionMode($event)',
  },
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
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
  template: `
    <div class="cw-sb">
      <span class="cw-sb__phase" [attr.data-phase]="phase()">
        @if (phase() === 'running') {
          <ng-icon name="lucideLoaderCircle" size="11" class="animate-spin" />
        } @else if (phase() === 'waiting') {
          <ng-icon name="lucideTriangleAlert" size="11" />
        } @else if (phase() === 'error') {
          <ng-icon name="lucideTriangleAlert" size="11" />
        } @else {
          <span class="cw-sb__dot"></span>
        }
        <span>{{ phaseLabel() }}</span>
      </span>

      <span class="cw-sb__sep">·</span>

      <div class="cw-sb__model">
        <button
          type="button"
          class="cw-sb__link"
          [class.cw-sb__link--disabled]="providerLocked()"
          [disabled]="providerLocked()"
          [title]="providerLocked() ? 'Provider is locked after a session starts' : 'Change provider'"
          (click)="toggleMenu('provider')"
        >
          {{ activeProviderLabel() }}
          @if (!providerLocked()) {
            <ng-icon name="lucideChevronDown" size="11" />
          }
        </button>
        @if (providerOpen() && !providerLocked()) {
          <div class="cw-sb__menu" (mousedown)="$event.stopPropagation()">
            @for (provider of providers(); track provider.id) {
              <button
                type="button"
                class="cw-sb__menu-item"
                [class.cw-sb__menu-item--selected]="currentProvider() === provider.id"
                (click)="pickProvider(provider.id)"
              >
                <strong>{{ provider.displayName }}</strong>
                <span>{{ providerCapabilityHint(provider) }}</span>
              </button>
            }
          </div>
        }
      </div>

      @if (currentProviderCapabilities()?.permissions) {
        <span class="cw-sb__sep">·</span>

        <div class="cw-sb__model">
          <button
            type="button"
            class="cw-sb__link cw-sb__mode"
            [class.cw-sb__mode--plan]="isPlanMode()"
            [class.cw-sb__mode--plan-bypass]="isPlanBypassMode()"
            (click)="toggleMenu('permission')"
            [title]="'Permission mode'"
          >
            @if (isPlanMode()) {
              <ng-icon name="lucideMap" size="11" />
            } @else {
              <ng-icon name="lucideShield" size="11" />
            }
            {{ activePermissionLabel() }}
            <ng-icon name="lucideChevronDown" size="11" />
          </button>
          @if (permissionOpen()) {
            <div class="cw-sb__menu" (mousedown)="$event.stopPropagation()">
              @for (opt of permissionOptions(); track opt.id) {
                <button
                  type="button"
                  class="cw-sb__menu-item"
                  [class.cw-sb__menu-item--selected]="permissionMode() === opt.id"
                  (click)="pickPermissionMode(opt.id)"
                >
                  <strong>{{ opt.label }}</strong>
                  <span>{{ opt.hint }}</span>
                </button>
              }
            </div>
          }
        </div>
      }

      <span class="cw-sb__sep">·</span>

      <div class="cw-sb__model">
        <button type="button" class="cw-sb__link" (click)="toggleMenu('model')">
          {{ selectedModelLabel() }}
          <ng-icon name="lucideChevronDown" size="11" />
        </button>
        @if (modelOpen()) {
          <div class="cw-sb__menu" (mousedown)="$event.stopPropagation()">
            <button
              type="button"
              class="cw-sb__menu-item"
              [class.cw-sb__menu-item--selected]="!selectedModel()"
              (click)="pickModel('')"
            >
              Default
            </button>
            @for (m of availableModels(); track m.id) {
              <button
                type="button"
                class="cw-sb__menu-item"
                [class.cw-sb__menu-item--selected]="selectedModel() === m.id"
                (click)="pickModel(m.id)"
              >
                <strong>{{ m.displayName }}</strong>
                <span>{{ m.description }}</span>
              </button>
            }
          </div>
        }
      </div>

      @if (selectedModelSupportsEffort()) {
        <span class="cw-sb__sep">·</span>
        <div class="cw-sb__model">
          <button
            type="button"
            class="cw-sb__link"
            (click)="toggleMenu('effort')"
            title="Reasoning effort"
          >
            <ng-icon name="lucideBrain" size="11" />
            {{ reasoningEffortLabel() }}
            <ng-icon name="lucideChevronDown" size="11" />
          </button>
          @if (effortOpen()) {
            <div class="cw-sb__menu" (mousedown)="$event.stopPropagation()">
              @for (effort of reasoningEffortOptions(); track effort.id) {
                <button
                  type="button"
                  class="cw-sb__menu-item"
                  [class.cw-sb__menu-item--selected]="(reasoningEffort() ?? '') === effort.id"
                  (click)="pickReasoningEffort(effort.id)"
                >
                  <strong>{{ effort.label }}</strong>
                  <span>{{ effort.hint }}</span>
                </button>
              }
            </div>
          }
        </div>
      }

      @if (selectedModelSupportsFastMode()) {
        <span class="cw-sb__sep">·</span>
        <button
          type="button"
          class="cw-sb__link"
          [class.cw-sb__link--active]="fastMode()"
          (click)="toggleFastMode()"
          title="Fast mode"
        >
          <ng-icon name="lucideZap" size="11" />
          Fast {{ fastMode() ? 'on' : 'off' }}
        </button>
      }

      @if (contextUsage(); as u) {
        <span class="cw-sb__sep">·</span>
        <span class="cw-sb__ctx" [class.cw-sb__ctx--warn]="u.percentage >= 80">
          <ng-icon name="lucideGauge" size="11" />
          {{ u.percentage }}% ctx
        </span>
      }

      @if (taskCount() > 0) {
        <span class="cw-sb__sep">·</span>
        <button type="button" class="cw-sb__link" (click)="openTasks.emit()">
          <ng-icon name="lucideListTodo" size="11" />
          {{ taskCount() }} task{{ taskCount() === 1 ? '' : 's' }}
        </button>
      }

      @if (currentProviderCapabilities()?.mcp) {
        <span class="cw-sb__sep">·</span>
        <button
          type="button"
          class="cw-sb__link"
          [class.cw-sb__link--mcp-warn]="mcpIssueCount() > 0"
          (click)="openMcp.emit()"
        >
          <ng-icon name="lucidePlugZap" size="11" />
          MCP{{ mcpSummary() ? ' ' + mcpSummary()!.total : '' }}
          @if (mcpIssueCount() > 0) {
            <span class="cw-sb__pill">{{ mcpIssueCount() }}</span>
          }
        </button>
      }

      <div class="cw-sb__spacer"></div>

      <div class="cw-sb__overflow">
        <button type="button" class="cw-sb__icon-btn" (click)="toggleMenu('overflow')" title="More">
          <ng-icon name="lucideEllipsis" size="14" />
        </button>
        @if (menuOpen()) {
          <div class="cw-sb__menu cw-sb__menu--right" (mousedown)="$event.stopPropagation()">
            @if (currentProviderCapabilities()?.terminalFallback) {
              <button type="button" class="cw-sb__menu-item" (click)="menuOpen.set(false); openTerminal.emit()">
                <ng-icon name="lucideTerminal" size="12" />
                Raw terminal
              </button>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-sb {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.5rem;
        font-size: 0.6875rem;
        color: var(--muted-foreground);
        flex-wrap: wrap;
      }
      .cw-sb__spacer {
        flex: 1;
      }
      .cw-sb__sep {
        opacity: 0.4;
      }
      .cw-sb__phase {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        text-transform: lowercase;
      }
      .cw-sb__phase[data-phase='running'] {
        color: var(--primary);
      }
      .cw-sb__phase[data-phase='error'],
      .cw-sb__phase[data-phase='waiting'] {
        color: var(--destructive);
      }
      .cw-sb__dot {
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.5;
      }
      .cw-sb__ctx {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      .cw-sb__ctx--warn {
        color: var(--destructive);
      }
      .cw-sb__link,
      .cw-sb__icon-btn {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 0.6875rem;
        padding: 0.125rem 0.25rem;
        border-radius: 0.25rem;
        cursor: pointer;
      }
      .cw-sb__link:hover,
      .cw-sb__icon-btn:hover {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--foreground);
      }
      .cw-sb__link--active {
        background: color-mix(in oklab, var(--success) 14%, transparent);
        color: color-mix(in oklab, var(--success) 85%, var(--foreground));
      }
      .cw-sb__link--disabled,
      .cw-sb__link--disabled:hover {
        cursor: default;
        background: transparent;
        color: var(--muted-foreground);
      }
      .cw-sb__model,
      .cw-sb__overflow {
        position: relative;
      }
      .cw-sb__menu {
        position: absolute;
        bottom: calc(100% + 0.375rem);
        left: 0;
        min-width: 14rem;
        background: var(--popover);
        color: var(--popover-foreground);
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        box-shadow: 0 10px 30px -10px color-mix(in oklab, #000 20%, transparent);
        padding: 0.25rem;
        z-index: 30;
      }
      .cw-sb__menu--right {
        left: auto;
        right: 0;
      }
      .cw-sb__menu-item {
        display: flex;
        flex-direction: column;
        gap: 0.0625rem;
        width: 100%;
        padding: 0.375rem 0.5rem;
        border: 0;
        background: transparent;
        text-align: left;
        border-radius: 0.375rem;
        cursor: pointer;
        color: inherit;
        font: inherit;
        font-size: 0.75rem;
      }
      .cw-sb__menu-item strong {
        font-weight: 600;
      }
      .cw-sb__menu-item span {
        color: var(--muted-foreground);
        font-size: 0.6875rem;
      }
      .cw-sb__menu-item:hover {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
      }
      .cw-sb__menu-item--selected {
        background: color-mix(in oklab, var(--primary) 14%, transparent);
      }
      .cw-sb__mode--plan {
        color: color-mix(in oklab, var(--primary) 90%, var(--foreground));
        font-weight: 600;
      }
      .cw-sb__mode--plan-bypass {
        color: color-mix(in oklab, oklch(0.62 0.19 145) 90%, var(--foreground));
        font-weight: 600;
      }
      .cw-sb__link--mcp-warn {
        color: oklch(0.62 0.16 65);
      }
      .cw-sb__link--mcp-warn:hover {
        color: oklch(0.55 0.16 65);
      }
      .cw-sb__pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 0.9rem;
        height: 0.9rem;
        padding: 0 0.25rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--destructive) 22%, transparent);
        color: var(--destructive);
        font-size: 0.625rem;
        font-weight: 700;
      }
    `,
  ],
})
export class ClaudeStatusBarComponent {
  readonly phase = input<ClaudeRunPhase>('idle');
  readonly providers = input<AgentRuntimeProviderInfo[]>([]);
  readonly currentProvider = input<AgentProviderId>('claude');
  readonly providerLocked = input(false);
  readonly selectedModel = input<string | null>(null);
  readonly reasoningEffort = input<ClaudeReasoningEffort | null>(null);
  readonly fastMode = input(false);
  readonly availableModels = input<ClaudeModelOption[]>([]);
  readonly contextUsage = input<ClaudeContextUsage | null>(null);
  readonly tasks = input<ClaudeTaskState[]>([]);
  readonly permissionMode = input<ClaudePermissionMode>('default');
  readonly mcpSnapshot = input<ClaudeMcpSnapshot | null>(null);

  readonly modelChange = output<string>();
  readonly reasoningEffortChange = output<ClaudeReasoningEffort | null>();
  readonly fastModeChange = output<boolean>();
  readonly providerChange = output<AgentProviderId>();
  readonly permissionModeChange = output<ClaudePermissionMode>();
  readonly openTerminal = output<void>();
  readonly openTasks = output<void>();
  readonly openMcp = output<void>();

  readonly modelOpen = signal(false);
  readonly effortOpen = signal(false);
  readonly providerOpen = signal(false);
  readonly permissionOpen = signal(false);
  readonly menuOpen = signal(false);

  private readonly host = inject(ElementRef<HTMLElement>);

  onDocumentMousedown(event: MouseEvent): void {
    if (!this.modelOpen() && !this.effortOpen() && !this.providerOpen() && !this.permissionOpen() && !this.menuOpen()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.closeAllMenus();
  }

  closeAllMenus(): void {
    this.modelOpen.set(false);
    this.effortOpen.set(false);
    this.providerOpen.set(false);
    this.permissionOpen.set(false);
    this.menuOpen.set(false);
  }

  toggleMenu(which: 'model' | 'effort' | 'provider' | 'permission' | 'overflow'): void {
    if (which === 'provider' && this.providerLocked()) {
      this.providerOpen.set(false);
      return;
    }

    const next = {
      model: which === 'model' ? !this.modelOpen() : false,
      effort: which === 'effort' ? !this.effortOpen() : false,
      provider: which === 'provider' ? !this.providerOpen() : false,
      permission: which === 'permission' ? !this.permissionOpen() : false,
      overflow: which === 'overflow' ? !this.menuOpen() : false,
    };
    this.modelOpen.set(next.model);
    this.effortOpen.set(next.effort);
    this.providerOpen.set(next.provider);
    this.permissionOpen.set(next.permission);
    this.menuOpen.set(next.overflow);
  }

  readonly permissionOptions = computed(() => {
    if (this.currentProvider() === 'codex') {
      return PERMISSION_MODES.filter((opt) =>
        ['default', 'plan', 'acceptEdits', 'bypassPermissions'].includes(opt.id),
      );
    }
    const modelId = this.selectedModel();
    const models = this.availableModels();
    const effectiveModel = modelId ? models.find((m) => m.id === modelId) : models[0];
    const supportsAuto = effectiveModel?.supportsAutoMode ?? false;
    const current = this.permissionMode();
    return PERMISSION_MODES.filter((opt) => opt.id !== 'auto' || supportsAuto || current === 'auto');
  });
  readonly activePermissionLabel = computed(() => {
    const mode = this.permissionMode();
    return PERMISSION_MODES.find((m) => m.id === mode)?.label ?? mode;
  });
  readonly isPlanMode = computed(() => this.permissionMode() === 'plan' || this.permissionMode() === 'planBypass');
  readonly isPlanBypassMode = computed(() => this.permissionMode() === 'planBypass');

  readonly phaseLabel = computed(() => {
    const p = this.phase();
    if (p === 'running') return 'running';
    if (p === 'waiting') return 'awaiting input';
    if (p === 'error') return 'error';
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
  readonly selectedModelSupportsEffort = computed(() => this.selectedModelOption()?.supportsEffort ?? false);
  readonly selectedModelSupportsFastMode = computed(() => this.selectedModelOption()?.supportsFastMode ?? false);
  readonly reasoningEffortOptions = computed(() => {
    const effort = this.reasoningEffort();
    return effort && !REASONING_EFFORTS.some((option) => option.id === effort)
      ? [{ id: effort, label: effort, hint: 'Custom effort' }, ...REASONING_EFFORTS]
      : REASONING_EFFORTS;
  });
  readonly reasoningEffortLabel = computed(() => {
    const effort = this.reasoningEffort();
    if (!effort) return 'default effort';
    return REASONING_EFFORTS.find((option) => option.id === effort)?.label ?? effort;
  });

  readonly activeProviderLabel = computed(() => {
    return (
      this.providers().find((provider) => provider.id === this.currentProvider())
        ?.displayName ?? this.currentProvider()
    );
  });
  readonly currentProviderCapabilities = computed(() =>
    this.providers().find((provider) => provider.id === this.currentProvider())
      ?.capabilities ?? null,
  );

  pickModel(id: string): void {
    this.modelOpen.set(false);
    this.modelChange.emit(id);
  }

  pickReasoningEffort(effort: ClaudeReasoningEffort | ''): void {
    this.effortOpen.set(false);
    this.reasoningEffortChange.emit(effort || null);
  }

  toggleFastMode(): void {
    this.fastModeChange.emit(!this.fastMode());
  }

  pickProvider(id: AgentProviderId): void {
    this.providerOpen.set(false);
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
    this.permissionOpen.set(false);
    this.permissionModeChange.emit(mode);
  }

  cyclePermissionMode(event: Event): void {
    if (!this.currentProviderCapabilities()?.permissions) return;
    event.preventDefault();
    const opts = this.permissionOptions();
    const current = this.permissionMode();
    const idx = opts.findIndex((o) => o.id === current);
    const next = opts[(idx + 1) % opts.length];
    this.permissionModeChange.emit(next.id as ClaudePermissionMode);
  }
}
