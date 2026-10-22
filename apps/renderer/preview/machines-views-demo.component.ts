import { TitleIslandDemoComponent } from './title-island-demo.component';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { ButtonComponent } from '../src/app/ui';
import { GettingReadyComponent, HostFieldComponent, HostKeyCheckComponent, IslandNameComponent, Machine, MachineCardComponent, MachineHomeComponent, MachineLaunchComponent, MachineOpenEvent, MachinePanelComponent, PairingTextComponent, PairPasteComponent, RunChoiceComponent, TitleBarComponent, TitleIslandComponent, MachineKind, SshHost } from '../src/app/machines';
import { BrowserDriver, BrowserViewComponent, ChangeFile, ChangeListComponent, DiffContextRequest, DiffFileContent, DiffFileRequest, DiffReviewComponent, ReviewMode, TerminalLine, TerminalTab, TerminalViewComponent } from '../src/app/views';

@Component({
  selector: 'ex-machines-views-demo',
  imports: [TitleIslandDemoComponent, ButtonComponent, GettingReadyComponent, HostFieldComponent, HostKeyCheckComponent, IslandNameComponent, MachineCardComponent, MachineHomeComponent, MachineLaunchComponent, MachinePanelComponent, PairingTextComponent, PairPasteComponent, RunChoiceComponent, TitleBarComponent, TitleIslandComponent, BrowserViewComponent, TerminalViewComponent, DiffReviewComponent, ChangeListComponent],
  templateUrl: './machines-views-demo.component.html',
  styleUrl: './machines-views-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MachinesViewsDemoComponent {
  protected readonly machines: readonly Machine[] = [
    { id: 'local', name: 'This Mac', kind: 'local', conn: 'live', status: '3 running · 1 needs you', windows: 1, color: 'ocean' },
    { id: 'dev', name: 'dev-box', kind: 'ssh', conn: 'kept', status: '2 running · 1 review', address: 'leo@dev.internal', color: 'pine' },
    { id: 'studio', name: 'Studio Mac', kind: 'peer', conn: 'idle', last: 'Opened 2 h ago · 3 were running', color: 'plum' },
    { id: 'server', name: 'Build server', kind: 'ssh', conn: 'fail', last: 'Last tried 15 min ago', color: 'rust' },
    { id: 'update', name: 'workstation', kind: 'ssh', conn: 'idle', update: '1.5.2', color: 'steel' },
  ];
  protected readonly opened = signal(false);
  protected readonly machine = signal<Machine>(this.machines[0]!);
  protected readonly panelOpen = signal(false);
  protected readonly runChoice = signal<MachineKind>('local');
  protected readonly hostQuery = signal('dev');
  protected readonly hostPicked = signal(false);
  protected readonly copied = signal(false);
  protected readonly pairText = signal('');
  protected readonly driver = signal<BrowserDriver>('agent');
  protected readonly phone = signal<'full' | 'phone'>('full');
  protected readonly picking = signal(false);
  protected readonly picked = computed(() => this.picking() ? { x: 40, y: 120, w: 190, h: 38, label: 'button.pay', file: 'CheckoutForm.tsx:88' } : undefined);
  protected readonly browserActive = signal('checkout');
  protected readonly browserTabs = signal([{ id: 'checkout', title: 'Checkout', url: 'http://localhost:3000/checkout', server: 'web', by: 'agent' as const }, { id: 'docs', title: 'API docs', url: 'https://docs.example.com', by: 'you' as const }]);
  protected readonly terminalTabs = signal<readonly TerminalTab[]>([{ id: 'web', title: 'web :3000', status: 'serving', port: 3000, cwd: '~/elevenex/tasks/retry', branch: 'fix/retry' }, { id: 'test', title: 'Tests', status: 'failed', cwd: '~/elevenex/tasks/retry', unread: true }]);
  protected readonly terminalActive = signal('test');
  protected readonly terminalFailure = signal<{ code: number; cmd: string } | null>({ code: 1, cmd: 'pnpm test retry' });
  protected readonly terminalLines: readonly TerminalLine[] = [{ id: 'a', kind: 'cmd', text: '❯ pnpm test retry' }, { id: 'b', kind: 'dim', text: 'Running 24 tests in src/retry.spec.ts' }, { id: 'c', kind: 'ok', text: '✓ retries after a temporary failure' }, { id: 'd', kind: 'err', text: '× gives up after the maximum attempts' }, { id: 'e', kind: 'warn', text: 'Expected 3 attempts, received 4' }, { id: 'f', kind: 'info', text: '23 passed · 1 failed · 412ms' }];
  protected readonly files = signal<readonly ChangeFile[]>([
    { id: 'retry', path: 'src/payments/retry.ts', status: 'M', add: 8, del: 3, rev: 1 },
    { id: 'tests', path: 'src/payments/retry.spec.ts', status: 'A', add: 24, del: 0, viewed: true, changedSinceViewed: true, rev: 2 },
    { id: 'renamed', path: 'src/payments/client.ts', oldPath: 'src/client.ts', status: 'R', add: 2, del: 1, viewed: true, rev: 1 },
    { id: 'binary', path: 'public/checkout.png', status: 'M', add: 0, del: 0, binary: true },
    { id: 'error', path: 'src/config.ts', status: 'M', add: 1, del: 1 },
    { id: 'large', path: 'pnpm-lock.yaml', status: 'M', add: 502, del: 122 },
  ]);
  protected readonly contents = signal<readonly DiffFileContent[]>([
    this.sampleContent('retry', 'changes', 1), this.sampleContent('tests', 'changes', 2),
    { fileId: 'error', mode: 'changes', state: 'error', error: 'This version is temporarily unavailable.' },
  ]);
  protected readonly mode = signal<ReviewMode>('changes');
  protected readonly wide = signal(false);
  protected readonly wrap = signal(true);
  protected readonly currentFile = signal('retry');
  protected readonly event = signal('Choose an action to see the emitted intent.');
  private nextTab = 0;

  protected openMachine(event: MachineOpenEvent): void { this.machine.set(event.machine); this.opened.set(true); this.log(`Open ${event.machine.name}${event.newWindow ? ' in a new window' : ''}`); }
  protected log(message: string): void { this.event.set(message); }
  protected pickHost(host: SshHost): void { this.hostQuery.set(host.name); this.hostPicked.set(true); this.log(`Select SSH host: ${host.name}`); }
  protected newBrowserTab(): void { const id = `preview-${++this.nextTab}`; this.browserTabs.update(tabs => [...tabs, { id, title: 'New tab', url: 'about:blank', by: 'you' }]); this.browserActive.set(id); }
  protected closeBrowser(id: string): void { this.browserTabs.update(tabs => tabs.filter(tab => tab.id !== id)); if (this.browserActive() === id) this.browserActive.set(this.browserTabs()[0]?.id ?? ''); }
  protected closeTerminal(id: string): void { this.terminalTabs.update(tabs => tabs.filter(tab => tab.id !== id)); this.terminalActive.set(this.terminalTabs()[0]?.id ?? ''); }
  protected newTerminal(): void { const id = `terminal-${++this.nextTab}`; this.terminalTabs.update(tabs => [...tabs, { id, title: 'Shell', cwd: '~/elevenex/tasks/retry', status: 'idle' }]); this.terminalActive.set(id); }
  protected viewed(event: { fileId: string; viewed: boolean }): void { this.files.update(files => files.map(file => file.id === event.fileId ? { ...file, viewed: event.viewed, changedSinceViewed: false } : file)); this.log(`${event.viewed ? 'Viewed' : 'Reopened'} ${event.fileId}`); }
  protected load(request: DiffFileRequest): void { this.contents.update(contents => [...contents.filter(content => content.fileId !== request.fileId), this.sampleContent(request.fileId, request.mode, request.rev)]); this.log(`Request ${request.reason}: ${request.fileId}, ${request.mode}`); }
  protected context(request: DiffContextRequest): void { this.log(`Request ${request.count} lines ${request.direction} ${request.hunkId}`); }
  protected changeMode(mode: ReviewMode): void { this.mode.set(mode); this.contents.update(contents => contents.map(content => ({ ...content, mode }))); }
  private sampleContent(fileId: string, mode: ReviewMode, rev?: string | number): DiffFileContent {
    return { fileId, mode, rev, state: 'ready', hunks: [{ id: `${fileId}-hunk`, heading: '@@ −54,5 +54,10 @@ async function retryPayment()', before: 25, after: 32, lines: [
      { id: 'context', kind: 'context', oldNumber: 54, newNumber: 54, text: 'async function retryPayment(charge) {', spans: [{ text: 'async function ', token: 'keyword' }, { text: 'retryPayment', token: 'function' }, { text: '(charge) {' }] },
      { id: 'remove', kind: 'del', oldNumber: 55, text: '  return await send(charge);' },
      { id: 'add-a', kind: 'add', newNumber: 55, text: '  return await withRetry(() => send(charge), {', spans: [{ text: '  return await ', token: 'keyword' }, { text: 'withRetry', token: 'function', changed: true }, { text: '(() => send(charge), {' }] },
      { id: 'add-b', kind: 'add', newNumber: 56, text: '    maxAttempts: 3,', spans: [{ text: '    maxAttempts: ' }, { text: '3', token: 'number', changed: true }, { text: ',' }] },
      { id: 'add-c', kind: 'add', newNumber: 57, text: '    backoff: "exponential",', spans: [{ text: '    backoff: ' }, { text: '"exponential"', token: 'string' }, { text: ',' }] },
      { id: 'add-d', kind: 'add', newNumber: 58, text: '  });' },
      { id: 'end', kind: 'context', oldNumber: 56, newNumber: 59, text: '}' },
    ] }] };
  }
}
