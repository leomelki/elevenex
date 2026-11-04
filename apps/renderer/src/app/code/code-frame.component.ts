import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';

/** Constructed only by the window-owned frame pool after URL validation. */
@Component({
  selector: 'ex-code-frame',
  template: '<iframe [src]="source()" title="Task Code workbench" sandbox="allow-scripts allow-same-origin" allow="clipboard-write" referrerpolicy="no-referrer"></iframe>',
  styles: ':host { display: flex; flex: 1; min-width: 0; min-height: 0; width: 100%; height: 100%; } iframe { flex: 1; width: 100%; height: 100%; min-width: 0; border: 0; background: var(--surface); } :host-context(.crossfading) iframe { view-transition-name: code-editor; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodeFrameComponent {
  readonly url = input.required<string>();
  private readonly sanitizer = inject(DomSanitizer);
  readonly source = computed(() => this.sanitizer.bypassSecurityTrustResourceUrl(this.url()));
}
