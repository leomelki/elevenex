import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { TaskAppSetupIssue } from '@elevenex/shared';
import { ButtonComponent, IconButtonComponent, StatusGlyphComponent } from '../ui';
import { hostName, macName, type AppPlace } from './app-recovery';

interface SetupStep {
  readonly text: string;
  /** The step's own action: the Mac agent's setup window, or the host's settings. */
  readonly opens?: 'setup' | 'settings';
}

interface SetupGuide {
  readonly title: string;
  /** What the host found, in one short sentence. */
  readonly why: string;
  readonly steps: readonly SetupStep[];
  /** Offers the Finder/path fallback for adding Elevenex Agent to a permission list. */
  readonly agentPermission?: boolean;
  /** Only a person at the machine can do it: permissions and sign-in can't be granted remotely. */
  readonly inPerson?: boolean;
}

function updateStep(place: AppPlace): SetupStep {
  return { text: place.remote ? `Reconnect ${hostName(place)} to update its engine.` : 'Update Elevenex, then restart it.' };
}

function guideFor(issue: TaskAppSetupIssue, place: AppPlace): SetupGuide {
  const host = hostName(place), mac = macName(place);
  switch (issue) {
    case 'macos-screen-recording': return {
      title: 'Allow Screen Recording',
      why: 'Elevenex Agent needs it to show app windows.',
      steps: [
        { text: 'Open the Elevenex Agent setup window.', opens: 'setup' },
        { text: 'Drag Elevenex Agent into Screen & System Audio Recording and turn it on.' },
        { text: 'If macOS asks, choose Quit & Reopen.' },
      ],
      agentPermission: true, inPerson: true,
    };
    case 'macos-accessibility': return {
      title: 'Allow Accessibility',
      why: 'Elevenex Agent needs it to send your clicks and keys. You can still watch.',
      steps: [
        { text: 'Open the Elevenex Agent setup window.', opens: 'setup' },
        { text: 'Drag Elevenex Agent into Accessibility and turn it on.' },
      ],
      agentPermission: true, inPerson: true,
    };
    case 'macos-session': return {
      title: 'Unlock the Mac', inPerson: true,
      why: `No one is signed in and unlocked on ${mac}.`,
      steps: [
        { text: 'Sign in with the account Elevenex uses, and unlock the screen.' },
        { text: 'Open the Elevenex Agent setup window to check permissions.', opens: 'setup' },
      ],
    };
    case 'macos-desktop-connection': return {
      title: 'Can\'t reach the Mac desktop', inPerson: true,
      why: `Permissions alone aren't enough: Elevenex Agent also needs a connection to the desktop on ${mac}.`,
      steps: [
        { text: `Make sure ${mac} is signed in and unlocked.` },
        { text: 'Open the Elevenex Agent setup window to check permissions.', opens: 'setup' },
        { text: place.remote ? `Still failing? Reconnect ${host} to update its engine.` : 'Still failing? Update Elevenex, then restart it.' },
      ],
    };
    case 'macos-runtime': return {
      title: 'Update Elevenex on the Mac',
      why: `The engine on ${mac} is missing the display helper.`,
      steps: [{ text: `Check that ${mac} runs macOS 14 or later.` }, updateStep(place)],
    };
    case 'windows-session': return {
      title: 'Unlock the Windows desktop', inPerson: true,
      why: `No one is signed in and unlocked on ${host}.`,
      steps: [
        { text: 'Sign in with the account Elevenex uses.' },
        { text: 'Unlock the screen and stay signed in.' },
      ],
    };
    case 'windows-capture': return {
      title: 'Windows blocked app capture',
      why: `Windows Graphics Capture isn't available on ${host}.`,
      steps: [
        { text: 'Check that Windows is 10 (1903 or later) or 11.', opens: 'settings' },
        { text: 'Update the graphics driver and Elevenex.' },
      ],
    };
    case 'windows-runtime': return {
      title: 'Update Elevenex on Windows',
      why: `The engine on ${host} is missing what app sharing needs.`,
      steps: [updateStep(place), { text: 'Keep the desktop signed in.' }],
    };
    case 'linux-display-tools': return {
      title: 'Install display tools',
      why: `${place.remote ? host : 'This computer'} is missing tools for a private display.`,
      steps: [
        { text: 'Install them with the package manager.' },
        { text: 'Streaming also needs Xvfb with XTEST and an H.264 encoder.' },
      ],
    };
    case 'linux-session': return {
      title: 'No desktop session', inPerson: true,
      why: `This app needs a graphical session on ${host}.`,
      steps: [
        { text: `Sign in to a desktop session on ${host}.` },
        { text: 'On a headless machine, decline and ask your agent to stream the app instead.' },
      ],
    };
  }
}

@Component({
  selector: 'ex-task-app-setup',
  imports: [ButtonComponent, IconButtonComponent, StatusGlyphComponent],
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
  readonly guide = computed(() => guideFor(this.issue(), this.place()));
  readonly missingTools = computed(() => this.issue() === 'linux-display-tools' ? this.detail() : '');
  readonly diagnostic = computed(() => this.missingTools() ? '' : this.detail());

  openLabel(step: SetupStep): string {
    const target = step.opens === 'setup' ? 'Elevenex Agent setup' : 'Settings';
    return this.remote() ? `Open ${target} on ${this.host()}` : `Open ${target}`;
  }

  copy(): void {
    const { title, why, steps } = this.guide();
    this.copyInstructions.emit([
      `Elevenex needs setup on ${this.host()}: ${title}.`,
      why,
      ...steps.map((step, index) => `${index + 1}. ${step.text}`),
      ...(this.missingTools() ? [this.missingTools()] : []),
      ...(this.helperPath() ? [`Elevenex Agent: ${this.helperPath()}`] : []),
    ].join('\n'));
  }
}
