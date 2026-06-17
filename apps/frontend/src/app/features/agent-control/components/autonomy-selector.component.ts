import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideListChecks, lucideShieldCheck, lucideZap } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@/shared/components/button';
import { AGENT_AUTONOMY_MODES, AgentAutonomyMode } from '../agent-control.model';

/**
 * Compact segmented control for choosing the agent autonomy mode.
 * Selected mode renders as a primary button; the rest as ghost. Fully
 * keyboard-operable (arrow keys + Enter/Space) with roving aria-pressed state.
 */
@Component({
  selector: 'app-autonomy-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, ZardButtonComponent],
  viewProviders: [provideIcons({ lucideZap, lucideShieldCheck, lucideListChecks })],
  templateUrl: './autonomy-selector.component.html',
  styleUrl: './autonomy-selector.component.scss',
})
export class AutonomySelectorComponent {
  readonly mode = input.required<AgentAutonomyMode>();
  readonly disabled = input(false);
  readonly modeChange = output<AgentAutonomyMode>();

  protected readonly modes = AGENT_AUTONOMY_MODES;
  protected readonly activeDescription = computed(
    () => AGENT_AUTONOMY_MODES.find((m) => m.id === this.mode())?.description ?? '',
  );

  protected select(mode: AgentAutonomyMode): void {
    if (this.disabled() || mode === this.mode()) {
      return;
    }
    this.modeChange.emit(mode);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (this.disabled()) {
      return;
    }
    const modes = this.modes;
    const currentIndex = modes.findIndex((m) => m.id === this.mode());
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.modeChange.emit(modes[(currentIndex + 1) % modes.length].id);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.modeChange.emit(modes[(currentIndex - 1 + modes.length) % modes.length].id);
    }
  }
}
