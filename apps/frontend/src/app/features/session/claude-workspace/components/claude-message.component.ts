import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideCheck,
  lucideCopy,
  lucideExternalLink,
  lucideFileCode,
  lucideFileText,
  lucideGitFork,
  lucideInfo,
  lucidePencil,
  lucidePlus,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { ClaudeTranscriptItem } from '@/shared/models/claude-runtime.model';
import type { SessionFork } from '@/shared/models/session.model';
import { MarkdownPipe } from '../pipes/markdown.pipe';
import { hasProposedPlan } from '../util/proposed-plan';
import { PlanReviewRequest } from '@/features/plan-annotator';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import {
  diffSelectionMentionLineLabel,
  diffSelectionMentionPreview,
  parseDiffSelectionMentions,
} from '@/shared/utils/diff-selection-mention';
import { splitFilePathForDisplay } from '@/shared/utils/file-path-display';

@Component({
  selector: 'cw-message',
  standalone: true,
  imports: [CommonModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronDown,
      lucideCheck,
      lucideCopy,
      lucideExternalLink,
      lucideFileCode,
      lucideFileText,
      lucideGitFork,
      lucideInfo,
      lucidePencil,
      lucidePlus,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  template: `
    @switch (item().kind) {
      @case ('user') {
        <div
          class="cw-msg cw-msg--user"
          [class.cw-msg--armed]="editArmed()"
          [attr.title]="timestampTitle()"
        >
          <div class="cw-msg__body">
            <div class="cw-msg__bubble">
              @if (userMessageText(); as text) {
                <div class="cw-msg__user-text">{{ text }}</div>
              }
              @if (userDiffMentions().length) {
                <div class="cw-msg__mentions" aria-label="Mentioned diff selections">
                  @for (mention of userDiffMentions(); track mention.id) {
                    <article class="cw-msg__mention">
                      <span class="cw-msg__mention-icon" aria-hidden="true">
                        <ng-icon name="lucideFileCode" size="14" />
                      </span>
                      <div class="cw-msg__mention-body">
                        <div class="cw-msg__mention-head">
                          <span class="cw-msg__mention-path" [title]="mention.filePath">
                            @if (mentionDirname(mention); as dirname) {
                              <span class="cw-msg__mention-dir">{{ dirname }}</span>
                              <span class="cw-msg__mention-slash" aria-hidden="true">/</span>
                            }
                            <strong class="cw-msg__mention-name">{{
                              mentionBasename(mention)
                            }}</strong>
                          </span>
                          <span class="cw-msg__mention-lines">{{ mentionLineLabel(mention) }}</span>
                        </div>
                        <p class="cw-msg__mention-preview">{{ mentionPreview(mention) }}</p>
                        <span class="cw-msg__mention-meta">
                          {{ mention.status }} ·
                          {{ mention.context.before.length + mention.context.after.length }} context
                          lines{{ mention.truncated ? ' · truncated' : '' }}
                        </span>
                      </div>
                    </article>
                  }
                </div>
              }
            </div>
            @if (timestampLabel() || hasInlineAffordances()) {
              <div class="cw-msg__meta-row">
                @if (showCopy() || showEdit() || showFork()) {
                  <div class="cw-msg__actions">
                    @if (showCopy()) {
                      <button
                        type="button"
                        class="cw-msg__action"
                        data-cw-edit-action
                        title="Copy message"
                        aria-label="Copy message"
                        (mousedown)="preserveSelection($event)"
                        (click)="copy.emit(getSelectedText())"
                      >
                        <ng-icon name="lucideCopy" size="12" />
                      </button>
                    }
                    @if (showFork()) {
                      <button
                        type="button"
                        class="cw-msg__action"
                        data-cw-edit-action
                        [title]="forkDisabled() ? forkDisabledReason() : 'Fork from here'"
                        aria-label="Fork from here"
                        [disabled]="forkDisabled()"
                        (click)="fork.emit()"
                      >
                        @if (forking()) {
                          <span class="cw-msg__spinner"></span>
                        } @else {
                          <ng-icon name="lucideGitFork" size="12" />
                        }
                      </button>
                    }
                    @if (showEdit()) {
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
                    }
                  </div>
                }
                @if (forks().length) {
                  <button
                    type="button"
                    class="cw-msg__fork-marker"
                    [attr.aria-expanded]="forksExpanded()"
                    (click)="toggleForks.emit()"
                  >
                    <ng-icon name="lucideGitFork" size="11" />
                    <span>{{ forkCountLabel() }}</span>
                    <ng-icon
                      class="cw-msg__fork-chevron"
                      [class.cw-msg__fork-chevron--open]="forksExpanded()"
                      name="lucideChevronDown"
                      size="11"
                    />
                  </button>
                }
                @if (timestampLabel(); as label) {
                  <div class="cw-msg__meta" aria-hidden="true">{{ label }}</div>
                }
              </div>
            }
          </div>
          @if (forksExpanded()) {
            <div class="cw-msg__fork-panel">
              @for (fork of forks(); track fork.id) {
                <div class="cw-msg__fork-row">
                  <div class="cw-msg__fork-copy">
                    <span class="cw-msg__fork-name">{{
                      fork.childSession?.name || 'Session ' + fork.childSessionId
                    }}</span>
                    <span class="cw-msg__fork-meta"
                      >{{ fork.childSession?.status || 'deleted' }} ·
                      {{ forkTimeLabel(fork) }}</span
                    >
                  </div>
                  <button
                    type="button"
                    class="cw-msg__fork-open"
                    [disabled]="!fork.childSession"
                    (click)="openFork.emit(fork)"
                  >
                    <ng-icon name="lucideExternalLink" size="12" />
                    Open
                  </button>
                </div>
              }
              @if (showFork()) {
                <button
                  type="button"
                  class="cw-msg__fork-again"
                  [disabled]="forkDisabled()"
                  (click)="forkAgain.emit()"
                >
                  <ng-icon name="lucidePlus" size="12" />
                  Fork again
                </button>
              }
            </div>
          }
          @if (editArmed()) {
            <div class="cw-msg__confirm" data-cw-edit-confirm-root>
              <p class="cw-msg__confirm-copy">
                Rewind to this message? This message and everything after it will be removed. The
                prompt will be restored to the composer.
              </p>
            </div>
          }
        </div>
      }
      @case ('assistant') {
        <div class="cw-msg cw-msg--assistant" [attr.title]="timestampTitle()">
          <div class="cw-msg__body">
            @if (item().content) {
              @if (planReview(); as review) {
                <section
                  class="cw-plan-launcher"
                  [attr.data-disabled]="!planReviewEnabled() || null"
                >
                  <div class="cw-plan-launcher__copy">
                    <span class="cw-plan-launcher__icon" aria-hidden="true">
                      <ng-icon name="lucideFileText" size="15" />
                    </span>
                    <div class="cw-plan-launcher__text">
                      <span class="cw-plan-launcher__eyebrow">
                        {{ review.provider === 'codex' ? 'Codex' : 'Claude Code' }} plan
                      </span>
                      <strong>Plan ready for review</strong>
                      @if (!planReviewEnabled()) {
                        <span>Review is available when the session is idle.</span>
                      } @else {
                        <span
                          >Open the annotator to read, comment, approve, or request changes.</span
                        >
                      }
                    </div>
                  </div>
                  <button
                    type="button"
                    class="cw-plan-launcher__button"
                    [disabled]="!planReviewEnabled()"
                    (click)="openPlanReview.emit(review)"
                  >
                    Review plan
                  </button>
                </section>
              } @else if (streaming()) {
                <div class="cw-md cw-md--streaming" [innerHTML]="item().content | cwMarkdown"></div>
                <span class="cw-caret"></span>
              } @else {
                <div class="cw-md" [innerHTML]="item().content | cwMarkdown"></div>
              }
            } @else if (streaming()) {
              <span class="cw-caret cw-caret--waiting"></span>
            }
            @if (timestampLabel() || hasInlineAffordances()) {
              <div class="cw-msg__meta-row">
                @if (showCopy() || showFork()) {
                  <div class="cw-msg__actions">
                    @if (showCopy()) {
                      <button
                        type="button"
                        class="cw-msg__action"
                        title="Copy message"
                        aria-label="Copy message"
                        (mousedown)="preserveSelection($event)"
                        (click)="copy.emit(getSelectedText())"
                      >
                        <ng-icon name="lucideCopy" size="12" />
                      </button>
                    }
                    @if (showFork()) {
                      <button
                        type="button"
                        class="cw-msg__action"
                        [title]="forkDisabled() ? forkDisabledReason() : 'Fork from here'"
                        aria-label="Fork from here"
                        [disabled]="forkDisabled()"
                        (click)="fork.emit()"
                      >
                        @if (forking()) {
                          <span class="cw-msg__spinner"></span>
                        } @else {
                          <ng-icon name="lucideGitFork" size="12" />
                        }
                      </button>
                    }
                  </div>
                }
                @if (forks().length) {
                  <button
                    type="button"
                    class="cw-msg__fork-marker"
                    [attr.aria-expanded]="forksExpanded()"
                    (click)="toggleForks.emit()"
                  >
                    <ng-icon name="lucideGitFork" size="11" />
                    <span>{{ forkCountLabel() }}</span>
                    <ng-icon
                      class="cw-msg__fork-chevron"
                      [class.cw-msg__fork-chevron--open]="forksExpanded()"
                      name="lucideChevronDown"
                      size="11"
                    />
                  </button>
                }
                @if (timestampLabel(); as label) {
                  <div class="cw-msg__meta" aria-hidden="true">{{ label }}</div>
                }
              </div>
            }
            @if (forksExpanded()) {
              <div class="cw-msg__fork-panel">
                @for (fork of forks(); track fork.id) {
                  <div class="cw-msg__fork-row">
                    <div class="cw-msg__fork-copy">
                      <span class="cw-msg__fork-name">{{
                        fork.childSession?.name || 'Session ' + fork.childSessionId
                      }}</span>
                      <span class="cw-msg__fork-meta"
                        >{{ fork.childSession?.status || 'deleted' }} ·
                        {{ forkTimeLabel(fork) }}</span
                      >
                    </div>
                    <button
                      type="button"
                      class="cw-msg__fork-open"
                      [disabled]="!fork.childSession"
                      (click)="openFork.emit(fork)"
                    >
                      <ng-icon name="lucideExternalLink" size="12" />
                      Open
                    </button>
                  </div>
                }
                @if (showFork()) {
                  <button
                    type="button"
                    class="cw-msg__fork-again"
                    [disabled]="forkDisabled()"
                    (click)="forkAgain.emit()"
                  >
                    <ng-icon name="lucidePlus" size="12" />
                    Fork again
                  </button>
                }
              </div>
            }
          </div>
        </div>
      }
      @case ('system') {
        <details class="cw-msg cw-msg--diagnostic cw-msg--system" [attr.title]="timestampTitle()">
          <summary class="cw-msg__diag-summary">
            <ng-icon name="lucideInfo" size="13" />
            <span class="cw-msg__diag-title">{{ diagnosticTitle() }}</span>
            <span class="cw-msg__diag-preview">{{ diagnosticPreview() }}</span>
            @if (timestampLabel(); as label) {
              <span class="cw-msg__meta" aria-hidden="true">{{ label }}</span>
            }
          </summary>
          <pre class="cw-msg__diag-body">{{ item().content }}</pre>
        </details>
      }
      @case ('error') {
        <details class="cw-msg cw-msg--diagnostic cw-msg--error" [attr.title]="timestampTitle()">
          <summary class="cw-msg__diag-summary">
            <ng-icon name="lucideTriangleAlert" size="13" />
            <span class="cw-msg__diag-title">{{ diagnosticTitle() }}</span>
            <span class="cw-msg__diag-preview">{{ diagnosticPreview() }}</span>
            @if (timestampLabel(); as label) {
              <span class="cw-msg__meta" aria-hidden="true">{{ label }}</span>
            }
          </summary>
          <pre class="cw-msg__diag-body">{{ item().content }}</pre>
        </details>
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
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
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
      .cw-msg__user-text {
        white-space: pre-wrap;
      }
      .cw-msg__mentions {
        display: grid;
        gap: 0.4rem;
        width: min(100%, 34rem);
        white-space: normal;
      }
      .cw-msg__mention {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0.55rem;
        align-items: start;
        padding: 0.55rem;
        border: 1px solid color-mix(in oklab, var(--primary) 24%, var(--border));
        border-radius: 0.65rem;
        background: color-mix(in oklab, var(--background) 76%, transparent);
      }
      .cw-msg__mention-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.55rem;
        height: 1.55rem;
        border-radius: 0.45rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--primary);
      }
      .cw-msg__mention-body {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
      }
      .cw-msg__mention-head {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        min-width: 0;
      }
      .cw-msg__mention-path {
        display: inline-flex;
        align-items: baseline;
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.74rem;
      }
      .cw-msg__mention-dir {
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
      .cw-msg__mention-slash {
        flex: 0 0 auto;
        padding: 0 0.08rem;
        color: var(--muted-foreground);
        font-weight: 500;
      }
      .cw-msg__mention-name {
        max-width: 100%;
        flex: 0 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--foreground);
        font-weight: 800;
      }
      .cw-msg__mention-lines {
        flex-shrink: 0;
        border-radius: 999px;
        padding: 0.08rem 0.38rem;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        color: var(--muted-foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.64rem;
        font-weight: 700;
      }
      .cw-msg__mention-preview {
        margin: 0;
        overflow: hidden;
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cw-msg__mention-meta {
        color: var(--muted-foreground);
        font-size: 0.67rem;
        line-height: 1.25;
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
      .cw-msg__spinner {
        width: 0.75rem;
        height: 0.75rem;
        border: 1.5px solid color-mix(in oklab, var(--primary) 35%, transparent);
        border-top-color: var(--primary);
        border-radius: 999px;
        animation: cw-spin 650ms linear infinite;
      }
      .cw-msg__fork-marker {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        height: 1.55rem;
        border: 1px solid color-mix(in oklab, var(--border) 84%, transparent);
        border-radius: 999px;
        background: color-mix(in oklab, var(--background) 78%, transparent);
        color: color-mix(in oklab, var(--muted-foreground) 92%, transparent);
        padding: 0 0.5rem;
        font: inherit;
        font-size: 0.68rem;
        font-weight: 650;
        cursor: pointer;
        transition:
          border-color 140ms ease,
          background-color 140ms ease,
          color 140ms ease;
      }
      .cw-msg__fork-marker:hover,
      .cw-msg__fork-marker:focus-visible,
      .cw-msg__fork-marker[aria-expanded='true'] {
        outline: none;
        border-color: color-mix(in oklab, var(--primary) 32%, var(--border));
        background: color-mix(in oklab, var(--primary) 7%, var(--background));
        color: var(--foreground);
      }
      .cw-msg__fork-chevron {
        transition: transform 140ms ease;
      }
      .cw-msg__fork-chevron--open {
        transform: rotate(180deg);
      }
      .cw-msg__fork-panel {
        display: grid;
        gap: 0.35rem;
        width: min(100%, 28rem);
        margin-top: 0.35rem;
        padding: 0.45rem;
        border: 1px solid color-mix(in oklab, var(--primary) 20%, var(--border));
        border-radius: 0.7rem;
        background: color-mix(in oklab, var(--card) 92%, var(--background));
        box-shadow: 0 12px 28px -24px color-mix(in oklab, var(--foreground) 44%, transparent);
      }
      .cw-msg--user .cw-msg__fork-panel {
        align-self: flex-end;
      }
      .cw-msg__fork-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.6rem;
        min-width: 0;
        border-radius: 0.5rem;
        padding: 0.38rem 0.45rem;
        background: color-mix(in oklab, var(--foreground) 3%, transparent);
      }
      .cw-msg__fork-copy {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .cw-msg__fork-name {
        overflow: hidden;
        color: var(--foreground);
        font-size: 0.76rem;
        font-weight: 700;
        line-height: 1.25;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cw-msg__fork-meta {
        color: var(--muted-foreground);
        font-size: 0.66rem;
        line-height: 1.25;
      }
      .cw-msg__fork-open,
      .cw-msg__fork-again {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.3rem;
        height: 1.55rem;
        border: 1px solid var(--border);
        border-radius: 0.45rem;
        background: var(--background);
        color: var(--foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.7rem;
        font-weight: 700;
        padding: 0 0.5rem;
        white-space: nowrap;
      }
      .cw-msg__fork-open:hover:not(:disabled),
      .cw-msg__fork-open:focus-visible,
      .cw-msg__fork-again:hover:not(:disabled),
      .cw-msg__fork-again:focus-visible {
        outline: none;
        border-color: color-mix(in oklab, var(--primary) 38%, var(--border));
        background: color-mix(in oklab, var(--primary) 8%, var(--background));
      }
      .cw-msg__fork-open:disabled,
      .cw-msg__fork-again:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .cw-msg__fork-again {
        justify-self: end;
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
      .cw-plan-launcher {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.85rem;
        width: min(100%, 42rem);
        border: 1px solid color-mix(in oklab, var(--primary) 28%, var(--border));
        border-radius: 0.7rem;
        background: color-mix(in oklab, var(--primary) 6%, var(--card));
        padding: 0.8rem;
      }
      .cw-plan-launcher[data-disabled='true'] {
        border-color: var(--border);
        background: color-mix(in oklab, var(--muted) 28%, var(--card));
      }
      .cw-plan-launcher__copy {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        min-width: 0;
      }
      .cw-plan-launcher__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        color: var(--primary);
        flex-shrink: 0;
      }
      .cw-plan-launcher__text {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        min-width: 0;
      }
      .cw-plan-launcher__eyebrow {
        font-size: 0.66rem;
        line-height: 1.2;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }
      .cw-plan-launcher__text strong {
        color: var(--foreground);
        font-size: 0.9rem;
        line-height: 1.3;
      }
      .cw-plan-launcher__text span:last-child {
        color: var(--muted-foreground);
        font-size: 0.78rem;
        line-height: 1.4;
      }
      .cw-plan-launcher__button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 2rem;
        border: 1px solid var(--primary);
        border-radius: 0.45rem;
        background: var(--primary);
        color: var(--primary-foreground);
        cursor: pointer;
        font: inherit;
        font-size: 0.78rem;
        font-weight: 700;
        padding: 0 0.75rem;
        white-space: nowrap;
      }
      .cw-plan-launcher__button:hover:not(:disabled),
      .cw-plan-launcher__button:focus-visible {
        outline: none;
        background: color-mix(in oklab, var(--primary) 88%, var(--foreground));
      }
      .cw-plan-launcher__button:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .cw-msg--diagnostic {
        font-size: 0.75rem;
        max-width: min(100%, 100ch);
        border: 1px solid var(--border);
        border-radius: 0.375rem;
        background: color-mix(in oklab, var(--foreground) 3%, transparent);
        color: var(--muted-foreground);
      }
      .cw-msg--error {
        background: color-mix(in oklab, var(--destructive) 8%, transparent);
        border-color: color-mix(in oklab, var(--destructive) 35%, var(--border));
        color: var(--destructive);
      }
      .cw-msg__diag-summary {
        display: grid;
        grid-template-columns: auto auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.375rem;
        min-height: 1.65rem;
        padding: 0.1875rem 0.5rem;
        cursor: pointer;
        list-style: none;
      }
      .cw-msg__diag-summary::-webkit-details-marker {
        display: none;
      }
      .cw-msg__diag-title {
        font-weight: 600;
        color: var(--foreground);
      }
      .cw-msg--error .cw-msg__diag-title {
        color: var(--destructive);
      }
      .cw-msg__diag-preview {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .cw-msg__diag-body {
        margin: 0;
        padding: 0.5rem 0.625rem 0.625rem;
        border-top: 1px solid var(--border);
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
        line-height: 1.55;
        max-height: 14rem;
        overflow: auto;
      }
      .cw-md :first-child {
        margin-top: 0;
      }
      .cw-md :last-child {
        margin-bottom: 0;
      }
      .cw-md--streaming {
        word-break: break-word;
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
      @keyframes cw-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class ClaudeMessageComponent {
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly item = input.required<ClaudeTranscriptItem>();
  readonly streaming = input<boolean>(false);
  readonly showActions = input<boolean>(false);
  readonly showCopy = input<boolean>(false);
  readonly showEdit = input<boolean>(false);
  readonly showFork = input<boolean>(false);
  readonly actionsDisabled = input<boolean>(false);
  readonly editArmed = input<boolean>(false);
  readonly forkDisabled = input<boolean>(false);
  readonly forkDisabledReason = input<string>('');
  readonly forking = input<boolean>(false);
  readonly forks = input<SessionFork[]>([]);
  readonly forksExpanded = input<boolean>(false);
  readonly planReviewEnabled = input<boolean>(false);
  readonly planReview = input<PlanReviewRequest | null>(null);

  readonly copy = output<string | null>();
  readonly fork = output<void>();
  readonly armEdit = output<void>();
  readonly confirmEdit = output<void>();
  readonly cancelEdit = output<void>();
  readonly toggleForks = output<void>();
  readonly openFork = output<SessionFork>();
  readonly forkAgain = output<void>();
  readonly approvePlan = output<void>();
  readonly planFeedback = output<string>();
  readonly openPlanReview = output<PlanReviewRequest>();

  readonly isEmpty = computed(() => !this.item().content);
  readonly hasInlineAffordances = computed(
    () => this.showCopy() || this.showEdit() || this.showFork() || this.forks().length > 0,
  );
  readonly forkCountLabel = computed(() => {
    const count = this.forks().length;
    return `${count} fork${count === 1 ? '' : 's'}`;
  });
  readonly timestampLabel = computed(() => buildTimestampLabel(this.item(), this.streaming()));
  readonly timestampTitle = computed(() => this.timestampLabel());
  readonly isProposedPlan = computed(() => hasProposedPlan(this.item().content));
  readonly diagnosticTitle = computed(() => {
    const item = this.item();
    if (item.kind === 'error') {
      return isWarningText(item.content) ? 'Warning' : 'Error';
    }
    return isWarningText(item.content) ? 'Warning' : 'System';
  });
  readonly diagnosticPreview = computed(() => {
    const content = this.item().content?.trim().replace(/\s+/g, ' ') ?? '';
    if (!content) return 'No details';
    return content.length > 180 ? `${content.slice(0, 180)}...` : content;
  });
  readonly userMessageDisplay = computed(() => parseDiffSelectionMentions(this.item().content));
  readonly userMessageText = computed(() => this.userMessageDisplay().text);
  readonly userDiffMentions = computed(() => this.userMessageDisplay().mentions);

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

  forkTimeLabel(fork: SessionFork): string {
    return formatTimestamp(fork.createdAt);
  }

  preserveSelection(event: MouseEvent): void {
    event.preventDefault();
  }

  getSelectedText(): string | null {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const selectedText = selection.toString().trim();
    if (!selectedText) return null;

    const host = this.elementRef.nativeElement;
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode) return null;
    if (!host.contains(anchorNode) || !host.contains(focusNode)) return null;

    return selectedText;
  }
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
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

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
  const dateLabel = sameYear ? `${day}/${month}` : `${day}/${month}/${date.getFullYear()}`;

  return `${dateLabel} ${timeLabel}`;
}

function isWarningText(value: string | undefined): boolean {
  return /\b(warn(?:ing)?|deprecated|ignoring|malformed|invalid config)\b/i.test(value ?? '');
}
