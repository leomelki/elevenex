import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRefreshCw, lucideTriangleAlert } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import type {
  DiffSelectionMention,
  DiffSelectionMentionScope,
} from '@/shared/models/diff-selection-mention.model';
import {
  PREVIEW_BRIDGE_CHANNEL,
  PREVIEW_BRIDGE_VERSION,
  isPreviewMessage,
  type PreviewAnchorHighlight,
  type PreviewInboundEnvelope,
  type PreviewOutboundMessage,
  type PreviewSourceRef,
  type PreviewTheme,
} from '@/shared/models/review-preview-bridge.model';
import { FilesService } from '@/shared/services/files.service';
import { ReviewPreviewService } from '@/shared/services/review-preview.service';
import { placeSelectionMenu } from '@/shared/utils/selection-menu-position';
import {
  DEFAULT_DIFF_SELECTION_ACTIONS,
  DiffSelectionMenuComponent,
  type DiffSelectionMenuAction,
} from '@/features/change-review/diff-selection-menu.component';
import { buildHtmlSelectionMention } from './review-html-selection';
import { splitSourceLines } from './review-source-context';

interface SelectionMenuState {
  top: number;
  left: number;
  mentions: DiffSelectionMention[];
}

/**
 * How long to wait after the frame loads for the bridge to announce itself.
 * Past this, assume the page navigated somewhere that is not a preview.
 */
const READY_WATCHDOG_MS = 1500;

/**
 * The rendered view of an HTML file in the worktree.
 *
 * The page runs in a frame served by the backend's preview route, which mirrors
 * the worktree layout so the file's own stylesheets, scripts, images and links
 * load exactly as they would on disk. It is sandboxed without
 * `allow-same-origin` and served under a content policy confined to its own
 * URL prefix, because it is running the reviewed repository's JavaScript next
 * to an API that has no authentication.
 *
 * Everything the frame reports — selections, scrolling, link clicks — arrives
 * over postMessage rather than by reaching into it, which is what makes the
 * same component shape work later for a preview we do not serve ourselves.
 */
@Component({
  selector: 'app-review-html-preview',
  standalone: true,
  imports: [CommonModule, NgIcon, DiffSelectionMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideRefreshCw, lucideTriangleAlert })],
  templateUrl: './review-html-preview.component.html',
  styleUrl: './review-html-preview.component.scss',
})
export class ReviewHtmlPreviewComponent {
  readonly worktreePath = input.required<string>();
  readonly path = input.required<string>();
  /** Scroll offset to restore when this tab is re-focused. */
  readonly restoreScrollTop = input(0);
  readonly scope = input<DiffSelectionMentionScope>('branch');
  readonly changeHash = input<string | null>(null);
  readonly selectionActions = input<readonly DiffSelectionMenuAction[]>(
    DEFAULT_DIFF_SELECTION_ACTIONS,
  );
  /** Open discussions anchored in this file, painted over the page. */
  readonly anchors = input<readonly PreviewAnchorHighlight[]>([]);

  readonly scrolled = output<number>();
  readonly selectionAction = output<{
    id: string;
    mentions: DiffSelectionMention[];
  }>();
  /** A link to another file in the worktree was clicked inside the frame. */
  readonly openPath = output<string>();
  readonly anchorActivated = output<number>();

  private readonly files = inject(FilesService);
  private readonly preview = inject(ReviewPreviewService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly frameRef = viewChild<ElementRef<HTMLIFrameElement>>('frameRef');
  private readonly frameWrap = viewChild<ElementRef<HTMLElement>>('frameWrap');

  /**
   * Trusted because we built it: it is our own backend route under a preview
   * id we just created. The frame's sandbox and content policy are what
   * contain what it loads, not this.
   */
  readonly frameUrl = signal<SafeResourceUrl | null>(null);
  private rawFrameUrl: string | null = null;
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly selectionMenu = signal<SelectionMenuState | null>(null);

  private previewId = '';
  /** The file the frame is actually showing; changes if the user follows a link. */
  private currentPath = '';
  /** HTML source lines, for the context rows a mention carries. */
  private sourceLines: readonly string[] | null = null;
  private readyWatchdog: ReturnType<typeof setTimeout> | null = null;
  private sawReady = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    const onMessage = (event: MessageEvent) => this.onFrameMessage(event);
    window.addEventListener('message', onMessage);
    destroyRef.onDestroy(() => {
      window.removeEventListener('message', onMessage);
      if (this.readyWatchdog) clearTimeout(this.readyWatchdog);
    });

    effect(() => {
      const worktreePath = this.worktreePath();
      const path = this.path();
      untracked(() => {
        this.selectionMenu.set(null);
        void this.load(worktreePath, path);
      });
    });

    // Anchors can change while the frame is up (a discussion is created or
    // resolved), so push them rather than only sending them at handshake.
    effect(() => {
      const anchors = this.anchors();
      untracked(() => {
        if (this.sawReady) this.post({ type: 'highlight', anchors });
      });
    });
  }

  /** Re-read the page from disk; the frame has no same-origin reload we can call. */
  refresh(): void {
    const url = this.rawFrameUrl;
    if (!url) return;
    this.sawReady = false;
    this.loading.set(true);
    // A cache buster despite no-store: re-assigning an identical src is a
    // no-op in some browsers, and location.reload() is unavailable to us
    // across the sandbox boundary.
    this.setFrameUrl(`${url.split('?')[0]}?r=${Date.now()}`);
    void this.loadSource(this.worktreePath(), this.currentPath || this.path());
  }

  private setFrameUrl(url: string | null): void {
    this.rawFrameUrl = url;
    this.frameUrl.set(url ? this.sanitizer.bypassSecurityTrustResourceUrl(url) : null);
  }

