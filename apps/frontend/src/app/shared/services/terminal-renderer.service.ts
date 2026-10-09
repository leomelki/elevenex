import { Injectable, OnDestroy } from '@angular/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Observable, Subscription } from 'rxjs';
import { Router } from '@angular/router';
import { TabService } from '@/features/session/tab-service';
import { TerminalWebsocketService } from './terminal-websocket.service';
import { getBackendOrigin } from '@/shared/runtime/runtime-config';
import {
  UserTerminalConnectionState,
  UserTerminalWebsocketService,
} from '@/shared/services/user-terminal-websocket.service';

type TerminalKind = 'user' | 'agent';

export interface TerminalRenderer {
  kind: TerminalKind;
  terminalId: number;
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement;
  state$: Observable<UserTerminalConnectionState>;
  subscriptions: Subscription[];
  attached: boolean;
}

/** Owns the renderer and socket independently of the panel's lifetime. */
@Injectable({ providedIn: 'root' })
export class TerminalRendererService implements OnDestroy {
  private static readonly MAX_IDLE_SESSIONS = 8;
  private readonly sessions = new Map<string, TerminalRenderer>();
  private backendOrigin = getBackendOrigin();

  constructor(
    private readonly userWsService: UserTerminalWebsocketService,
    private readonly agentWsService: TerminalWebsocketService,
    private readonly tabService: TabService,
    private readonly router: Router,
  ) {}

  attach(
    kind: TerminalKind,
    terminalId: number,
    container: HTMLElement,
    visible = true,
  ): TerminalRenderer {
    // Terminal ids are backend-local. Never reuse a renderer from another host.
    const origin = getBackendOrigin();
    if (origin !== this.backendOrigin) {
      this.ngOnDestroy();
      this.backendOrigin = origin;
    }

    const key = `${kind}:${terminalId}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = this.createSession(kind, terminalId, container);
      this.sessions.set(key, session);
    } else {
      container.appendChild(session.element);
    }
    session.attached = true;
    this.setVisible(session, visible);
    return session;
  }

  setVisible(session: TerminalRenderer, visible: boolean): void {
    if (this.sessions.get(`${session.kind}:${session.terminalId}`) !== session) return;
    session.terminal.options.cursorBlink = visible;
    this.transport(session.kind).setRetryActive(session.terminalId, visible);
  }

  private transport(kind: TerminalKind) {
    return kind === 'user' ? this.userWsService : this.agentWsService;
  }

  release(session: TerminalRenderer): void {
    const key = `${session.kind}:${session.terminalId}`;
    if (this.sessions.get(key) !== session) return;
    session.attached = false;
    session.element.remove();
    // Keep healthy sockets receiving output; stop retrying hidden terminals.
    this.setVisible(session, false);
    this.sessions.delete(key);
    this.sessions.set(key, session);

    const idle = [...this.sessions.values()].filter((entry) => !entry.attached);
    for (const entry of idle.slice(
      0,
      Math.max(0, idle.length - TerminalRendererService.MAX_IDLE_SESSIONS),
    )) {
      this.remove(entry.kind, entry.terminalId);
    }
  }

  remove(kind: TerminalKind, terminalId: number): void {
    const key = `${kind}:${terminalId}`;
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    session.subscriptions.forEach((subscription) => subscription.unsubscribe());
    this.transport(kind).disconnect(terminalId);
    session.terminal.dispose();
    session.element.remove();
  }

  private createSession(
    kind: TerminalKind,
    terminalId: number,
    container: HTMLElement,
  ): TerminalRenderer {
    // Start the handshake before constructing and measuring the renderer.
    const wsService = this.transport(kind);
    const connection = wsService.connect(terminalId);
    const element = document.createElement('div');
    element.className = 'h-full w-full';
    container.appendChild(element);
    const terminal = new Terminal({
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
      // Local PTYs rely on xterm for history; remote tmux handles its own copy-mode.
      scrollback: kind === 'user' ? 10000 : 0,
      scrollSensitivity: 5,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    terminal.open(element);

    // Handle OSC 52 clipboard: tmux sends copied text via this escape sequence
    terminal.parser.registerOscHandler(52, (data) => {
      const idx = data.indexOf(';');
      const payload = idx !== -1 ? data.slice(idx + 1) : data;
      if (payload && payload !== '?') {
        try {
          navigator.clipboard.writeText(atob(payload));
        } catch {
          /* ignore decode errors */
        }
      }
      return true;
    });

    // Match native terminal clipboard shortcuts across platforms.
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
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
      const isSelectAll =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyA') ||
        (event.metaKey && event.code === 'KeyA');
      if (isSelectAll) {
        terminal?.selectAll();
        return false;
      }
      const isCopy =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyC') ||
        (event.metaKey && event.code === 'KeyC');
      if (isCopy) {
        const selection = terminal?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection);
        }
        return false;
      }
      // Ctrl+Shift+V: manual paste (no native accelerator for this combo)
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
        navigator.clipboard.readText().then((text) => {
          if (text) terminal?.paste(text);
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

    terminal.onData((data) => wsService.send(terminalId, data));
    terminal.onResize(({ cols, rows }) => wsService.resize(terminalId, cols, rows));
    const subscriptions = [
      connection.onData$.subscribe((data) => terminal.write(data)),
      connection.onOpen$.subscribe(() =>
        wsService.resize(terminalId, terminal.cols, terminal.rows),
      ),
    ];
    return {
      kind,
      terminalId,
      terminal,
      fitAddon,
      element,
      state$: connection.state$,
      subscriptions,
      attached: true,
    };
  }

  ngOnDestroy(): void {
    for (const session of this.sessions.values()) this.remove(session.kind, session.terminalId);
  }
}
