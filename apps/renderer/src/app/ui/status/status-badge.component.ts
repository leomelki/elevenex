import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { Status, STATUS_LABELS } from "./status.models";
import { StatusGlyphComponent } from "./status-glyph.component";
@Component({
  selector: "ex-status-badge",
  imports: [StatusGlyphComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[attr.data-status]": "status()" },
  template: `<ex-status-glyph [status]="status()" [size]="12" />{{
      label() || labels[status()]
    }}`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      height: 22px;
      padding: 0 var(--space-2);
      border-radius: var(--radius-full);
      font-size: var(--text-caption-size);
      font-weight: 500;
      white-space: nowrap;
      background: var(--surface-sunken);
      color: var(--ink-muted);
    }
    :host([data-status="running"]) {
      background: var(--running-soft);
      color: var(--running);
    }
    :host([data-status="attention"]) {
      background: var(--attention-soft);
      color: var(--attention);
    }
    :host([data-status="review"]) {
      background: var(--review-soft);
      color: var(--review);
    }
    :host([data-status="failed"]) {
      background: var(--danger-soft);
      color: var(--danger);
    }
  `,
})
export class StatusBadgeComponent {
  readonly status = input<Status>("queued");
  readonly label = input("");
  protected readonly labels = STATUS_LABELS;
}
