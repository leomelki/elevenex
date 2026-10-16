import { MediaPreviewDirective } from '../media/media-preview.directive';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  ViewEncapsulation,
  inject,
  input,
  output,
} from '@angular/core';
import { MarkdownPipe, resolveLocalFileTarget } from './markdown.pipe';
import { splitMarkdownVisualizations } from './markdown-visualization';
import { AgentVisualizationComponent } from './agent-visualization.component';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';
import { getBackendOrigin, shouldUseHashLocation } from '@/shared/runtime/runtime-config';

/** Sanitized agent Markdown with consistent document styling and local-file navigation. */
@Component({
  selector: 'agent-markdown',
  imports: [MarkdownPipe, MediaPreviewDirective, AgentVisualizationComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { '(click)': 'openLink($event)', '(auxclick)': 'openLink($event)' },
  templateUrl: './agent-markdown.component.html',
  styleUrl: './agent-markdown.component.scss',
})
export class AgentMarkdownComponent {
  // One revision per mounted message; streaming updates keep existing media URLs.
  readonly mediaRevision = crypto.randomUUID();
  readonly content = input<string | null | undefined>('');
  readonly worktreePath = input<string | null>(null);
  readonly sourcePath = input<string | null>(null);
  protected readonly parts = computed(() => splitMarkdownVisualizations(this.content() || ''));
  readonly openLocalFile = output<LocalFileTarget>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected openLink(event: MouseEvent): void {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const element = event.target instanceof Element ? event.target : null;
    const anchor = element?.closest<HTMLAnchorElement>('a[href]');
    const worktree = this.worktreePath();
    if (!anchor || !this.host.nativeElement.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!href || href.startsWith('#')) return;
    const target = worktree && resolveLocalFileTarget(
      href,
      worktree,
      anchor.classList.contains('cw-local-file-link') ? null : this.sourcePath(),
    );
    event.preventDefault();
    if (target) {
      this.openLocalFile.emit(target);
      return;
    }
    // Packaged renderers have a file: base URL. Relative application links
    // need an HTTP origin when handed to the system browser.
    const url = shouldUseHashLocation()
      ? new URL(href, `${getBackendOrigin()}/`).href
      : anchor.href;
    const externalLinks = getElectronExternalLinksApi();
    if (externalLinks) {
      void externalLinks.open(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
}
