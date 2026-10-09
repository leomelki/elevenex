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
import { UserTerminalConnectionPhase } from '@/shared/services/user-terminal-websocket.service';
import { Subscription } from 'rxjs';
import {
  TerminalRenderer,
  TerminalRendererService,
} from '@/shared/services/terminal-renderer.service';

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

  private session?: TerminalRenderer;
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

  constructor(private readonly sessionService: TerminalRendererService) {}

  ngAfterViewInit(): void {
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

  private connectWebSocket(): void {
    this.session = this.sessionService.attach(
      'user',
      this.terminalId,
      this.container.nativeElement,
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
    if (this.session) this.sessionService.release(this.session);
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

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.disconnectWebSocket();
  }
}
