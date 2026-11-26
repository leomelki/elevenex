import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { TaskAppSetupIssue } from '@elevenex/shared';
import { ButtonComponent, IconComponent } from '../ui';
import { hostName, macName, type AppPlace } from './app-recovery';

interface SetupGuide {
  readonly title: string;
  /** What the host found, in one sentence. */
  readonly why: string;
  readonly steps: readonly string[];
  /** Offers the host-side open action. `setup` is the Mac agent window; otherwise System Settings. */
  readonly open?: 'setup' | 'settings';
  readonly agentPermission?: boolean;
  /** Shown after the steps when permissions alone are not the whole fix. */
  readonly caveat?: string;
}

function guideFor(issue: TaskAppSetupIssue, place: AppPlace): SetupGuide {
  const host = hostName(place), mac = macName(place);
  switch (issue) {
    case 'macos-screen-recording': return {
      title: 'Allow Screen Recording',
      why: `Elevenex Agent can't capture app windows on ${mac} until macOS allows it.`,
      steps: [
        `Open setup on ${mac}. A small Elevenex Agent window opens beside System Settings.`,
        'Drag Elevenex Agent into the Screen & System Audio Recording list, then turn on its switch.',
        'If macOS asks you to quit and reopen Elevenex Agent, accept.',
      ],
      open: 'setup', agentPermission: true,
    };
    case 'macos-accessibility': return {
      title: 'Allow keyboard and mouse control',
      why: `Elevenex Agent can show the app but can't send your clicks and keys to it on ${mac}.`,
      steps: [
        `Open setup on ${mac}.`,
        'Drag Elevenex Agent into the Accessibility list in System Settings, then turn on its switch.',
      ],
      open: 'setup', agentPermission: true,
    };
    case 'macos-session': return {
      title: 'Check the Mac desktop',
      why: `Elevenex couldn't find a signed-in, unlocked desktop on ${mac}.`,
      steps: [
        `Sign in on ${mac} with the account Elevenex connects as.`,
        'Unlock the desktop and leave the account signed in.',
        `Open setup on ${mac} to check Elevenex Agent's permissions.`,
      ],
      open: 'setup',
    };
    case 'macos-desktop-connection': return {
      title: 'Connect to the Mac desktop',
      why: `Elevenex Agent couldn't establish its private connection to the desktop on ${mac}.`,
      steps: [
        `Make sure someone is signed in and unlocked at ${mac}.`,
        `Open setup on ${mac} to check Elevenex Agent's permissions.`,
        'Check and launch again. If the connection still fails, reconnect the machine to update its engine and retry.',
      ],
      open: 'setup',
      caveat: `The permission check and the connection to ${mac}'s desktop must both succeed before the app can launch.`,
    };
    case 'macos-runtime': return {
      title: 'Update Elevenex on the Mac',
      why: `The engine on ${mac} doesn't include the display helper that app sharing needs.`,
      steps: [
        `Check that ${mac} runs macOS 14 or later.`,
        'Update or reconnect the managed Elevenex engine so it installs the helper.',
      ],
    };
    case 'windows-session': return {
      title: 'Sign in to the Windows desktop',
      why: `Elevenex couldn't reach a signed-in, unlocked desktop on ${host}.`,
      steps: [
        `Sign in on ${host} with the same account Elevenex uses to connect.`,
        'Unlock the desktop and leave the session open.',
      ],
    };
    case 'windows-capture': return {
      title: 'Check Windows Graphics Capture',
      why: `Windows on ${host} didn't allow app capture.`,
      steps: [
        `On ${host}, open Settings → System → About and check that Windows is version 10 (1903 or later) or 11.`,
        'Update the graphics driver and the managed Elevenex engine. Keep the desktop signed in and unlocked.',
      ],
      open: 'settings',
    };
    case 'windows-runtime': return {
      title: 'Update Elevenex on Windows',
      why: `The engine on ${host} doesn't include what app sharing needs.`,
      steps: [
        `Update or reconnect the managed Elevenex engine on ${host}.`,
        'Keep the Windows desktop signed in with the account Elevenex uses to connect.',
      ],
    };
    case 'linux-display-tools': return {
      title: 'Set up a Linux display',
      why: `${host} is missing tools for a private app display.`,
      steps: [
        `Install the missing tools on ${host} with its package manager.`,
        'For streaming, use Xvfb with XTEST and a working H.264 encoder.',
      ],
    };
    case 'linux-session': return {
      title: 'Sign in to the Linux desktop',
      why: `This request needs a graphical session on ${host}, and none is available.`,
      steps: [
        `Sign in to a graphical session on ${host}.`,
        'On a headless machine, decline this request and ask your agent to launch a stream instead.',
      ],
    };
  }
}

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
  /** What the machine reported. Shown as a diagnostic, except where it names missing tools. */
  readonly detail = input('');
  readonly remote = input(false);
  readonly canOpenSettings = input(false);
  readonly canRevealHelper = input(false);
  readonly helperPath = input('');
  readonly busy = input(false);
  readonly feedback = input('');
  readonly openSettings = output<void>();
  readonly revealHelper = output<void>();
  readonly copyHelperPath = output<void>();
  readonly copyInstructions = output<string>();
  readonly place = computed<AppPlace>(() => ({ machine: this.machine(), remote: this.remote() }));
  readonly host = computed(() => hostName(this.place()));
  readonly mac = computed(() => macName(this.place()));
  readonly guide = computed(() => guideFor(this.issue(), this.place()));
  readonly missingTools = computed(() => this.issue() === 'linux-display-tools' ? this.detail() : '');
  readonly diagnostic = computed(() => this.missingTools() ? '' : this.detail());
  readonly openLabel = computed(() => {
    const open = this.guide().open;
    if (!open) return '';
    if (open === 'setup') return this.remote() ? 'Open setup on host' : 'Open setup';
    return this.remote() ? 'Open settings on host' : 'Open System Settings';
  });
  /** Says what the button really does, because the host's screen is out of sight. */
  readonly openHint = computed(() => this.guide().open === 'setup'
    ? `Asks macOS to open Elevenex Agent on ${this.mac()}. Elevenex can't see that screen, so look there to confirm.`
    : `Asks ${this.host()} to open System Settings. Elevenex can't see that screen, so look there to confirm.`);

  copy(): void {
    const { title, why, steps, caveat } = this.guide();
    const host = this.host();
    this.copyInstructions.emit([
      `Elevenex Apps needs setup on ${this.remote() ? host : 'this computer'}: ${title}.`,
      why,
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      ...(caveat ? [caveat] : []),
      ...(this.helperPath() ? [`Elevenex Agent on ${host}: ${this.helperPath()}`] : []),
      ...(this.missingTools() ? [this.missingTools()] : []),
      'Someone must do these steps at the machine itself. Then retry the launch in Elevenex.',
    ].join('\n'));
  }
}
