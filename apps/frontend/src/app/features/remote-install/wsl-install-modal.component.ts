import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideHardDrive,
  lucideLoaderCircle,
  lucidePackage,
  lucideTerminal,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';

import { RemoteDependency } from '@/shared/runtime/electron-remote-server';
import { WslInstallFlowService } from '@/shared/services/wsl-install-flow.service';
import { WslInstallerTerminalComponent } from './wsl-installer-terminal.component';

interface DependencyMeta {
  label: string;
  description: string;
}

const DEPENDENCY_META: Record<RemoteDependency, DependencyMeta> = {
  claude: {
    label: 'Claude Code',
    description:
      'The `claude` CLI must be installed and on the WSL distro\'s PATH. The native installer places it in ~/.local/bin, which Elevenex resolves automatically.',
  },
  tmux: {
    label: 'tmux',
    description: 'Required so the Elevenex backend keeps running inside WSL across reconnects.',
  },
};

// Mirrors RemoteInstallModalComponent, but for the singleton WSL connection
// (WslInstallFlowService) instead of a saved SSH server.
@Component({
  selector: 'app-wsl-install-modal',
  standalone: true,
  imports: [CommonModule, NgIcon, WslInstallerTerminalComponent],
  templateUrl: './wsl-install-modal.component.html',
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideHardDrive,
      lucideLoaderCircle,
      lucidePackage,
      lucideTerminal,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
})
export class WslInstallModalComponent {
  private readonly flow = inject(WslInstallFlowService);

  readonly state = this.flow.state;
  readonly canRetry = computed(() => {
    const state = this.state();
    return Boolean(state && !state.checking);
  });

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
