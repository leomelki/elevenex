import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideLoaderCircle,
  lucidePackage,
  lucideServer,
  lucideTerminal,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';

import { RemoteDependency } from '@/shared/runtime/electron-remote-server';
import { RemoteInstallFlowService } from '@/shared/services/remote-install-flow.service';
import { RemoteInstallerTerminalComponent } from './remote-installer-terminal.component';

interface DependencyMeta {
  label: string;
  description: string;
}

const DEPENDENCY_META: Record<RemoteDependency, DependencyMeta> = {
  claude: {
    label: 'Claude Code',
    description:
      'The `claude` CLI must be installed and on the remote PATH. The native installer places it in ~/.local/bin, which Elevenex resolves automatically.',
  },
  tmux: {
    label: 'tmux',
    description:
      'Required so the Elevenex backend keeps running after the SSH session detaches.',
  },
};

@Component({
  selector: 'app-remote-install-modal',
  standalone: true,
  imports: [CommonModule, NgIcon, RemoteInstallerTerminalComponent],
  templateUrl: './remote-install-modal.component.html',
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideLoaderCircle,
      lucidePackage,
      lucideServer,
      lucideTerminal,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
})
export class RemoteInstallModalComponent {
  private readonly flow = inject(RemoteInstallFlowService);

  readonly state = this.flow.state;
  readonly canRetry = computed(() => {
    const state = this.state();
    return Boolean(state && !state.checking);
  });

  // Which command string was most recently copied, so we can flip its button to
  // a checkmark briefly. Cleared by a timer.
  readonly copiedCommand = signal<string | null>(null);
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  metaFor(dependency: RemoteDependency): DependencyMeta {
    return DEPENDENCY_META[dependency];
  }

  async cancel(): Promise<void> {
    await this.flow.cancel();
  }

  async recheck(): Promise<void> {
    await this.flow.recheck();
  }

  async copy(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.copiedCommand.set(command);
      if (this.copyResetTimer) {
        clearTimeout(this.copyResetTimer);
      }
      this.copyResetTimer = setTimeout(() => this.copiedCommand.set(null), 1500);
    } catch {
      // Clipboard may be unavailable; the command is still selectable.
    }
  }
}
