import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IconComponent, StatusGlyphComponent, TooltipDirective, type Status } from '../src/app/ui';

/** Design exploration: sessions whose agent turn ended while shell commands keep running. */
type OptionId = 'today' | 'a' | 'b' | 'c' | 'd' | 'e';
interface MockCommand { readonly label: string; readonly orphaned?: boolean }
interface MockSession {
  readonly id: string;
  readonly title: string;
  /** What the agent itself is doing. */
  readonly turn: Exclude<Status, 'queued'>;
  readonly commands: readonly MockCommand[];
  readonly diff?: { readonly add: number; readonly del: number };
  readonly selected?: boolean;
}
interface MockTask { readonly title: string; readonly collapsed: boolean; readonly sessions: readonly MockSession[] }
interface DesignOption { readonly id: OptionId; readonly overline: string; readonly name: string; readonly good: string; readonly cost: string }

const TASKS: readonly MockTask[] = [
  {
    title: 'Login reliability',
    collapsed: false,
    sessions: [
      { id: 'oauth', title: 'Wire OAuth callback', turn: 'running', commands: [], diff: { add: 18, del: 2 } },
      { id: 'flaky', title: 'Fix flaky login test', turn: 'review', commands: [{ label: 'npm run dev' }, { label: 'tail -f logs/auth.log' }], diff: { add: 41, del: 3 } },
      { id: 'bench', title: 'Bench query planner', turn: 'done', commands: [{ label: 'pnpm bench --watch' }], diff: { add: 12, del: 4 } },
      { id: 'migration', title: 'Review migration order', turn: 'attention', commands: [] },
      { id: 'cache', title: 'Spike: cache layer', turn: 'done', commands: [{ label: 'redis-server', orphaned: true }] },
      { id: 'docs', title: 'Docs pass', turn: 'done', commands: [], selected: true },
    ],
  },
  {
    title: 'Upgrade Angular',
    collapsed: true,
    sessions: [{ id: 'ng', title: 'Run update schematics', turn: 'done', commands: [{ label: 'ng serve' }] }],
  },
];

@Component({
  selector: 'ex-background-commands-demo',
  imports: [IconComponent, StatusGlyphComponent, TooltipDirective],
  templateUrl: './background-commands-demo.component.html',
  styleUrl: './background-commands-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BackgroundCommandsDemoComponent {
  protected readonly tasks = TASKS;
  protected readonly options: readonly DesignOption[] = [
    { id: 'today', overline: 'Current behaviour', name: 'Commands count as running', good: 'Nothing new to learn.', cost: 'A finished agent with a dev server looks like it is still working; its reply dot is hidden and the running counts are inflated.' },
    { id: 'a', overline: 'Option A · recommended', name: 'Real status + terminal icon', good: 'Turn state and commands are separate facts in separate places; the reply dot comes back; no motion.', cost: 'One more item in the trailing slot; it stays on hover (the diff hides for Archive) so its tooltip is reachable.' },
    { id: 'b', overline: 'Option B', name: 'New “commands running” status', good: 'Smallest change: one glyph, fits the status vocabulary.', cost: 'Hides done behind it; a moving glyph still reads as “working”.' },
    { id: 'c', overline: 'Option C', name: 'Corner pip on the glyph', good: 'No layout change; both states visible at once.', cost: 'Tiny at 14px, no room for a count; needs a combined label.' },
    { id: 'd', overline: 'Option D', name: 'Command name in the meta slot', good: 'Most explicit; nobody has to learn a symbol.', cost: 'Replaces the diff; noisy when many dev servers run; truncates.' },
    { id: 'e', overline: 'Option E', name: 'Aggregate on the task only', good: 'Calmest rows; one place for everything running in a workspace.', cost: 'You cannot see which session owns the command without hovering.' },
  ];

  /** Status shown by the leading glyph. */
  protected glyph(option: OptionId, session: MockSession): Status {
    const live = session.commands.length > 0;
    if (option === 'today') return live && session.turn !== 'attention' && session.turn !== 'failed' ? 'running' : session.turn;
    return session.turn;
  }
  /** Option B replaces a finished glyph; attention, failure and replies keep priority. */
  protected commandsGlyph(option: OptionId, session: MockSession): boolean {
    return option === 'b' && session.commands.length > 0 && session.turn === 'done';
  }
  protected trailing(option: OptionId): boolean { return option === 'a'; }
  protected pip(option: OptionId, session: MockSession): boolean { return option === 'c' && session.commands.length > 0; }
  protected words(option: OptionId, session: MockSession): string | null {
    if (option !== 'd' || !session.commands.length) return null;
    const [first, ...rest] = session.commands;
    return rest.length ? `${first!.label} +${rest.length}` : first!.label;
  }
  protected orphaned(session: MockSession): boolean { return session.commands.every(command => command.orphaned); }
  protected describe(session: MockSession): string {
    const count = session.commands.length;
    const names = session.commands.map(command => command.label).join(', ');
    const note = this.orphaned(session) ? ' · left by a finished subagent, nothing waits on it' : ' · agent may resume when it finishes';
    return `${count} command${count === 1 ? '' : 's'} running · ${names}${note}`;
  }
  protected unread(option: OptionId, session: MockSession): boolean {
    return !session.selected && this.glyph(option, session) === 'review';
  }
  protected commandCount(task: MockTask): number {
    return task.sessions.reduce((total, session) => total + session.commands.length, 0);
  }
  protected runningCount(option: OptionId, task: MockTask): number {
    return task.sessions.filter(session => this.glyph(option, session) === 'running').length;
  }
  /** Rail and title-island badge for the whole project. */
  protected railCount(option: OptionId): number {
    return this.tasks.reduce((total, task) => total + this.runningCount(option, task), 0);
  }
  protected projectCommands(): number {
    return this.tasks.reduce((total, task) => total + this.commandCount(task), 0);
  }
  /** Collapsed tasks summarise commands in every option except the baseline. */
  protected taskCommands(option: OptionId, task: MockTask): boolean {
    return option !== 'today' && (option === 'e' || task.collapsed) && this.commandCount(task) > 0;
  }
}
