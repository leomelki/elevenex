import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  output,
  SimpleChanges,
  ViewChild,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ActionStatus } from '@/shared/models/action.model';
import { ActionTerminalWebsocketService } from '@/shared/services/action-terminal-websocket.service';

@Component({
  selector: 'app-action-terminal-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './action-terminal-view.component.html',
  host: { class: 'block h-full' },
})
export class ActionTerminalViewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) actionId!: number;
  @Input() initialOutput = '';
  @ViewChild('terminalContainer', { static: true }) container!: ElementRef<HTMLDivElement>;
  statusChange = output<ActionStatus>();

  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private resizeObserver?: ResizeObserver;
  private subscriptions: Subscription[] = [];
  private initialized = false;
  private connectedActionId: number | null = null;

  connected = signal(false);
  status = signal<ActionStatus>('idle');

  constructor(private readonly wsService: ActionTerminalWebsocketService) {}

  ngAfterViewInit(): void {
    this.initTerminal();
    this.renderInitialOutput();
    this.connect();
    this.setupResizeObserver();
    this.initialized = true;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized) return;

    if (changes['actionId'] && !changes['actionId'].firstChange) {
      this.disconnect();
      this.terminal?.reset();
      this.renderInitialOutput();
      this.connect();
    } else if (changes['initialOutput'] && !changes['initialOutput'].firstChange) {
      // Output refreshed without action change (e.g. parent reloaded action data after run)
      if (this.status() !== 'running') {
        this.terminal?.reset();
        this.renderInitialOutput();
      }
    }
  }

  private initTerminal(): void {
    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: false,
      disableStdin: true,
      scrollback: 2000,
      allowProposedApi: true,
      theme: {
        background: '#0f1720',
        foreground: '#d5deeb',
        cursor: '#6ee7b7',
        selectionBackground: '#1d4ed833',
        black: '#0f1720',
        red: '#fb7185',
        green: '#34d399',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#d5deeb',
        brightBlack: '#334155',
        brightRed: '#fda4af',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.open(this.container.nativeElement);
    setTimeout(() => this.fit(), 0);
  }

  private renderInitialOutput(): void {
    if (this.initialOutput) {
      this.terminal?.write(this.initialOutput);
    }
  }

  private connect(): void {
    this.connectedActionId = this.actionId;
    const connection = this.wsService.connect(this.actionId);
    this.subscriptions.push(
      connection.onOpen$.subscribe(() => {
        this.connected.set(true);
        this.fit();
      }),
      connection.onData$.subscribe((data) => {
        this.terminal?.write(data);
      }),
      connection.onStatus$.subscribe((status) => {
        if (status === 'running') {
          this.terminal?.reset();
        }
        this.status.set(status);
        this.statusChange.emit(status);
      }),
      connection.onClose$.subscribe(() => {
        this.connected.set(false);
      }),
      connection.onError$.subscribe(() => {
        this.connected.set(false);
      }),
    );
  }

  fit(): void {
    try {
      const el = this.container?.nativeElement;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      this.fitAddon?.fit();
    } catch {
      // Hidden panel resize can fail transiently.
    }
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.container.nativeElement);
  }

  private disconnect(): void {
    this.subscriptions.forEach(subscription => subscription.unsubscribe());
    this.subscriptions = [];
    if (this.connectedActionId !== null) {
      this.wsService.disconnect(this.connectedActionId);
    }
    this.connectedActionId = null;
  }

  ngOnDestroy(): void {
    this.disconnect();
    this.resizeObserver?.disconnect();
    this.terminal?.dispose();
  }
}
