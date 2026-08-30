import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFileCode,
  lucideLoaderCircle,
  lucideMessageSquare,
  lucidePaperclip,
  lucideSend,
  lucideSquare,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import {
  ClaudeAutocompleteItem,
  ClaudePendingPrompt,
} from '@/shared/models/claude-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import {
  diffSelectionMentionLineLabel,
  diffSelectionMentionPreview,
  parseDiffSelectionMentions,
} from '@/shared/utils/diff-selection-mention';
import { splitFilePathForDisplay } from '@/shared/utils/file-path-display';
import type { SessionMention, SessionMentionCandidate } from '@/shared/models/session-mention.model';
import { SESSION_MENTION_DRAG_TYPE } from '@/shared/models/session-mention.model';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';

interface Range {
  start: number;
  end: number;
}

export type ComposerImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

export interface ComposerImageAttachment {
  id: string;
  name: string;
  mediaType: ComposerImageMediaType;
  dataUrl: string;
  size: number;
}

export interface ComposerSendPayload {
  text: string;
  images: ComposerImageAttachment[];
  diffMentions?: DiffSelectionMention[];
  sessionMentions?: SessionMention[];
}

type ComposerAutocompleteOption =
  | { type: 'provider'; item: ClaudeAutocompleteItem }
  | { type: 'session'; item: SessionMentionCandidate };

const COMPOSER_IMAGE_ALLOWED_MIME: readonly ComposerImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
const COMPOSER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const COMPOSER_IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

