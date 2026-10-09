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
import { TerminalConnectionPhase } from '../../../shared/services/terminal-websocket.service';
import { Subscription } from 'rxjs';
import {
  TerminalRenderer,
  TerminalRendererService,
} from '@/shared/services/terminal-renderer.service';

@Component({
  selector: 'app-claude-terminal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './claude-terminal.component.html',
  styleUrls: ['./claude-terminal.component.scss'],
})
export class ClaudeTerminalComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) sessionId!: number;
  @Input() isVisible = false;
  @ViewChild('terminalContainer', { static: true }) container!: ElementRef;

  private session?: TerminalRenderer;
  private resizeObserver?: ResizeObserver;
  private subscriptions: Subscription[] = [];
  private socketInitialized = false;

  connectionPhase = signal<TerminalConnectionPhase>('connecting');
  retryMsUntilNext = signal<number | null>(null);
  retryActive = signal(false);
  connected = computed(() => this.connectionPhase() === 'connected');
  connecting = computed(() => {
    const phase = this.connectionPhase();
    return phase === 'connecting' || phase === 'reconnecting';
  });
  retryLabel = computed(() => {
    const remainingMs = this.retryMsUntilNext();
    if (remainingMs === null) {
      return null;
    }

    const roundedTenths = Math.ceil(remainingMs / 100) / 10;
    return Number.isInteger(roundedTenths)
      ? `${roundedTenths.toFixed(0)}s`
      : `${roundedTenths.toFixed(1)}s`;
  });

  constructor(private readonly rendererService: TerminalRendererService) {}

  ngAfterViewInit(): void {
    this.connectWebSocket();
    this.setupResizeObserver();
    this.socketInitialized = true;
    this.syncRetryVisibility();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && this.socketInitialized) {
      this.syncRetryVisibility();
    }
    if (changes['sessionId'] && !changes['sessionId'].firstChange && this.socketInitialized) {
      this.disconnectWebSocket();
      this.connectWebSocket();
      this.syncRetryVisibility();
    }
  }

  private connectWebSocket(): void {
    this.session = this.rendererService.attach(
      'agent',
      this.sessionId,
      this.container.nativeElement,
      this.isVisible,
    );
    this.subscriptions.push(
      this.session.state$.subscribe((state) => {
        this.connectionPhase.set(state.phase);
        this.retryMsUntilNext.set(state.msUntilNextRetry);
        this.retryActive.set(state.retryActive);
        if (state.phase === 'connected') this.fit();
      }),
    );
    this.fit();
    setTimeout(() => this.fit(), 0);
    document.fonts?.ready.then(() => this.fit());
  }

  private disconnectWebSocket(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
    this.subscriptions = [];
    if (this.session) this.rendererService.release(this.session);
    this.session = undefined;
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
      this.session?.fitAddon.fit();
    } catch {
      // Can fail if terminal not visible
    }
  }

  focus(): void {
    this.session?.terminal.focus();
  }

  private syncRetryVisibility(): void {
    if (this.session) this.rendererService.setVisible(this.session, this.isVisible);
  }

  ngOnDestroy(): void {
    // Clean up in correct order
    this.resizeObserver?.disconnect();
    this.disconnectWebSocket();
  }
}
