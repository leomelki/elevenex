import {
  Component,
  ElementRef,
  ViewChild,
  Input,
  OnDestroy,
  AfterViewInit,
  OnChanges,
  SimpleChanges,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  UserTerminalConnectionPhase,
  UserTerminalWebsocketService,
} from '@/shared/services/user-terminal-websocket.service';
import { Subscription } from 'rxjs';
import { TabService } from '@/features/session/tab-service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-user-terminal-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './user-terminal-view.component.html',
  styleUrls: ['./user-terminal-view.component.scss'],
})
export class UserTerminalViewComponent implements AfterViewInit, OnDestroy, OnChanges {
  @Input({ required: true }) terminalId!: number;
  @ViewChild('terminalContainer', { static: true }) container!: ElementRef;

  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private resizeObserver?: ResizeObserver;
  private subscriptions: Subscription[] = [];
  private initialized = false;

  connectionPhase = signal<UserTerminalConnectionPhase>('connecting');
  retryMsUntilNext = signal<number | null>(null);
  retryActive = signal(false);
  connected = computed(() => this.connectionPhase() === 'connected');
  connecting = computed(() => {
    const phase = this.connectionPhase();
    return phase === 'connecting' || phase === 'reconnecting';
  });
  retryLabel = computed(() => {
    const remainingMs = this.retryMsUntilNext();
    if (remainingMs === null) return null;
    const roundedTenths = Math.ceil(remainingMs / 100) / 10;
    return Number.isInteger(roundedTenths)
      ? `${roundedTenths.toFixed(0)}s`
      : `${roundedTenths.toFixed(1)}s`;
  });

  constructor(
    private readonly wsService: UserTerminalWebsocketService,
    private readonly tabService: TabService,
    private readonly router: Router,
  ) {}

  ngAfterViewInit(): void {
    this.initTerminal();
    this.connectWebSocket();
    this.setupResizeObserver();
    this.initialized = true;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['terminalId'] && !changes['terminalId'].firstChange && this.initialized) {
      this.disconnectWebSocket();
      this.connectWebSocket();
    }
  }

  private initTerminal(): void {
    this.terminal = new Terminal({
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        cursorAccent: '#1a1b26',
        selectionBackground: '#364a82',
        selectionForeground: '#c0caf5',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
      scrollback: 0,
      scrollSensitivity: 5,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    this.terminal.open(this.container.nativeElement);

    // Handle OSC 52 clipboard: tmux sends copied text via this escape sequence
    this.terminal.parser.registerOscHandler(52, (data) => {
      const idx = data.indexOf(';');
      const payload = idx !== -1 ? data.slice(idx + 1) : data;
      if (payload && payload !== '?') {
        try {
          navigator.clipboard.writeText(atob(payload));
        } catch { /* ignore decode errors */ }
      }
      return true;
    });

    // Match native terminal clipboard shortcuts across platforms.
    this.terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Tab') {
        const nextSessionId = event.shiftKey
          ? this.tabService.selectPreviousTab()
          : this.tabService.selectNextTab();
        if (nextSessionId) {
          event.preventDefault();
          void this.router.navigate(['/sessions', nextSessionId], { replaceUrl: true });
        }
        return false;
      }
      const isSelectAll = (event.ctrlKey && event.shiftKey && event.code === 'KeyA')
        || (event.metaKey && event.code === 'KeyA');
      if (isSelectAll) {
        this.terminal?.selectAll();
        return false;
      }
      const isCopy = (event.ctrlKey && event.shiftKey && event.code === 'KeyC')
        || (event.metaKey && event.code === 'KeyC');
      if (isCopy) {
        const selection = this.terminal?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }
      // Ctrl+Shift+V: manual paste (no native accelerator for this combo)
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
        navigator.clipboard.readText().then(text => {
          if (text) this.terminal?.paste(text);
        });
        return false;
      }
      // Cmd+V / Ctrl+V: let the native paste event handle it (Electron menu
      // role or browser default). Returning false prevents xterm from treating
      // the key as terminal input; the native paste event still fires.
      if ((event.metaKey || event.ctrlKey) && event.code === 'KeyV') {
        return false;
      }
      return true;
    });

    setTimeout(() => this.fit(), 0);
    document.fonts?.ready.then(() => this.fit());

    this.terminal.onData((data) => {
      if (this.connected()) {
        this.wsService.send(this.terminalId, data);
      }
    });

    this.terminal.onResize(({ cols, rows }) => {
      if (this.connected()) {
        this.wsService.resize(this.terminalId, cols, rows);
      }
    });
  }

  private connectWebSocket(): void {
    const connection = this.wsService.connect(this.terminalId);

    this.subscriptions.push(
      connection.state$.subscribe({
        next: (state) => {
          this.connectionPhase.set(state.phase);
          this.retryMsUntilNext.set(state.msUntilNextRetry);
          this.retryActive.set(state.retryActive);
          if (state.phase === 'connected') {
            this.fit();
          }
        },
      }),
    );

    this.subscriptions.push(
      connection.onOpen$.subscribe({
        next: () => {
          if (this.terminal) {
            this.wsService.resize(this.terminalId, this.terminal.cols, this.terminal.rows);
          }
        },
      }),
    );

    this.subscriptions.push(
      connection.onData$.subscribe({
        next: (data) => {
          this.terminal?.write(data);
        },
      }),
    );

    this.subscriptions.push(
      connection.onError$.subscribe({
        next: (error) => {
          console.error('User terminal WebSocket error:', error);
        },
      }),
    );
  }

  private disconnectWebSocket(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
    this.wsService.disconnect(this.terminalId);
    this.connectionPhase.set('disconnected');
    this.retryMsUntilNext.set(null);
    this.retryActive.set(false);
  }

  private setupResizeObserver(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.resizeObserver.observe(this.container.nativeElement);
  }

  fit(): void {
    try {
      const el = this.container?.nativeElement;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      this.fitAddon?.fit();
    } catch {
      // Can fail if terminal not visible
    }
  }

  focus(): void {
    this.terminal?.focus();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.disconnectWebSocket();
    this.terminal?.dispose();
    this.terminal = undefined;
  }
}
