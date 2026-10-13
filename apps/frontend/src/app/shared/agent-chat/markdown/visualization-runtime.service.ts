import { DestroyRef, Injectable, inject } from '@angular/core';
import {
  isPreviewMessage,
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  type PreviewInboundEnvelope,
  type PreviewTheme,
} from '@/shared/models/review-preview-bridge.model';
import { ReviewPreviewService } from '@/shared/services/review-preview.service';

const THEME_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'border',
  'input',
  'ring',
  'destructive',
  'success',
  'warning',
  'surface-tint',
  'surface-shade',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
];
const KEEPALIVE_MS = 30 * 60 * 1000;

interface RegisteredFrame {
  frame: HTMLIFrameElement;
  previewId: string;
  ready: boolean;
  receive: (message: PreviewInboundEnvelope) => void;
  expired: () => void;
}

/** Shared observers and O(1) message routing for long transcripts. */
@Injectable({ providedIn: 'root' })
export class VisualizationRuntimeService {
  private readonly preview = inject(ReviewPreviewService);
  private readonly frames = new Map<MessageEventSource, RegisteredFrame>();
  private readonly waiting = new Map<Element, () => void>();
  private visibilityObserver: IntersectionObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  private theme: PreviewTheme | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatPending = false;

  private readonly receive = (event: MessageEvent) => {
    const entry = event.source ? this.frames.get(event.source) : undefined;
    if (entry && isPreviewMessage(event, entry.frame, entry.previewId)) {
      entry.receive(event.data);
    }
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.waiting.clear();
      this.frames.clear();
      this.visibilityObserver?.disconnect();
      this.stopListening();
    });
  }

  whenVisible(element: Element, callback: () => void): () => void {
    if (typeof IntersectionObserver === 'undefined') {
      callback();
      return () => {};
    }
    if (!this.visibilityObserver) {
      this.visibilityObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const notify = this.waiting.get(entry.target);
            if (!notify) continue;
            this.unobserve(entry.target);
            notify();
          }
        },
        { rootMargin: '600px' },
      );
    }
    this.waiting.set(element, callback);
    this.visibilityObserver.observe(element);
    return () => this.unobserve(element);
  }

  register(
    frame: HTMLIFrameElement,
    previewId: string,
    receive: RegisteredFrame['receive'],
    expired: () => void,
  ): () => void {
    const source = frame.contentWindow;
    if (!source) return () => {};
    const entry: RegisteredFrame = { frame, previewId, ready: false, receive, expired };
    if (!this.frames.size) this.startListening();
    this.frames.set(source, entry);
    return () => {
      if (this.frames.get(source) !== entry) return;
      this.frames.delete(source);
      if (!this.frames.size) this.stopListening();
    };
  }

  initialize(frame: HTMLIFrameElement): void {
    const entry = frame.contentWindow ? this.frames.get(frame.contentWindow) : undefined;
    if (!entry) return;
    entry.ready = true;
    this.sendTheme(entry);
  }

  private unobserve(element: Element): void {
    if (!this.waiting.delete(element)) return;
    this.visibilityObserver?.unobserve(element);
    if (!this.waiting.size) {
      this.visibilityObserver?.disconnect();
      this.visibilityObserver = null;
    }
  }

  private startListening(): void {
    window.addEventListener('message', this.receive);
    this.themeObserver = new MutationObserver(() => {
      this.theme = null;
      for (const entry of this.frames.values()) {
        if (entry.ready) this.sendTheme(entry);
      }
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    this.heartbeat = setInterval(() => void this.keepalive(), KEEPALIVE_MS);
  }

  private stopListening(): void {
    window.removeEventListener('message', this.receive);
    this.themeObserver?.disconnect();
    this.themeObserver = null;
    this.theme = null;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private sendTheme(entry: RegisteredFrame): void {
    if (!this.theme) {
      const styles = getComputedStyle(document.documentElement);
      const variables: Record<string, string> = {};
      for (const token of THEME_TOKENS) {
        const value = styles.getPropertyValue(`--${token}`).trim();
        if (value) variables[`--${token}`] = value;
      }
      for (let index = 1; index <= 5; index++) {
        variables[`--viz-series-${index}`] = variables[`--chart-${index}`] || 'currentColor';
      }
      this.theme = {
        anchor: 'transparent',
        anchorBorder: 'transparent',
        variables,
        colorScheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      };
    }
    // Opaque sandbox origins require '*'; replies use frame identity + ID.
    entry.frame.contentWindow?.postMessage(
      {
        ex: PREVIEW_BRIDGE_CHANNEL,
        v: PREVIEW_BRIDGE_VERSION,
        previewId: entry.previewId,
        type: 'init',
        features: ['navigate'],
        theme: this.theme,
      },
      '*',
    );
  }

  private async keepalive(): Promise<void> {
    if (this.heartbeatPending || !this.frames.size) return;
    this.heartbeatPending = true;
    const entries = [...this.frames.values()];
    const ids = [...new Set(entries.map((entry) => entry.previewId))];
    try {
      const expired = new Set<string>();
      for (let index = 0; index < ids.length; index += 1024) {
        for (const id of await this.preview.keepalive(ids.slice(index, index + 1024))) {
          expired.add(id);
        }
      }
      for (const entry of entries) {
        const source = entry.frame.contentWindow;
        if (source && this.frames.get(source) === entry && expired.has(entry.previewId)) {
          entry.expired();
        }
      }
    } catch {
      // A temporary network failure must not reset functioning charts. Retry
      // on the next shared heartbeat; newly opened documents revalidate too.
    } finally {
      this.heartbeatPending = false;
    }
  }
}
