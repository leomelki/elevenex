import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  PendingTasks,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { ZardButtonComponent } from '@/shared/components/button/button.component';
import {
  previewAssetUrl,
  ReviewPreviewService,
  type PreviewSessionDescriptor,
} from '@/shared/services/review-preview.service';
import {
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  type PreviewInboundEnvelope,
} from '@/shared/models/review-preview-bridge.model';
import {
  resolveVisualizationNavigation,
  resolveVisualizationTarget,
} from './markdown-visualization';
import { VisualizationRuntimeService } from './visualization-runtime.service';

const LOAD_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 1500;

interface NavigationTarget {
  targetKey: string;
  path: string;
  search: string;
  hash: string;
}

/** Local HTML runs only under the preview capability's CSP and opaque sandbox. */
@Component({
  selector: 'agent-visualization',
  imports: [ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'my-2 block overflow-hidden rounded-lg border border-border bg-card text-card-foreground',
  },
  templateUrl: './agent-visualization.component.html',
})
export class AgentVisualizationComponent {
  readonly path = input.required<string>();
  readonly worktreePath = input<string | null>(null);
  readonly sourcePath = input<string | null>(null);
  private readonly frameUrl = signal<SafeResourceUrl | null>(null);
  // A real navigation creates a new window. Late messages from the previous
  // document cannot authenticate; surrounding streamed text keeps this key.
  protected readonly frames = computed(() => {
    const url = this.frameUrl();
    return url ? [url] : [];
  });
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  protected readonly title = signal('Interactive visualization');
  protected readonly height = signal(320);
  private readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  private readonly preview = inject(ReviewPreviewService);
  private readonly runtime = inject(VisualizationRuntimeService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly pendingTasks = inject(PendingTasks);
  private readonly visible = signal(false);
  private readonly session = signal<PreviewSessionDescriptor | null>(null);
  private readonly navigation = signal<NavigationTarget | null>(null);
  private readonly revision = signal(0);
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const stopObserving = this.runtime.whenVisible(host.nativeElement, () =>
      this.visible.set(true),
    );
    inject(DestroyRef).onDestroy(() => {
      stopObserving();
      this.clearTimers();
    });

    effect((onCleanup) => {
      const frame = this.frame()?.nativeElement;
      const session = this.session();
      if (!frame || !session) return;
      onCleanup(
        this.runtime.register(
          frame,
          session.previewId,
          (message) => this.onMessage(message),
          () => this.revision.update((value) => value + 1),
        ),
      );
    });

    effect((onCleanup) => {
      if (!this.visible()) return;
      const target = this.target();
      const navigation = this.navigation();
      const revision = this.revision();
      let cancelled = false;
      let finishPending = () => {};
      onCleanup(() => {
        cancelled = true;
        finishPending();
        this.clearTimers();
      });
      untracked(() => {
        this.frameUrl.set(null);
        this.session.set(null);
        this.loading.set(true);
        this.error.set(null);
        this.notice.set(null);
        this.height.set(320);
        this.title.set('Interactive visualization');
        if (!target) {
          this.fail(
            'This visualization needs a local HTML file and a checkout for relative paths.',
          );
          return;
        }
        const removePending = this.pendingTasks.add();
        let pending = true;
        finishPending = () => {
          if (!pending) return;
          pending = false;
          removePending();
        };
        // Start before any async work, including the document request. Native
        // iframe lazy loading is unnecessary after our viewport observer fires.
        this.loadTimer = setTimeout(() => {
          cancelled = true;
          finishPending();
          this.fail('Visualization took too long to load. Retry to reopen it.');
        }, LOAD_TIMEOUT_MS);
        void this.preview
          .session(target.root, true, true)
          .then((session) => {
            if (cancelled) return;
            const local =
              navigation?.targetKey === `${target.root}/${target.path}` ? navigation : null;
            const url = new URL(previewAssetUrl(session, local?.path ?? target.path));
            if (local) {
              url.search = local.search;
              url.hash = local.hash;
            }
            url.searchParams.set('r', String(revision));
            this.session.set(session);
            this.frameUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(url.href));
          })
          .catch(() => {
            if (!cancelled) {
              this.fail('Visualization unavailable. The file may have moved or been deleted.');
            }
          })
          .finally(finishPending);
      });
    });
  }

  protected retry(): void {
    // Reload restores the original artifact after following a local link.
    this.navigation.set(null);
    this.revision.update((value) => value + 1);
  }

  protected onFrameLoad(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      this.fail('Visualization unavailable or navigated away. Retry to reopen it.');
    }, READY_TIMEOUT_MS);
    this.frame()?.nativeElement.contentWindow?.postMessage(
      {
        ex: PREVIEW_BRIDGE_CHANNEL,
        v: PREVIEW_BRIDGE_VERSION,
        previewId: this.session()?.previewId,
        type: 'probe',
      },
      '*',
    );
  }

  private onMessage(message: PreviewInboundEnvelope): void {
    switch (message.type) {
      case 'ready': {
        this.clearTimers();
        this.loading.set(false);
        // Ready authenticates the bridge, not its resources. Preserve errors
        // reported before DOMContentLoaded or the load/probe handshake.
        if (typeof message.title === 'string' && message.title) this.title.set(message.title);
        this.resize(message.contentHeight);
        const frame = this.frame()?.nativeElement;
        if (frame) this.runtime.initialize(frame);
        break;
      }
      case 'resize':
        this.resize(message.contentHeight);
        break;
      case 'navigate': {
        const session = this.session();
        const target = this.target();
        const link =
          session && typeof message.href === 'string'
            ? resolveVisualizationNavigation(message.href, session.urlPrefix)
            : null;
        if (!target || !link) {
          this.notice.set('Only local HTML links can open inside this visualization.');
          return;
        }
        this.navigation.set({ targetKey: `${target.root}/${target.path}`, ...link });
        break;
      }
      case 'error':
        this.loading.set(false);
        this.error.set('Part of this visualization could not load. Reload to try again.');
        break;
    }
  }

  private target() {
    return resolveVisualizationTarget(this.path(), this.worktreePath(), this.sourcePath());
  }

  private resize(height: number): void {
    if (typeof height === 'number' && Number.isFinite(height)) {
      this.height.set(Math.max(160, Math.min(1200, Math.ceil(height))));
    }
  }

  private fail(message: string): void {
    this.clearTimers();
    this.frameUrl.set(null);
    this.session.set(null);
    this.loading.set(false);
    this.error.set(message);
  }

  private clearTimers(): void {
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.loadTimer = null;
    this.readyTimer = null;
  }
}