  /** The frame fired `load`; start waiting for the bridge to say hello. */
  onFrameLoad(): void {
    if (this.readyWatchdog) clearTimeout(this.readyWatchdog);
    this.readyWatchdog = setTimeout(() => {
      if (this.sawReady) return;
      // A sandbox without allow-top-navigation still lets the frame navigate
      // *itself*, and no CSP directive closes that. We cannot prevent the
      // request, but we can refuse to keep showing whatever it went to.
      const url = this.rawFrameUrl;
      this.setFrameUrl(null);
      if (url) queueMicrotask(() => this.setFrameUrl(url));
      toast.warning('The preview navigated away and was reset');
    }, READY_WATCHDOG_MS);
  }

  onSelectionMenuAction(event: { id: string; mentions: DiffSelectionMention[] }): void {
    this.selectionAction.emit(event);
    this.selectionMenu.set(null);
    this.post({ type: 'clear-selection' });
  }

  private async load(worktreePath: string, path: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.sawReady = false;
    this.currentPath = path;

    try {
      const [previewId, url] = await Promise.all([
        this.preview.previewId(worktreePath),
        this.preview.previewUrl(worktreePath, path),
      ]);
      if (this.path() !== path) return;
      this.previewId = previewId;
      this.setFrameUrl(url);
    } catch {
      if (this.path() === path) {
        this.error.set('Could not open a preview for this file.');
        this.loading.set(false);
      }
      return;
    }

    await this.loadSource(worktreePath, path);
  }

  /**
   * Read the file's own text alongside the frame.
   *
   * The bridge reports line numbers but not the lines themselves, and a
   * mention carries surrounding context — so the source is fetched here rather
   * than round-tripped through the frame, which would mean trusting content
   * the page could have rewritten.
   */
  private async loadSource(worktreePath: string, path: string): Promise<void> {
    try {
      const file = await firstValueFrom(this.files.readFile(worktreePath, path));
      if (this.currentPath !== path) return;
      this.sourceLines = splitSourceLines(file.content);
    } catch {
      // Not fatal: the preview still renders and selections still work, they
      // just carry no surrounding context.
      if (this.currentPath === path) this.sourceLines = null;
    }
  }

  private onFrameMessage(event: MessageEvent): void {
    const frame = this.frameRef()?.nativeElement ?? null;
    if (!isPreviewMessage(event, frame, this.previewId)) return;
    const message: PreviewInboundEnvelope = event.data;

    switch (message.type) {
      case 'ready':
        this.sawReady = true;
        if (this.readyWatchdog) clearTimeout(this.readyWatchdog);
        this.loading.set(false);
        this.error.set(null);
        // A link followed inside the frame changes which file we are anchoring
        // to; adopt it so mentions name the right one.
        if (message.path && message.path !== this.currentPath) {
          this.currentPath = message.path;
          void this.loadSource(this.worktreePath(), message.path);
        }
        this.post({ type: 'init', features: ['selection', 'navigate', 'scroll'], theme: this.theme() });
        this.post({ type: 'highlight', anchors: this.anchors() });
        this.post({ type: 'scroll-to', top: this.restoreScrollTop() });
        break;

      case 'selection-changed':
        this.onSelectionChanged(message.text, message.rect, message.source);
        break;

      case 'selection-cleared':
        this.selectionMenu.set(null);
        break;

      case 'scroll':
        this.selectionMenu.set(null);
        this.scrolled.emit(message.top);
        break;

      case 'navigate':
        if (message.external || !message.path) {
          toast.info('External links are disabled in the preview');
          return;
        }
        this.openPath.emit(message.path);
        break;

      case 'anchor-click':
        this.anchorActivated.emit(message.chatId);
        break;

      case 'error':
        this.error.set(message.message);
        break;
    }
  }

  private onSelectionChanged(
    text: string,
    rect: { top: number; left: number },
    source: PreviewSourceRef | null,
  ): void {
    const mention = buildHtmlSelectionMention({
      filePath: this.currentPath || this.path(),
      scope: this.scope(),
      changeHash: this.changeHash(),
      sourceLines: this.sourceLines,
      selectedText: text,
      source,
    });
    if (!mention) {
      this.selectionMenu.set(null);
      return;
    }

    const frame = this.frameRef()?.nativeElement;
    const container = this.frameWrap()?.nativeElement;
    if (!frame || !container) return;

    // The rect is in the frame's own viewport coordinates, already net of its
    // internal scrolling — so offset by where the frame sits and pass no
    // scroll of our own.
    const frameRect = frame.getBoundingClientRect();
    const placement = placeSelectionMenu(
      { top: frameRect.top + rect.top, left: frameRect.left + rect.left },
      container.getBoundingClientRect(),
      { top: 0, left: 0 },
    );
    this.selectionMenu.set({ ...placement, mentions: [mention] });
  }

  /** The frame cannot read our CSS variables, so resolve them and send them. */
  private theme(): PreviewTheme {
    const styles = getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue('--primary').trim() || 'oklch(0.6 0.15 265)';
    return {
      anchor: `color-mix(in oklab, ${primary} 20%, transparent)`,
      anchorBorder: `color-mix(in oklab, ${primary} 70%, transparent)`,
    };
  }

  private post(message: PreviewOutboundMessage): void {
    const frame = this.frameRef()?.nativeElement;
    if (!frame?.contentWindow || !this.previewId) return;
    // '*' is required, not lax: the frame has an opaque origin, which matches
    // no concrete target origin, so anything else is silently dropped. Safe
    // because only a holder of the preview id could be listening.
    frame.contentWindow.postMessage(
      { ex: PREVIEW_BRIDGE_CHANNEL, v: PREVIEW_BRIDGE_VERSION, previewId: this.previewId, ...message },
      '*',
    );
  }
}
