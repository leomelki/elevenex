import { ChangeDetectionStrategy, Component } from "@angular/core";
@Component({
  selector: "ex-kbd",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<kbd><ng-content /></kbd>`,
  styles: `
    :host {
      display: inline-flex;
      margin-left: var(--kbd-margin, 0);
      opacity: var(--kbd-opacity, 1);
    }
    kbd {
      font-family: var(--font-mono);
      font-size: 10.5px;
      line-height: var(--text-mono-meta-line);
      font-weight: var(--text-mono-meta-weight);
      padding: 0 var(--kbd-padding, 5px);
      min-width: var(--space-4);
      text-align: center;
      border-radius: var(--radius-xs);
      border: 1px solid var(--kbd-border, var(--line));
      background: var(--kbd-background, var(--surface-sunken));
      color: var(--kbd-color, var(--ink-muted));
      box-sizing: border-box;
    }
  `,
})
export class KbdComponent {}
