import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, output, signal,
} from '@angular/core';
import type { SessionAgentSelection } from '@elevenex/shared';
import {
  AutoHeightDirective, ButtonComponent, EaseSwapComponent, FlipDirective, FoldComponent, IconComponent,
  StatusGlyphComponent, TickerComponent, TooltipDirective,
} from '../../ui';
import { AgentMarkComponent } from '../composer/agent-mark.component';
import { agentControl, agentIdentity, agentWorkLive, agentWorkState, type AgentWorkBoard, type AgentWorkCard, type AgentWorkIntent } from './agent-work.models';

@Component({
  selector: 'ex-agent-work-board',
  imports: [AgentMarkComponent, AutoHeightDirective, ButtonComponent, EaseSwapComponent, FlipDirective, FoldComponent,
    IconComponent, StatusGlyphComponent, TickerComponent, TooltipDirective],
  templateUrl: './agent-work-board.component.html',
  styleUrl: './agent-work-board.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentWorkBoardComponent {
  readonly board = input.required<AgentWorkBoard>();
  readonly active = input(true);
  readonly controlsDisabled = input(false);
  readonly requested = output<AgentWorkIntent>();
  protected readonly grouped = computed(() => this.board().agents.length > 1);
  protected readonly structure = computed(() => this.board().agents.map(agent => agent.id).join('\0'));
  protected readonly live = computed(() => this.board().agents.some(agent => agentWorkLive(agent.status)));
  protected readonly now = signal(Date.now());
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly identity = agentIdentity;
  protected readonly state = agentWorkState;

  constructor() {
    const ticks = computed(() => this.active() && this.board().agents.some(agent =>
      agent.startedAt !== undefined && agent.endedAt === undefined && agentWorkLive(agent.status) && agent.status !== 'paused'));
    effect(cleanup => {
      if (!ticks()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      cleanup(() => clearInterval(timer));
    });
  }

  protected elapsed(agent: AgentWorkCard): { major: string; seconds: number } | undefined {
    if (agent.startedAt === undefined || (agent.endedAt === undefined && !agentWorkLive(agent.status))) return;
    const seconds = Math.max(0, Math.floor(((agent.endedAt ?? this.now()) - agent.startedAt) / 1000));
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
    return { major: hours ? hours + 'h ' + minutes + 'm' : minutes ? minutes + 'm ' : '', seconds: seconds % 60 };
  }

  protected activity(agent: AgentWorkCard, statusLabel: string): string {
    const detail = agent.detail.trim();
    return detail.replace(/[.!…]+$/, '').toLowerCase() === statusLabel.toLowerCase() ? '' : detail;
  }

  protected compactIdentity(selection: SessionAgentSelection): string {
    return agentIdentity({ ...selection, model: selection.model?.split('/').at(-1) || selection.model });
  }

  protected request(agent: AgentWorkCard, action: AgentWorkIntent['action'], event: Event): void {
    const control = agentControl(event);
    if (!agent.target || !this.active() ||
        (agent.target.kind === 'session' && this.controlsDisabled()) ||
        control?.getAttribute('aria-disabled') === 'true') return;
    const origin = control?.closest<HTMLElement>('.agent') ?? this.element;
    this.requested.emit({ target: agent.target, action, origin });
  }
}
