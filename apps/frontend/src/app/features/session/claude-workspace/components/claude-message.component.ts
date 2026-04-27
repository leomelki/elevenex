import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy, lucidePencil, lucideX } from '@ng-icons/lucide';
import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import { MarkdownPipe } from '../pipes/markdown.pipe';

@Component({
  selector: 'cw-message',
  standalone: true,
  imports: [CommonModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCheck, lucideCopy, lucidePencil, lucideX })],
  template: `
    @switch (item().kind) {
      @case ('user') {
        <div
          class="cw-msg cw-msg--user"
          [class.cw-msg--armed]="editArmed()"
          [attr.title]="timestampTitle()"
        >
          <div class="cw-msg__body">
            <div class="cw-msg__bubble">{{ item().content }}</div>
            @if (timestampLabel() || showActions()) {
              <div class="cw-msg__meta-row">
                @if (showActions()) {
                  <div class="cw-msg__actions">
                    <button
                      type="button"
                      class="cw-msg__action"
                      data-cw-edit-action
                      title="Copy message"
                      aria-label="Copy message"
                      [disabled]="actionsDisabled()"
                      (click)="copy.emit()"
                    >
                      <ng-icon name="lucideCopy" size="12" />
                    </button>
                    @if (editArmed()) {
                      <button
                        type="button"
                        class="cw-msg__action"
                        data-cw-edit-action
                        title="Confirm edit"
                        aria-label="Confirm edit"
                        [disabled]="actionsDisabled()"
                        (click)="confirmEdit.emit()"
                      >
                        <ng-icon name="lucideCheck" size="12" />
                      </button>
                      <button
                        type="button"
                        class="cw-msg__action"
                        data-cw-edit-action
                        title="Cancel edit"
                        aria-label="Cancel edit"
                        [disabled]="actionsDisabled()"
                        (click)="cancelEdit.emit()"
                      >
                        <ng-icon name="lucideX" size="12" />
                      </button>
                    } @else {
                      <button
                        type="button"
                        class="cw-msg__action"
                        data-cw-edit-action
                        title="Edit message"
                        aria-label="Edit message"
                        [disabled]="actionsDisabled()"
                        (click)="armEdit.emit()"
                      >
                        <ng-icon name="lucidePencil" size="12" />
                      </button>
                    }
                  </div>
                }
                @if (timestampLabel(); as label) {
                  <div class="cw-msg__meta" aria-hidden="true">{{ label }}</div>
                }
              </div>
            }
          </div>
          @if (editArmed()) {
            <div class="cw-msg__confirm" data-cw-edit-confirm-root>
              <p class="cw-msg__confirm-copy">
                Rewind to this message? This message and everything after it will be removed.
                The prompt will be restored to the composer.
              </p>
            </div>
          }
        </div>
      }
      @case ('assistant') {
        <div class="cw-msg cw-msg--assistant" [attr.title]="timestampTitle()">
          <div class="cw-msg__body">
            @if (item().content) {
              @if (streaming()) {
                <div class="cw-msg__streaming">{{ item().content }}</div>
                <span class="cw-caret"></span>
              } @else {
                <div class="cw-md" [innerHTML]="item().content | cwMarkdown"></div>
              }
            } @else if (streaming()) {
              <span class="cw-caret cw-caret--waiting"></span>
            }
            @if (timestampLabel(); as label) {
              <div class="cw-msg__meta" aria-hidden="true">{{ label }}</div>
            }
          </div>
        </div>
      }
      @case ('system') {
        <div class="cw-msg cw-msg--system" [attr.title]="timestampTitle()">
          <div class="cw-msg__body">
            {{ item().content }}
            @if (timestampLabel(); as label) {
              <div class="cw-msg__meta" aria-hidden="true">{{ label }}</div>
            }
          </div>
        </div>
      }
      @case ('error') {
        <div class="cw-msg cw-msg--error" [attr.title]="timestampTitle()">
          <div class="cw-msg__body">
            {{ item().content }}
            @if (timestampLabel(); as label) {
              <div class="cw-msg__meta" aria-hidden="true">{{ label }}</div>
            }
          </div>
        </div>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-msg {
        font-size: 0.875rem;
        line-height: 1.65;
      }
      .cw-msg__body {
        display: inline-flex;
        flex-direction: column;
        gap: 0.2rem;
        max-width: min(100%, 100ch);
        min-width: 0;
      }
      .cw-msg--user {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
      }
      .cw-msg--user .cw-msg__body {
        position: relative;
        padding-bottom: 1.45rem;
      }
      .cw-msg--user .cw-msg__bubble {
        max-width: 100%;
        min-width: 0;
        width: fit-content;
        padding: 0.5rem 0.875rem;
        background: color-mix(in oklab, var(--primary) 10%, var(--card));
        border: 1px solid var(--border);
        border-radius: 1rem 1rem 0.25rem 1rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cw-msg--assistant {
        color: var(--foreground);
      }
      .cw-msg__meta-row {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        opacity: 0;
        transform: translateY(-0.125rem);
        transition:
          opacity 140ms ease,
          transform 140ms ease;
      }
      .cw-msg--user .cw-msg__meta-row {
        position: absolute;
        right: 0;
        top: calc(100% - 1.2rem);
        white-space: nowrap;
      }
      .cw-msg__meta {
        font-size: 0.6875rem;
        line-height: 1.4;
        color: color-mix(in oklab, var(--muted-foreground) 88%, transparent);
        pointer-events: none;
        user-select: none;
      }
      .cw-msg__actions {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      .cw-msg__action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.65rem;
        height: 1.65rem;
        border: 0;
        background: transparent;
        color: color-mix(in oklab, var(--muted-foreground) 88%, transparent);
        padding: 0;
        border-radius: 999px;
        cursor: pointer;
        transition:
          background-color 140ms ease,
          color 140ms ease;
      }
      .cw-msg__action:hover,
      .cw-msg__action:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--foreground);
      }
      .cw-msg__action:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .cw-msg__confirm {
        display: flex;
        justify-content: flex-end;
        width: 100%;
        margin-top: 0.35rem;
      }
      .cw-msg__confirm-copy {
        margin: 0;
        max-width: min(100%, 30rem);
        padding: 0.625rem 0.75rem;
        border: 1px solid color-mix(in oklab, var(--border) 88%, transparent);
        border-radius: 0.875rem;
        background: color-mix(in oklab, var(--foreground) 3%, var(--background));
        color: var(--muted-foreground);
        font-size: 0.75rem;
        line-height: 1.45;
      }
      .cw-msg--user .cw-msg__meta {
        text-align: right;
        padding-right: 0.125rem;
      }
      .cw-msg:hover .cw-msg__meta-row,
      .cw-msg:focus-within .cw-msg__meta-row,
      .cw-msg--armed .cw-msg__meta-row {
        opacity: 1;
        transform: translateY(0);
      }
      .cw-msg__streaming {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cw-msg--system {
        font-size: 0.75rem;
        color: var(--muted-foreground);
        padding: 0.25rem 0.5rem;
        border-left: 2px solid var(--border);
        white-space: pre-wrap;
      }
      .cw-msg--error {
        font-size: 0.8125rem;
        padding: 0.5rem 0.75rem;
        background: color-mix(in oklab, var(--destructive) 8%, transparent);
        border-left: 2px solid var(--destructive);
        color: var(--destructive);
        border-radius: 0.25rem;
        white-space: pre-wrap;
      }
      .cw-md :first-child {
        margin-top: 0;
      }
      .cw-md :last-child {
        margin-bottom: 0;
      }
      .cw-md p {
        margin: 0.5rem 0;
      }
      .cw-md ul,
      .cw-md ol {
        margin: 0.5rem 0;
        padding-left: 1.25rem;
      }
      .cw-md li {
        margin: 0.125rem 0;
      }
      .cw-md h1,
      .cw-md h2,
      .cw-md h3 {
        margin: 1rem 0 0.375rem;
        font-weight: 600;
        line-height: 1.3;
      }
      .cw-md h1 {
        font-size: 1.125rem;
      }
      .cw-md h2 {
        font-size: 1rem;
      }
      .cw-md h3 {
        font-size: 0.9375rem;
      }
      .cw-md code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8125em;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        padding: 0.0625rem 0.3125rem;
        border-radius: 0.25rem;
      }
      .cw-md :global(pre.cw-code),
      .cw-md pre {
        margin: 0.5rem 0;
        padding: 0.625rem 0.75rem;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        overflow: auto;
        font-size: 0.8125rem;
        line-height: 1.55;
      }
      .cw-md pre code {
        background: transparent;
        padding: 0;
        font-size: inherit;
      }
      .cw-md blockquote {
        margin: 0.5rem 0;
        padding: 0.125rem 0.75rem;
        border-left: 3px solid var(--border);
        color: var(--muted-foreground);
      }
      .cw-md a {
        color: color-mix(in oklab, var(--primary) 90%, #3b82f6);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .cw-md table {
        width: 100%;
        border-collapse: collapse;
        margin: 0.5rem 0;
        font-size: 0.8125rem;
      }
      .cw-md th,
      .cw-md td {
        border: 1px solid var(--border);
        padding: 0.25rem 0.5rem;
        text-align: left;
      }
      .cw-caret {
        display: inline-block;
        width: 0.5ch;
        height: 1.05em;
        vertical-align: -0.15em;
        margin-left: 1px;
        background: currentColor;
        animation: cw-caret-blink 1s steps(2, start) infinite;
        opacity: 0.6;
      }
      .cw-caret--waiting {
        margin-left: 0;
      }
      @keyframes cw-caret-blink {
        50% {
          opacity: 0;
        }
      }
    `,
  ],
})
export class ClaudeMessageComponent {
  readonly item = input.required<ClaudeTranscriptItem>();
  readonly streaming = input<boolean>(false);
  readonly showActions = input<boolean>(false);
  readonly actionsDisabled = input<boolean>(false);
  readonly editArmed = input<boolean>(false);

  readonly copy = output<void>();
  readonly armEdit = output<void>();
  readonly confirmEdit = output<void>();
  readonly cancelEdit = output<void>();

  readonly isEmpty = computed(() => !this.item().content);
  readonly timestampLabel = computed(() => buildTimestampLabel(this.item(), this.streaming()));
  readonly timestampTitle = computed(() => this.timestampLabel());
}

function buildTimestampLabel(item: ClaudeTranscriptItem, streaming: boolean): string | null {
  const timestamp = getDisplayTimestamp(item);
  if (!timestamp) return null;
  return formatTimestamp(timestamp);
}

function getDisplayTimestamp(item: ClaudeTranscriptItem): string | null {
  return item.receivedAt || item.authoredAt || item.timestamp || null;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const now = new Date();
  const isSameDay =
    now.getFullYear() === date.getFullYear()
    && now.getMonth() === date.getMonth()
    && now.getDate() === date.getDate();

  const timeLabel = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  if (isSameDay) {
    return timeLabel;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const sameYear = now.getFullYear() === date.getFullYear();
  const dateLabel = sameYear
    ? `${day}/${month}`
    : `${day}/${month}/${date.getFullYear()}`;

  return `${dateLabel} ${timeLabel}`;
}