@Component({
  selector: 'cw-composer',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgIcon,
    DictateTargetDirective,
    DictationButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:mousedown)': 'onDocumentMousedown($event)',
  },
  viewProviders: [
    provideIcons({ lucideFileCode, lucideLoaderCircle, lucideMessageSquare, lucidePaperclip, lucideSend, lucideSquare, lucideX }),
  ],
  template: `
    <div class="cw-comp">
      @if (autocompleteOpen() && filtered().length) {
        <div class="cw-comp__ac" role="listbox">
          @for (item of filtered(); track autocompleteOptionId(item); let i = $index) {
            <button
              type="button"
              class="cw-comp__ac-item"
              [class.cw-comp__ac-item--active]="i === selectedIndex()"
              (mouseenter)="selectedIndex.set(i)"
              (mousedown)="$event.preventDefault(); apply(item)"
            >
              @if (item.type === 'session') {
                <span class="cw-comp__ac-label">&#64;{{ item.item.title }}</span>
                <span class="cw-comp__ac-kind">session #{{ item.item.sessionId }}</span>
                <span class="cw-comp__ac-desc">{{ item.item.branch }} · {{ item.item.status }}</span>
              } @else {
                <span class="cw-comp__ac-label">{{ item.item.label }}</span>
                <span class="cw-comp__ac-kind">{{ item.item.kind }}</span>
                <span class="cw-comp__ac-desc">{{ item.item.description }}</span>
              }
            </button>
          }
        </div>
      }

      <div
        class="cw-comp__box"
        [class.cw-comp__box--attached]="attachedPanelOpen()"
        [class.cw-comp__box--dropping]="isDropTarget()"
        [class.cw-comp__box--disconnected]="disconnected()"
        (dragenter)="onDragEnter($event)"
        (dragover)="onDragOver($event)"
        (dragleave)="onDragLeave($event)"
        (drop)="onDrop($event)"
      >
        @if (isDropTarget()) {
          <div class="cw-comp__drop-hint" role="status">
            <ng-icon name="lucideMessageSquare" size="14" />
            Drop to attach context
          </div>
        }
        @if (attachedImages().length) {
          <div class="cw-comp__images" role="list" aria-label="Attached images">
            @for (img of attachedImages(); track img.id) {
              <div class="cw-comp__image" role="listitem">
                <img [src]="img.dataUrl" [alt]="img.name" />
                <button
                  type="button"
                  class="cw-comp__image-remove"
                  title="Remove attachment"
                  aria-label="Remove attachment"
                  (click)="removeImage(img.id)"
                >
                  <ng-icon name="lucideX" size="12" />
                </button>
              </div>
            }
          </div>
        }
        @if (sessionMentions().length || loadingSessionMention()) {
          <div class="cw-comp__mentions" role="list" aria-label="Mentioned sessions">
            @for (mention of sessionMentions(); track mention.sessionId) {
              <article class="cw-comp__mention" role="listitem">
                <span class="cw-comp__mention-icon" aria-hidden="true">
                  <ng-icon name="lucideMessageSquare" size="14" />
                </span>
                <div class="cw-comp__mention-body">
                  <div class="cw-comp__mention-head">
                    <strong class="cw-comp__mention-name">{{ mention.title }}</strong>
                    <span class="cw-comp__mention-lines">#{{ mention.sessionId }}</span>
                  </div>
                  <p class="cw-comp__mention-preview">{{ mention.provider }} · {{ mention.branch }}</p>
                  <span class="cw-comp__mention-meta">Compact transcript snapshot · full export available to the agent</span>
                </div>
                <button type="button" class="cw-comp__mention-remove" title="Remove session mention" [attr.aria-label]="'Remove ' + mention.title" (click)="removeSessionMention.emit(mention.sessionId)">
                  <ng-icon name="lucideX" size="12" />
                </button>
              </article>
            }
            @if (loadingSessionMention()) {
              <div class="cw-comp__pending-item" role="status">
                <ng-icon name="lucideLoaderCircle" size="13" class="animate-spin" />
                Preparing session context…
              </div>
            }
          </div>
        }
        @if (diffMentions().length) {
          <div class="cw-comp__mentions" role="list" aria-label="Mentioned diff selections">
            @for (mention of diffMentions(); track mention.id) {
              <article class="cw-comp__mention" role="listitem">
                <span class="cw-comp__mention-icon" aria-hidden="true">
                  <ng-icon name="lucideFileCode" size="14" />
                </span>
                <div class="cw-comp__mention-body">
                  <div class="cw-comp__mention-head">
                    <span class="cw-comp__mention-path" [title]="mention.filePath">
                      @if (mentionDirname(mention); as dirname) {
                        <span class="cw-comp__mention-dir">{{ dirname }}</span>
                        <span class="cw-comp__mention-slash" aria-hidden="true">/</span>
                      }
                      <strong class="cw-comp__mention-name">{{ mentionBasename(mention) }}</strong>
                    </span>
                    <span class="cw-comp__mention-lines">{{ mentionLineLabel(mention) }}</span>
                  </div>
                  <p class="cw-comp__mention-preview">{{ mentionPreview(mention) }}</p>
                  <span class="cw-comp__mention-meta">
                    {{ mention.status }} · {{ mention.context.before.length + mention.context.after.length }} context lines{{ mention.truncated ? ' · truncated' : '' }}
                  </span>
                </div>
                <button
                  type="button"
                  class="cw-comp__mention-remove"
                  title="Remove diff mention"
                  aria-label="Remove diff mention"
                  (click)="removeDiffMention.emit(mention.id)"
                >
                  <ng-icon name="lucideX" size="12" />
                </button>
              </article>
            }
          </div>
        }
        <!-- What is running is shown by cw-background-activity above the
             composer; this only explains the consequence for sending. -->
        @if (backgroundAgentCount() > 0) {
          <div class="cw-comp__bg-agent" role="status">
            Background work in progress — new messages will be queued until it finishes.
          </div>
        }
        @if (pendingPrompts().length) {
          <div class="cw-comp__pending" role="list" aria-label="Queued messages">
            @for (p of pendingPrompts(); track p.id) {
              <div class="cw-comp__pending-item" role="listitem">
                <span class="cw-comp__pending-text">{{ pendingPromptPreview(p.prompt) }}</span>
                <button
                  type="button"
                  class="cw-comp__pending-remove"
                  title="Cancel queued message"
                  aria-label="Cancel queued message"
                  (click)="cancelPending.emit(p.id)"
                >
                  <ng-icon name="lucideX" size="12" />
                </button>
              </div>
            }
          </div>
        }
        <textarea
          #input
          appDictateTarget
          #dictate="dictateTarget"
          [sessionId]="sessionId()"
          [worktreePath]="worktreePath()"
          (dictationSubmit)="submit()"
          class="cw-comp__ta"
          [placeholder]="placeholder()"
          [ngModel]="value()"
          [disabled]="disconnected()"
          (input)="onInput($event)"
          (click)="refreshAc($any($event.target))"
          (keydown)="onKeydown($event)"
          (paste)="onPaste($event)"
          rows="1"
        ></textarea>
        <input
          #fileInput
          type="file"
          class="cw-comp__file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          (change)="onFileInputChange($event)"
        />

        <div class="cw-comp__bar">
          <span class="cw-comp__hint">
            @if (disconnected()) {
              <ng-icon name="lucideLoaderCircle" size="12" class="animate-spin cw-comp__hint-icon" />
              Reconnecting…
            } @else if (autocompleteOpen() && filtered().length) {
              ↑↓ navigate · ↵ insert
            } @else if (blockedByPermission()) {
              {{ sendDisabledReason() || 'Respond to the approval request before sending another message.' }}
            } @else {
              &#64; sessions · / commands · $ skills · ↵ send · ⇧↵ line break
            }
          </span>

          <div class="cw-comp__btns">
            <app-dictation-button
              [target]="dictate"
              [disabled]="disconnected()"
            />
            @if (allowImages()) {
              <button
                type="button"
                class="cw-comp__btn cw-comp__btn--ghost"
                title="Attach image"
                aria-label="Attach image"
                [disabled]="disconnected()"
                (click)="openFilePicker()"
              >
                <ng-icon name="lucidePaperclip" size="14" />
              </button>
            }
            @if (running()) {
              <button
                type="button"
                class="cw-comp__btn cw-comp__btn--stop"
                [disabled]="!canInterrupt() || disconnected()"
                (click)="interrupt.emit()"
                title="Interrupt"
              >
                <ng-icon name="lucideSquare" size="14" />
                Stop
              </button>
            }
            <button
              type="button"
              class="cw-comp__btn cw-comp__btn--send"
              [disabled]="(!value().trim() && !attachedImages().length && !diffMentions().length && !sessionMentions().length) || loadingSessionMention() || (submitting() && !queueing()) || blockedByPermission() || disconnected()"
              (click)="submit()"
              [title]="queueing() ? 'Queue message' : 'Send'"
            >
              @if (submitting() && !queueing()) {
                <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
              } @else {
                <ng-icon name="lucideSend" size="14" />
              }
              {{ queueing() ? 'Queue' : 'Send' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        position: relative;
      }
      .cw-comp {
        position: relative;
      }
      .cw-comp__box {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: 0.75rem;
        background: var(--background);
        box-shadow: 0 1px 0 color-mix(in oklab, var(--foreground) 4%, transparent);
        overflow: hidden;
      }
      .cw-comp__box--attached {
        border-top-left-radius: 0;
        border-top-right-radius: 0;
      }
      .cw-comp__box:focus-within {
        border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--primary) 12%, transparent);
      }
      .cw-comp__ta {
        width: 100%;
        min-height: 2.75rem;
        max-height: 16rem;
        padding: 0.625rem 0.875rem 0.25rem;
        background: transparent;
        border: 0;
        outline: none;
        resize: none;
        color: inherit;
        font: inherit;
        font-size: 0.875rem;
        line-height: 1.5;
      }
      .cw-comp__bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.375rem 0.625rem 0.375rem 0.875rem;
      }
      .cw-comp__btns {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
      }
      .cw-comp__pending {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.5rem 0.625rem 0.25rem 0.875rem;
        border-bottom: 1px dashed color-mix(in oklab, var(--foreground) 12%, transparent);
      }
      .cw-comp__bg-agent {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.375rem 0.875rem;
        font-size: 0.75rem;
        color: var(--warning);
        background: color-mix(in oklab, var(--warning) 10%, transparent);
        border-bottom: 1px solid color-mix(in oklab, var(--warning) 20%, transparent);
      }
      .cw-comp__mentions {
        display: grid;
        gap: 0.375rem;
        padding: 0.5rem 0.625rem 0.25rem 0.875rem;
        border-bottom: 1px dashed color-mix(in oklab, var(--foreground) 12%, transparent);
      }
      .cw-comp__mention {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: start;
        gap: 0.55rem;
        padding: 0.5rem 0.55rem;
        border: 1px solid color-mix(in oklab, var(--primary) 20%, var(--border));
        border-radius: 0.55rem;
        background: color-mix(in oklab, var(--primary) 5%, var(--background));
      }
      .cw-comp__mention-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.55rem;
        height: 1.55rem;
        border-radius: 0.45rem;
        background: var(--background);
        color: var(--primary);
        border: 1px solid var(--border);
      }
      .cw-comp__mention-body {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .cw-comp__mention-head {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        min-width: 0;
      }
      .cw-comp__mention-path {
        display: inline-flex;
        align-items: baseline;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.74rem;
      }
      .cw-comp__mention-dir {
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        direction: rtl;
        text-align: left;
        unicode-bidi: isolate;
        color: var(--muted-foreground);
        font-weight: 500;
      }
      .cw-comp__mention-slash {
        flex: 0 0 auto;
        padding: 0 0.08rem;
        color: var(--muted-foreground);
        font-weight: 500;
      }
      .cw-comp__mention-name {
        max-width: 100%;
        flex: 0 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--foreground);
        font-weight: 800;
      }
      .cw-comp__mention-lines {
        flex-shrink: 0;
        border-radius: 999px;
        padding: 0.08rem 0.38rem;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        color: var(--muted-foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.64rem;
        font-weight: 700;
      }
      .cw-comp__mention-preview {
        margin: 0;
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        line-height: 1.35;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cw-comp__mention-meta {
        color: var(--muted-foreground);
        font-size: 0.67rem;
        line-height: 1.25;
      }
      .cw-comp__mention-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.35rem;
        height: 1.35rem;
        border-radius: 0.4rem;
        border: 0;
        background: transparent;
        color: var(--muted-foreground);
        cursor: pointer;
      }
      .cw-comp__mention-remove:hover {
        background: color-mix(in oklab, var(--foreground) 9%, transparent);
        color: var(--foreground);
      }
      .cw-comp__pending-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0.5rem;
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        color: var(--muted-foreground);
        font-size: 0.75rem;
      }
      .cw-comp__pending-text {
        flex: 1 1 auto;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cw-comp__pending-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 0.375rem;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      .cw-comp__pending-remove:hover {
        background: color-mix(in oklab, var(--foreground) 10%, transparent);
        color: var(--foreground);
      }
      .cw-comp__hint {
        font-size: 0.6875rem;
        color: var(--muted-foreground);
      }
      .cw-comp__btn {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.3125rem 0.75rem;
        border-radius: 0.5rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: inherit;
        font: inherit;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
      }
      .cw-comp__btn--send {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }
      .cw-comp__btn--send:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .cw-comp__btn--stop {
        background: color-mix(in oklab, var(--destructive) 10%, var(--background));
        color: var(--destructive);
        border-color: color-mix(in oklab, var(--destructive) 40%, var(--border));
      }
      .cw-comp__btn--stop:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .cw-comp__btn--ghost {
        background: transparent;
        color: var(--muted-foreground);
        padding: 0.3125rem 0.5rem;
      }
      .cw-comp__btn--ghost:hover {
        color: var(--foreground);
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
      }
      .cw-comp__file {
        display: none;
      }
      .cw-comp__box--dropping {
        border-color: color-mix(in oklab, var(--primary) 60%, var(--border));
        background: color-mix(in oklab, var(--primary) 4%, var(--background));
      }
      .cw-comp__drop-hint {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        padding: 0.55rem 0.875rem;
        border-bottom: 1px dashed color-mix(in oklab, var(--primary) 35%, var(--border));
        background: color-mix(in oklab, var(--primary) 9%, var(--background));
        color: var(--primary);
        font-size: 0.75rem;
        font-weight: 650;
      }
      .cw-comp__box--disconnected {
        opacity: 0.6;
        pointer-events: none;
      }
      .cw-comp__hint-icon {
        display: inline-block;
        vertical-align: middle;
        margin-right: 0.25rem;
      }
      .cw-comp__images {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        padding: 0.5rem 0.625rem 0.25rem 0.875rem;
        border-bottom: 1px dashed color-mix(in oklab, var(--foreground) 12%, transparent);
      }
      .cw-comp__image {
        position: relative;
        width: 4rem;
        height: 4rem;
        border-radius: 0.5rem;
        overflow: hidden;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        border: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent);
      }
      .cw-comp__image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .cw-comp__image-remove {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 1.125rem;
        height: 1.125rem;
        border-radius: 999px;
        border: 0;
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }
      .cw-comp__image-remove:hover {
        background: rgba(0, 0, 0, 0.85);
      }
      .cw-comp__ac {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 0.375rem);
        max-height: 18rem;
        overflow: auto;
        background: var(--popover);
        color: var(--popover-foreground);
        border: 1px solid var(--border);
        border-radius: 0.625rem;
        box-shadow: 0 10px 30px -10px color-mix(in oklab, #000 20%, transparent);
        z-index: 20;
      }
      .cw-comp__ac-item {
        display: grid;
        grid-template-columns: auto auto 1fr;
        gap: 0.5rem;
        align-items: baseline;
        width: 100%;
        padding: 0.4375rem 0.75rem;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        text-align: left;
        font-size: 0.8125rem;
      }
      .cw-comp__ac-item--active,
      .cw-comp__ac-item:hover {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
      }
      .cw-comp__ac-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-weight: 600;
      }
      .cw-comp__ac-kind {
        font-size: 0.6875rem;
        text-transform: uppercase;
        color: var(--muted-foreground);
        letter-spacing: 0.04em;
      }
      .cw-comp__ac-desc {
        color: var(--muted-foreground);
        font-size: 0.75rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ],
})
export class ClaudeComposerComponent {
  @ViewChild('input', { static: true }) private ta!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileInput', { static: true })
  private fileInput!: ElementRef<HTMLInputElement>;
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly value = input<string>('');
  readonly submitting = input<boolean>(false);
  readonly running = input<boolean>(false);
  readonly canInterrupt = input<boolean>(false);
  readonly blockedByPermission = input<boolean>(false);
  readonly sendDisabledReason = input<string>('');
  readonly attachedPanelOpen = input<boolean>(false);
  readonly allowImages = input<boolean>(true);
  readonly autocompleteItems = input<ClaudeAutocompleteItem[]>([]);
  readonly sessionMentionCandidates = input<SessionMentionCandidate[]>([]);
  readonly sessionMentions = input<SessionMention[]>([]);
  readonly loadingSessionMention = input<boolean>(false);
  readonly placeholderText = input<string>('Tell Claude what to do…');
  readonly pendingPrompts = input<ClaudePendingPrompt[]>([]);
  readonly disconnected = input<boolean>(false);
  readonly diffMentions = input<DiffSelectionMention[]>([]);
  readonly imageAttachments = input<ComposerImageAttachment[]>([]);
  // Count of backgrounded subagents/tasks still executing for this session.
  // The main turn can be idle while these run, but a submitted message will
  // still be queued behind them, so the composer must reflect that.
  readonly backgroundAgentCount = input<number>(0);
  /** Dictation context: biases transcription towards this repo's vocabulary. */
  readonly sessionId = input<number | null>(null);
  readonly worktreePath = input<string | null>(null);

  readonly queueing = computed(() => this.running() || this.backgroundAgentCount() > 0);

  readonly send = output<ComposerSendPayload>();
  readonly valueChange = output<string>();
  readonly imageAttachmentsChange = output<ComposerImageAttachment[]>();
  readonly interrupt = output<void>();
  readonly cancelPending = output<string>();
  readonly removeDiffMention = output<string>();
  readonly requestSessionMention = output<number>();
  readonly removeSessionMention = output<number>();

  readonly attachedImages = signal<ComposerImageAttachment[]>([]);
  readonly isDropTarget = signal(false);
  private dragDepth = 0;

  readonly activeTrigger = signal<'/' | '$' | '@' | null>(null);
  readonly activeQuery = signal('');
  readonly autocompleteOpen = signal(false);
  readonly selectedIndex = signal(0);
  private range: Range | null = null;

  readonly filtered = computed(() => {
    const trigger = this.activeTrigger();
    if (!trigger) return [];
    const q = this.activeQuery().toLowerCase();
    if (trigger === '@') {
      const attached = new Set(this.sessionMentions().map((mention) => mention.sessionId));
      return this.sessionMentionCandidates()
        .filter((item) => !attached.has(item.sessionId))
        .map((item) => ({ item, score: scoreSession(item, q) }))
        .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
        .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
        .map(({ item }): ComposerAutocompleteOption => ({ type: 'session', item }))
        .slice(0, 10);
    }
    return this.autocompleteItems()
      .filter((i) => i.trigger === trigger)
      .map((i) => ({ i, score: score(i, q) }))
      .filter((x) => x.score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => b.score - a.score || a.i.label.localeCompare(b.i.label))
      .map(({ i }): ComposerAutocompleteOption => ({ type: 'provider', item: i }))
      .slice(0, 10);
  });

  readonly placeholder = computed(() => this.placeholderText());

  constructor() {
    effect(() => {
      const nextValue = this.value();
      queueMicrotask(() => {
        const ta = this.ta?.nativeElement;
        if (!ta) return;
        if (ta.value !== nextValue) ta.value = nextValue;
        this.autoGrow(ta);
      });
    });
    effect(() => {
      if (!this.allowImages() && (this.attachedImages().length || this.imageAttachments().length)) {
        this.setAttachedImages([]);
      }
    });
    effect(() => {
      const nextImages = this.allowImages() ? this.imageAttachments() : [];
      if (!sameImages(this.attachedImages(), nextImages)) {
        this.attachedImages.set(nextImages);
      }
    });
  }

  onInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    this.valueChange.emit(ta.value);
    this.autoGrow(ta);
    this.refreshAc(ta);
  }

  onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;

    const ac = this.autocompleteOpen() && this.filtered().length;
    if (ac) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex.update((i) => (i + 1) % this.filtered().length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const len = this.filtered().length;
        this.selectedIndex.update((i) => (i - 1 + len) % len);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.apply(this.filtered()[this.selectedIndex()]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    }
  }

  refreshAc(ta: HTMLTextAreaElement): void {
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, caret);
    const m = before.match(/(^|\s)([/$@])([^\s]*)$/);
    if (!m) {
      this.close();
      return;
    }
    const trigger = m[2] as '/' | '$' | '@';
    const query = m[3] ?? '';
    const tokenStart = caret - (query.length + 1);
    const trailing = ta.value.slice(caret).match(/^[^\s]*/)?.[0] ?? '';
    this.range = { start: tokenStart, end: caret + trailing.length };
    this.activeTrigger.set(trigger);
    this.activeQuery.set(query);
    this.autocompleteOpen.set(true);
    this.selectedIndex.set(0);
    if (!this.filtered().length) this.close();
  }

  autocompleteOptionId(option: ComposerAutocompleteOption): string {
    return option.type === 'session'
      ? `session:${option.item.sessionId}`
      : `provider:${option.item.id}`;
  }

  apply(option: ComposerAutocompleteOption | undefined): void {
    const ta = this.ta.nativeElement;
    if (!ta || !option || !this.range) return;
    const { start, end } = this.range;
    const insertText = option.type === 'provider' ? option.item.insertText : '';
    const next = `${ta.value.slice(0, start)}${insertText}${ta.value.slice(end)}`;
    const caret = start + insertText.length;
    this.valueChange.emit(next);
    if (option.type === 'session') this.requestSessionMention.emit(option.item.sessionId);
    this.close();
    queueMicrotask(() => {
      ta.value = next;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      this.autoGrow(ta);
    });
  }

  submit(): void {
    const v = this.value().trim();
    const images = this.allowImages() ? this.attachedImages() : [];
    const diffMentions = this.diffMentions();
    const sessionMentions = this.sessionMentions();
    if (!v && !images.length && !diffMentions.length && !sessionMentions.length) return;
    if (this.blockedByPermission()) return;
    if (this.submitting() && !this.queueing()) return;
    this.send.emit({
      text: v,
      images,
      diffMentions,
      ...(sessionMentions.length ? { sessionMentions } : {}),
    });
    this.setAttachedImages([]);
  }

  mentionLineLabel(mention: DiffSelectionMention): string {
    return diffSelectionMentionLineLabel(mention);
  }

  mentionDirname(mention: DiffSelectionMention): string {
    return splitFilePathForDisplay(mention.filePath).dirname;
  }

  mentionBasename(mention: DiffSelectionMention): string {
    return splitFilePathForDisplay(mention.filePath).basename;
  }

  mentionPreview(mention: DiffSelectionMention): string {
    return diffSelectionMentionPreview(mention);
  }

  pendingPromptPreview(prompt: string): string {
    const sessions = parseSessionMentions(prompt);
    const parsed = parseDiffSelectionMentions(sessions.text);
    const text =
      parsed.text ||
      (sessions.mentions.length
        ? 'Use the mentioned session context.'
        : parsed.mentions.length
          ? 'Review the mentioned diff selection.'
          : prompt);
    const labels: string[] = [];
    if (sessions.mentions.length) {
      labels.push(`${sessions.mentions.length} session mention${sessions.mentions.length === 1 ? '' : 's'}`);
    }
    if (parsed.mentions.length) {
      labels.push(`${parsed.mentions.length} diff mention${parsed.mentions.length === 1 ? '' : 's'}`);
    }
    return labels.length ? `${text} · ${labels.join(' · ')}` : text;
  }

  removeImage(id: string): void {
    this.setAttachedImages(this.attachedImages().filter((i) => i.id !== id));
  }

  openFilePicker(): void {
    if (!this.allowImages()) return;
    this.fileInput?.nativeElement?.click();
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!this.allowImages()) {
      input.value = '';
      return;
    }
    const files = input.files;
    if (files && files.length) {
      void this.ingestFiles(Array.from(files));
    }
    input.value = '';
  }

  onPaste(event: ClipboardEvent): void {
    if (!this.allowImages()) return;
    const items = event.clipboardData?.items;
    if (!items || !items.length) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    void this.ingestFiles(files);
  }

  onDragEnter(event: DragEvent): void {
    if (!this.hasSupportedDropData(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.isDropTarget.set(true);
  }

  onDragOver(event: DragEvent): void {
    if (!this.hasSupportedDropData(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  onDragLeave(event: DragEvent): void {
    if (!this.isDropTarget()) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.isDropTarget.set(false);
  }

  onDrop(event: DragEvent): void {
    if (!this.hasSupportedDropData(event)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDropTarget.set(false);
    const sessionId = Number(event.dataTransfer?.getData(SESSION_MENTION_DRAG_TYPE));
    if (Number.isInteger(sessionId) && sessionId > 0) {
      this.requestSessionMention.emit(sessionId);
      return;
    }
    if (!this.allowImages()) return;
    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    void this.ingestFiles(imageFiles);
  }

  private hasSupportedDropData(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === SESSION_MENTION_DRAG_TYPE) return true;
    }
    return this.allowImages() && this.hasImageData(event);
  }

  private hasImageData(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  private async ingestFiles(files: File[]): Promise<void> {
    if (!this.allowImages()) return;
    const existingTotal = this.attachedImages().reduce((sum, i) => sum + i.size, 0);
    let runningTotal = existingTotal;
    const accepted: ComposerImageAttachment[] = [];
    for (const file of files) {
      const mediaType = file.type as ComposerImageMediaType;
      if (!COMPOSER_IMAGE_ALLOWED_MIME.includes(mediaType)) {
        toast.error(`Unsupported image type: ${file.type || 'unknown'}.`);
        continue;
      }
      if (file.size > COMPOSER_IMAGE_MAX_BYTES) {
        toast.error(`${file.name || 'Image'} is larger than 5 MB.`);
        continue;
      }
      if (runningTotal + file.size > COMPOSER_IMAGE_MAX_TOTAL_BYTES) {
        toast.error('Attached images would exceed the 20 MB total limit.');
        break;
      }
      try {
        const dataUrl = await this.readFileAsDataUrl(file);
        accepted.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || 'pasted-image',
          mediaType,
          dataUrl,
          size: file.size,
        });
        runningTotal += file.size;
      } catch {
        toast.error(`Could not read ${file.name || 'image'}.`);
      }
    }
    if (accepted.length) {
      this.setAttachedImages([...this.attachedImages(), ...accepted]);
    }
  }

  private setAttachedImages(images: ComposerImageAttachment[]): void {
    this.attachedImages.set(images);
    this.imageAttachmentsChange.emit(images);
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') resolve(result);
        else reject(new Error('Unexpected FileReader result'));
      };
      reader.readAsDataURL(file);
    });
  }

  focus(): void {
    this.ta.nativeElement?.focus();
  }

  focusAtEnd(): void {
    queueMicrotask(() => {
      const textarea = this.ta.nativeElement;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      this.autoGrow(textarea);
    });
  }

  private autoGrow(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 256) + 'px';
  }

  private close(): void {
    this.range = null;
    this.autocompleteOpen.set(false);
    this.activeTrigger.set(null);
    this.activeQuery.set('');
    this.selectedIndex.set(0);
  }

  onDocumentMousedown(event: MouseEvent): void {
    if (!this.autocompleteOpen()) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.contains(target)) return;
    this.close();
  }
}

function score(item: ClaudeAutocompleteItem, query: string): number {
  if (!query) return item.source === 'builtin' ? 200 : 100;
  const label = item.label.toLowerCase();
  if (label === `${item.trigger}${query}`) return 500;
  if (label.startsWith(`${item.trigger}${query}`)) return 400;
  if (label.includes(query)) return 300;
  if ((item.description || '').toLowerCase().includes(query)) return 200;
  return Number.NEGATIVE_INFINITY;
}

function scoreSession(item: SessionMentionCandidate, query: string): number {
  if (!query) return item.status === 'active' ? 250 : 150;
  const title = item.title.toLowerCase();
  const branch = item.branch.toLowerCase();
  if (`${item.sessionId}` === query) return 600;
  if (title === query) return 500;
  if (title.startsWith(query)) return 400;
  if (title.includes(query)) return 300;
  if (branch.includes(query)) return 200;
  return Number.NEGATIVE_INFINITY;
}

function sameImages(
  left: readonly ComposerImageAttachment[],
  right: readonly ComposerImageAttachment[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((image, index) => {
    const other = right[index];
    return (
      image.id === other.id &&
      image.name === other.name &&
      image.mediaType === other.mediaType &&
      image.dataUrl === other.dataUrl &&
      image.size === other.size
    );
  });
}
