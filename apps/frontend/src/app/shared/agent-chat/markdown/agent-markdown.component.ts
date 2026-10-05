import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewEncapsulation,
  inject,
  input,
  output,
} from '@angular/core';
import { MarkdownPipe, resolveLocalFileTarget } from './markdown.pipe';

/** Sanitized agent Markdown with consistent document styling and local-file navigation. */
@Component({
  selector: 'agent-markdown',
  imports: [MarkdownPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: { '(click)': 'openLink($event)', '(auxclick)': 'openLink($event)' },
  template:
    '<div class="agent-markdown__content" [innerHTML]="content() | cwMarkdown: worktreePath(): sourcePath()"></div>',
  styleUrl: './agent-markdown.component.scss',
})
export class AgentMarkdownComponent {
  readonly content = input<string | null | undefined>('');
  readonly worktreePath = input<string | null>(null);
  readonly sourcePath = input<string | null>(null);
  readonly openLocalFile = output<LocalFileTarget>();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected openLink(event: MouseEvent): void {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const element = event.target instanceof Element ? event.target : null;
    const anchor = element?.closest<HTMLAnchorElement>('a.cw-local-file-link');
    const worktree = this.worktreePath();
    if (!anchor || !worktree || !this.host.nativeElement.contains(anchor)) return;
    const target = resolveLocalFileTarget(
      anchor.getAttribute('href') ?? '',
      worktree,
      this.sourcePath(),
    );
    if (!target) return;
    event.preventDefault();
    this.openLocalFile.emit(target);
  }
}
