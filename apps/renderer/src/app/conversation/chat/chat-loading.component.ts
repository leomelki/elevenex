import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { StatusGlyphComponent } from '../../ui';

@Component({
  selector: 'ex-chat-loading',
  imports: [StatusGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'status',
    '[attr.aria-label]': 'label() + (progressive() ? " · Progressive loading" : "")',
  },
  template: `
    <ex-status-glyph status="running" [size]="12" aria-hidden="true" />
    @if (!compact()) { <span aria-hidden="true">{{ label() }}</span> }
    @if (progressive()) { <small aria-hidden="true">Progressive</small> }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--ink-muted); font-size: var(--text-caption-size); }
    small { font-size: var(--text-overline-size); }
  `,
})
export class ChatLoadingComponent {
  readonly label = input('Loading messages');
  readonly compact = input(false);
  readonly progressive = input(false);
}
