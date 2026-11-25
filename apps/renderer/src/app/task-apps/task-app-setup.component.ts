import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { TaskAppSetupIssue } from '@elevenex/shared';
import { ButtonComponent, IconComponent } from '../ui';

interface SetupGuide {
  readonly title: string;
  readonly steps: readonly string[];
  readonly settings?: boolean;
}

const guides: Record<TaskAppSetupIssue, SetupGuide> = {
  'macos-screen-recording': {
    title: 'Allow Screen Recording',
    steps: [
      'On the task Mac, open System Settings → Privacy & Security → Screen & System Audio Recording.',
      'Turn on Elevenex App Display. If it is missing, use the permission prompt or add the installed task-app-macos helper.',
      'If macOS asks you to quit and reopen the helper, accept.',
    ],
    settings: true,
  },
  'macos-accessibility': {
    title: 'Allow keyboard and mouse control',
    steps: [
      'On the task Mac, open System Settings → Privacy & Security → Accessibility.',
      'Turn on Elevenex App Display, then return to the app viewer.',
    ],
    settings: true,
  },
  'macos-session': {
    title: 'Sign in to the task Mac',
    steps: [
      'Sign in on the Mac with the same account Elevenex uses to connect.',
      'Unlock the desktop and leave the account signed in.',
    ],
  },
  'macos-runtime': {
    title: 'Update Elevenex on the Mac',
    steps: [
      'Check that the task Mac runs macOS 14 or later.',
      'Update or reconnect the managed Elevenex engine so it has the App Display helper.',
    ],
  },
  'windows-session': {
    title: 'Sign in to the Windows desktop',
    steps: [
      'Sign in on the Windows machine with the same account Elevenex uses to connect.',
      'Unlock the desktop and leave the session open.',
    ],
  },
  'windows-capture': {
    title: 'Check Windows Graphics Capture',
    steps: [
      'On the task machine, open Settings → System → About and check that Windows is version 10 (1903 or later) or 11.',
      'Update the graphics driver and the managed Elevenex engine. Keep the Windows desktop signed in and unlocked.',
    ],
    settings: true,
  },
  'windows-runtime': {
    title: 'Update Elevenex on Windows',
    steps: [
      'Update or reconnect the managed Elevenex engine on the task machine.',
      'Keep the Windows desktop signed in with the account Elevenex uses to connect.',
    ],
  },
  'linux-display-tools': {
    title: 'Set up a Linux display',
    steps: [
      'Install the missing tools on the task machine using its package manager.',
      'For streaming, use Xvfb with XTEST and a working H.264 encoder.',
    ],
  },
  'linux-session': {
    title: 'Sign in to the Linux desktop',
    steps: [
      'Sign in to a graphical session on the task machine.',
      'For a headless machine, decline this request and ask your agent to launch a stream.',
    ],
  },
};

@Component({
  selector: 'ex-task-app-setup',
  imports: [ButtonComponent, IconComponent],
  templateUrl: './task-app-setup.component.html',
  styleUrl: './task-app-setup.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TaskAppSetupComponent {
  readonly issue = input.required<TaskAppSetupIssue>();
  readonly machine = input.required<string>();
  readonly detail = input('');
  readonly remote = input(false);
  readonly canOpenSettings = input(false);
  readonly busy = input(false);
  readonly feedback = input('');
  readonly openSettings = output<void>();
  readonly copyInstructions = output<string>();
  readonly guide = computed(() => guides[this.issue()]);

  copy(): void {
    const { title, steps } = this.guide();
    const machine = this.machine() || 'the task machine';
    this.copyInstructions.emit([
      `Elevenex Apps needs setup on ${machine}. ${title}.`,
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      ...(this.issue() === 'linux-display-tools' && this.detail() ? [this.detail()] : []),
      'Let me know when the task machine is ready so I can retry.',
    ].join('\n'));
  }
}
