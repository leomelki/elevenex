import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from "@angular/core";
import { IconComponent, StatusGlyphComponent } from "../../ui";
import type { ConversationMention } from "../conversation.models";
@Component({
  selector: "ex-mention",
  imports: [IconComponent, StatusGlyphComponent],
  template: `<span [attr.data-kind]="mention().kind">
    @if (mention().kind === "session" && mention().status) {
      <ex-status-glyph [status]="mention().status || 'done'" [size]="12" />
    } @else {
      <ex-icon
        [name]="mention().kind === 'file' ? 'file' : 'task'"
        [size]="12"
      />
    }
    {{ mention().label }}
    @if (removable()) {
      <button
        type="button"
        [attr.aria-label]="'Remove ' + mention().label"
        (click)="removed.emit(mention().id)"
      >
        ×
      </button>
    }
  </span>`,
  styles: `
    :host {
      display: inline-flex;
      max-width: 100%;
    }
    span {
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
      max-width: 100%;
      min-height: 20px;
      padding: 0 var(--space-1);
      border-radius: var(--radius-xs);
      background: var(--accent-soft);
      color: var(--accent);
      font-size: var(--text-caption-size);
      font-weight: 500;
    }
    span[data-kind="task"],
    span[data-kind="file"] {
      background: var(--surface-sunken);
      color: var(--ink);
      box-shadow: inset 0 0 0 1px var(--line);
    }
    span[data-kind="file"] {
      font-family: var(--font-mono);
    }
    button {
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
      border: 0;
      border-radius: var(--radius-xs);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--line);
    }
    button:focus-visible {
      outline: 2px solid transparent;
      box-shadow: var(--focus-ring);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MentionComponent {
  readonly mention = input.required<ConversationMention>();
  readonly removable = input(false);
  readonly removed = output<string>();
}
