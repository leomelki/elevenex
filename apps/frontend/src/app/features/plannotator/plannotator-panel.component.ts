import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX, lucideRefreshCw, lucideCheckCircle, lucideXCircle, lucideFileText, lucideGitBranch, lucideArchive, lucideMinus, lucideMessageSquare, lucideMaximize2, lucideMinimize2 } from '@ng-icons/lucide';

@Component({
  selector: 'app-plannotator-panel',
  standalone: true,
  imports: [CommonModule, NgIcon],
  templateUrl: './plannotator-panel.component.html',
  styleUrls: ['./plannotator-panel.component.scss'],
  viewProviders: [
    provideIcons({
      lucideX,
      lucideRefreshCw,
      lucideCheckCircle,
      lucideXCircle,
      lucideFileText,
      lucideGitBranch,
      lucideArchive,
      lucideMinus,
      lucideMessageSquare,
      lucideMaximize2,
      lucideMinimize2,
    }),
  ],
})
export class PlannotatorPanelComponent implements OnInit, OnDestroy {
  private static readonly MIN_WIDTH = 600;
  private static readonly DEFAULT_WIDTH_RATIO = 0.7;
  private static readonly MAX_WIDTH_RATIO = 0.92;
  private static readonly STORAGE_KEY = 'plannotator-panel-width';

  @Input() sessionId!: number;
  @Input() proxyUrl!: string;
  @Input() mode: 'plan' | 'review' | 'annotate' | 'archive' = 'plan';
  @Input() minimized = false;

  @Output() close = new EventEmitter<void>();
  @Output() softClose = new EventEmitter<void>();
  @Output() minimize = new EventEmitter<void>();
  @Output() restore = new EventEmitter<void>();
  @Output() approve = new EventEmitter<void>();
  @Output() deny = new EventEmitter<void>();

  @ViewChild('plannotatorIframe') iframe!: ElementRef<HTMLIFrameElement>;

  private sanitizer = inject(DomSanitizer);

  panelWidth = signal(this.loadWidth());
  isFullscreen = signal(false);

  safeUrl: SafeResourceUrl | null = null;
  isLoading = true;
  isReady = false;

  private messageHandler = (event: MessageEvent) => {
    if (event.data === 'plannotator-close') {
      this.softClose.emit();
    }
  };

  ngOnInit(): void {
    window.addEventListener('message', this.messageHandler);
    this.updateSafeUrl();
  }

  private updateSafeUrl(): void {
    if (this.proxyUrl) {
      this.safeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.proxyUrl);
      this.isLoading = true;
      this.isReady = false;
    }
  }

  onIframeLoad(): void {
    this.isLoading = false;
    setTimeout(() => this.checkIframeReady(), 500);
  }

  private checkIframeReady(): void {
    try {
      if (this.iframe?.nativeElement) {
        const handleReady = (event: MessageEvent) => {
          if (event.data === 'plannotator-ready') {
            this.isReady = true;
            window.removeEventListener('message', handleReady);
          }
        };
        window.addEventListener('message', handleReady);

        setTimeout(() => {
          if (!this.isReady) {
            this.isReady = true;
          }
        }, 3000);
      }
    } catch {
      this.isReady = true;
    }
  }

  refresh(): void {
    if (this.iframe?.nativeElement) {
      this.isLoading = true;
      this.isReady = false;
      this.iframe.nativeElement.src = this.iframe.nativeElement.src;
    }
  }

  onClose(): void {
    this.close.emit();
  }

  getModeIcon(): string {
    switch (this.mode) {
      case 'plan':
        return 'lucideFileText';
      case 'review':
        return 'lucideGitBranch';
      case 'annotate':
        return 'lucideCheckCircle';
      case 'archive':
        return 'lucideArchive';
      default:
        return 'lucideFileText';
    }
  }

  getModeLabel(): string {
    switch (this.mode) {
      case 'plan':
        return 'Plan Review';
      case 'review':
        return 'Code Review';
      case 'annotate':
        return 'Annotation';
      case 'archive':
        return 'Archive';
      default:
        return 'Plannotator';
    }
  }

  toggleFullscreen(): void {
    this.isFullscreen.update(v => !v);
  }

  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.panelWidth();
    const maxWidth = window.innerWidth * PlannotatorPanelComponent.MAX_WIDTH_RATIO;
    const iframeEl = this.iframe?.nativeElement;

    // Block iframe from stealing mouse events during drag
    if (iframeEl) iframeEl.style.pointerEvents = 'none';

    const onMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      this.panelWidth.set(Math.min(maxWidth, Math.max(PlannotatorPanelComponent.MIN_WIDTH, startWidth + delta)));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (iframeEl) iframeEl.style.pointerEvents = '';
      this.saveWidthPercentage(this.panelWidth());
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  private loadWidth(): number {
    const defaultWidth = this.clampWidth(window.innerWidth * PlannotatorPanelComponent.DEFAULT_WIDTH_RATIO);

    try {
      const stored = localStorage.getItem(PlannotatorPanelComponent.STORAGE_KEY);
      if (stored) {
        const value = Number.parseFloat(stored);
        if (Number.isFinite(value) && value > 0) {
          if (value <= 100) {
            return this.clampWidth((value / 100) * window.innerWidth);
          }

          // Migrate legacy pixel-based storage to percentage-based storage.
          const legacyWidth = this.clampWidth(value);
          this.saveWidthPercentage(legacyWidth);
          return legacyWidth;
        }
      }
    } catch {}

    return defaultWidth;
  }

  private clampWidth(width: number): number {
    const maxWidth = window.innerWidth * PlannotatorPanelComponent.MAX_WIDTH_RATIO;
    return Math.min(maxWidth, Math.max(PlannotatorPanelComponent.MIN_WIDTH, width));
  }

  private saveWidthPercentage(width: number): void {
    try {
      const clampedWidth = this.clampWidth(width);
      const widthPercentage = (clampedWidth / window.innerWidth) * 100;
      localStorage.setItem(PlannotatorPanelComponent.STORAGE_KEY, widthPercentage.toFixed(2));
    } catch {}
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.messageHandler);
  }
}
