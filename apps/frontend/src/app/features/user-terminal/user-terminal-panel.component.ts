import {
  Component,
  inject,
  input,
  output,
  effect,
  computed,
  viewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus, lucideX, lucideTerminal } from '@ng-icons/lucide';
import { UserTerminalStateService } from './user-terminal-state.service';
import { UserTerminalApiService } from '@/shared/services/user-terminal-api.service';
import { UserTerminalViewComponent } from './user-terminal-view.component';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-user-terminal-panel',
  standalone: true,
  imports: [CommonModule, NgIcon, UserTerminalViewComponent],
  templateUrl: './user-terminal-panel.component.html',
  styleUrls: ['./user-terminal-panel.component.scss'],
  viewProviders: [provideIcons({ lucidePlus, lucideX, lucideTerminal })],
})
export class UserTerminalPanelComponent {
  worktreePath = input.required<string>();
  close = output<void>();

  private state = inject(UserTerminalStateService);
  private api = inject(UserTerminalApiService);
  private currentWorktree = '';

  terminalViews = viewChildren(UserTerminalViewComponent);

  // Reactive — re-evaluate whenever state signal changes
  terminals = computed(() => this.state.getTerminals(this.worktreePath()));
  activeTerminalId = computed(() => this.state.getActiveTerminalId(this.worktreePath()));

  private worktreeEffect = effect(() => {
    const wt = this.worktreePath();
    if (wt && wt !== this.currentWorktree) {
      this.currentWorktree = wt;
      this.loadTerminals(wt);
    }
  });

  private async loadTerminals(worktreePath: string): Promise<void> {
    const terminals = await this.state.loadTerminals(worktreePath);

    // Auto-create first terminal if none exist
    if (terminals.length === 0) {
      await this.createTerminal();
    }
  }

  async createTerminal(): Promise<void> {
    const wt = this.worktreePath();
    if (!wt) return;

    const terminal = await firstValueFrom(this.api.create(wt));
    this.state.addTerminal(wt, terminal);

    // Focus the new terminal after it renders
    setTimeout(() => {
      const view = this.terminalViews().find(v => v.terminalId === terminal.id);
      view?.fit();
      view?.focus();
    }, 50);
  }

  selectTerminal(terminalId: number): void {
    const wt = this.worktreePath();
    if (!wt) return;

    this.state.setActiveTerminal(wt, terminalId);

    setTimeout(() => {
      const view = this.terminalViews().find(v => v.terminalId === terminalId);
      view?.fit();
      view?.focus();
    }, 0);
  }

  async closeTerminal(event: MouseEvent, terminalId: number): Promise<void> {
    event.stopPropagation();
    const wt = this.worktreePath();
    if (!wt) return;

    await firstValueFrom(this.api.remove(terminalId));
    this.state.removeTerminal(wt, terminalId);

    // Close panel if no terminals left
    if (this.terminals().length === 0) {
      this.close.emit();
    }
  }

  closePanel(): void {
    this.close.emit();
  }

  isActive(terminalId: number): boolean {
    return terminalId === this.activeTerminalId();
  }
}
