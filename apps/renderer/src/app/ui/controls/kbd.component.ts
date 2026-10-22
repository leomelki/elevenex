import { ChangeDetectionStrategy, Component } from "@angular/core";
@Component({
  selector: "ex-kbd",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<kbd><ng-content /></kbd>`,
  styles: `
    :host {
      display: inline-flex;
    }
    kbd {
      font-family: var(--font-mono);
      font-size: 10.5px;
      line-height: var(--text-caption-line);
      font-weight: 500;
      padding: 0 var(--kbd-padding, var(--space-1));
      min-width: var(--space-4);
      text-align: center;
      border-radius: var(--radius-xs);
      border: 1px solid var(--line);
      background: var(--kbd-background, var(--surface-sunken));
      color: var(--kbd-color, var(--ink-muted));
      box-sizing: border-box;
    }
  `,
})
export class KbdComponent {}
