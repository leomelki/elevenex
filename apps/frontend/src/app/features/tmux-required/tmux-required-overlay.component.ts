import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideRefreshCw,
  lucideTerminal,
} from '@ng-icons/lucide';

interface InstallOption {
  label: string;
  command: string;
}

@Component({
  selector: 'app-tmux-required-overlay',
  standalone: true,
  imports: [NgIcon],
  templateUrl: './tmux-required-overlay.component.html',
  styleUrl: './tmux-required-overlay.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideRefreshCw,
      lucideTerminal,
    }),
  ],
})
export class TmuxRequiredOverlayComponent {
  /** Node platform of the backend host, used to tailor install guidance. */
  readonly platform = input<string | null>(null);
  /** Disables the action button while a restart/reconnect is in flight. */
  readonly busy = input(false);
  /** Emitted when the user triggers the primary action. */
  readonly action = output<void>();

  private readonly copiedCommand = signal<string | null>(null);

  readonly isWindows = computed(() => this.platform() === 'win32');

  readonly installOptions = computed<InstallOption[]>(() => {
    switch (this.platform()) {
      case 'win32':
        return [
          { label: 'winget', command: 'winget install psmux' },
          { label: 'Scoop', command: 'scoop install psmux' },
          { label: 'Chocolatey', command: 'choco install psmux' },
        ];
      case 'darwin':
        return [{ label: 'Homebrew', command: 'brew install tmux' }];
      case 'linux':
        return [
          { label: 'Debian / Ubuntu', command: 'sudo apt install tmux' },
          { label: 'Fedora', command: 'sudo dnf install tmux' },
          { label: 'Arch', command: 'sudo pacman -S tmux' },
        ];
      default:
        return [{ label: 'Package manager', command: 'tmux' }];
    }
  });

  isCopied(command: string): boolean {
    return this.copiedCommand() === command;
  }

  async copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.copiedCommand.set(command);
      setTimeout(() => {
        if (this.copiedCommand() === command) {
          this.copiedCommand.set(null);
        }
      }, 1500);
    } catch {
      // Clipboard access may be unavailable; copying is a convenience only.
    }
  }

  emitAction(): void {
    if (this.busy()) {
      return;
    }
    this.action.emit();
  }
}
