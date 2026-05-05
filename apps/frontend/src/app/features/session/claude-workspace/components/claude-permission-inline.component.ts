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
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import DOMPurify from 'dompurify';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideShield,
  lucideMessageCircleQuestion,
  lucideClipboardList,
  lucideCheck,
  lucideCheckCheck,
  lucideChevronLeft,
  lucideX,
} from '@ng-icons/lucide';
import {
  ClaudePermissionApproval,
  ClaudePermissionRequest,
  ClaudePermissionUpdate,
} from '@/shared/models/claude-runtime.model';
import { MarkdownPipe } from '../pipes/markdown.pipe';
import { normalizeToolName as normalizeToolNameForUi } from '../util/tool-format';
import { highlightedDiffHtml } from '../util/code-highlight';

interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

interface AlwaysAllowPattern {
  label: string;
  pattern: string;
  detail: string;
}

@Component({
  selector: 'cw-permission-inline',
  standalone: true,
  imports: [CommonModule, FormsModule, MarkdownPipe, NgIcon],
  viewProviders: [
    provideIcons({
      lucideShield,
      lucideMessageCircleQuestion,
      lucideClipboardList,
      lucideCheck,
      lucideCheckCheck,
      lucideChevronLeft,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cw-perm" [attr.data-kind]="kind()" [class.cw-perm--dock]="appearance() === 'dock'">
      @switch (kind()) {
        @case ('ask_user_question') {
          <header class="cw-perm__head">
            <span class="cw-perm__icon" aria-hidden="true">
              <ng-icon name="lucideMessageCircleQuestion" size="13" />
            </span>
            <span class="cw-perm__eyebrow">Input needed</span>
            @if (request().agentId) {
              <span class="cw-perm__agent" title="Delegated subagent">Subagent · {{ request().agentId }}</span>
            }
          </header>
          <h3 class="cw-perm__title">{{ request().title || 'Claude needs your input' }}</h3>
          @if (request().description) {
            <p class="cw-perm__sub">{{ request().description }}</p>
          }

          <div class="cw-ask">
            <div class="cw-ask__nav">
              <span class="cw-ask__progress">{{ askProgressLabel() }}</span>
            </div>

            @if (isAskReviewing()) {
              <section class="cw-ask__recap" aria-label="Review answers">
                @for (question of questions(); track question.question) {
                  <div class="cw-ask__recap-item">
                    <span class="cw-ask__recap-question">{{ question.question }}</span>
                    <span class="cw-ask__recap-answer">{{ serializeAnswer(question) }}</span>
                  </div>
                }
              </section>
            } @else if (activeQuestion(); as question) {
              <section class="cw-ask__q">
                <div class="cw-ask__qhead">
                  @if (question.header) {
                    <span class="cw-ask__chip">{{ question.header }}</span>
                  }
                  <span class="cw-ask__qtext">{{ question.question }}</span>
                </div>

                <div class="cw-ask__options">
                  @for (option of question.options; track option.label) {
                    <label class="cw-ask__opt" [class.cw-ask__opt--on]="isSelected(question, option.label)">
                      <input
                        [type]="question.multiSelect ? 'checkbox' : 'radio'"
                        [name]="question.question"
                        [checked]="isSelected(question, option.label)"
                        (change)="toggleOption(question, option.label, $any($event.target).checked)"
                      />
                      <span class="cw-ask__opt-body">
                        <span class="cw-ask__opt-label">{{ option.label }}</span>
                        @if (option.description) {
                          <span class="cw-ask__opt-desc">{{ option.description }}</span>
                        }
                      </span>
                    </label>
                  }

                  <label class="cw-ask__opt" [class.cw-ask__opt--on]="isOtherSelected(question)">
                    <input
                      [type]="question.multiSelect ? 'checkbox' : 'radio'"
                      [name]="question.question"
                      [checked]="isOtherSelected(question)"
                      (change)="toggleOther(question, $any($event.target).checked)"
                    />
                    <span class="cw-ask__opt-body">
                      <span class="cw-ask__opt-label">Other...</span>
                    </span>
                  </label>

                  @if (isOtherSelected(question)) {
                    <textarea
                      #otherTa
                      class="cw-ask__other"
                      [ngModel]="otherAnswers()[question.question] || ''"
                      (ngModelChange)="setOtherAnswer(question.question, $event)"
                      placeholder="Type your answer"
                    ></textarea>
                  }
                </div>

                @if (selectedPreview(question); as preview) {
                  <div class="cw-perm__preview cw-perm__preview--md" [innerHTML]="preview | cwMarkdown"></div>
                }
              </section>
            }
          </div>

          @if (!denying()) {
            <footer class="cw-perm__actions">
              <button type="button" class="cw-btn cw-btn--deny" (click)="startDeny()">
                <ng-icon name="lucideX" size="13" aria-hidden="true" />
                Decline
              </button>
              <span class="cw-perm__spacer"></span>
              @if (canGoBack()) {
                <button type="button" class="cw-btn cw-btn--secondary" (click)="goBack()">
                  <ng-icon name="lucideChevronLeft" size="13" aria-hidden="true" />
                  Back
                </button>
              }
              @if (showAskNextButton()) {
                <button
                  type="button"
                  class="cw-btn cw-btn--primary"
                  [disabled]="!canAdvanceActiveQuestion()"
                  (click)="advanceAskFlow()"
                >
                  <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
                  Next
                </button>
              }
              @if (isAskReviewing()) {
                <button
                  type="button"
                  class="cw-btn cw-btn--primary"
                  [disabled]="!canSubmitQuestions()"
                  (click)="submitQuestions()"
                >
                  <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
                  Submit
                </button>
              }
            </footer>
          }
        }

        @case ('enter_plan_mode') {
          <header class="cw-perm__head">
            <span class="cw-perm__icon" aria-hidden="true">
              <ng-icon name="lucideClipboardList" size="13" />
            </span>
            <span class="cw-perm__eyebrow">Plan mode</span>
          </header>
          <h3 class="cw-perm__title">{{ request().title || 'Enter plan mode?' }}</h3>
          <p class="cw-perm__sub">
            Claude will stay read-only, explore the codebase, and prepare a plan before editing.
          </p>
          @if (!denying()) {
            <footer class="cw-perm__actions">
              <button type="button" class="cw-btn cw-btn--deny" (click)="startDeny()">
                <ng-icon name="lucideX" size="13" aria-hidden="true" />
                Not now
              </button>
              <button type="button" class="cw-btn cw-btn--primary" (click)="approve.emit({ remember: false })">
                <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
                Start planning
              </button>
            </footer>
          }
        }

        @case ('exit_plan_mode') {
          <header class="cw-perm__head">
            <span class="cw-perm__icon" aria-hidden="true">
              <ng-icon name="lucideClipboardList" size="13" />
            </span>
            <span class="cw-perm__eyebrow">Plan ready</span>
            @if (planPath(); as path) {
              <span class="cw-perm__path" [title]="path">{{ path }}</span>
            }
          </header>
          <h3 class="cw-perm__title">{{ request().title || 'Approve plan?' }}</h3>

          @if (planContent(); as plan) {
            <div class="cw-perm__preview cw-perm__preview--md" [innerHTML]="plan | cwMarkdown"></div>
          }

          @if (!denying()) {
            <footer class="cw-perm__actions">
              <button type="button" class="cw-btn cw-btn--deny" (click)="startDeny()">
                <ng-icon name="lucideX" size="13" aria-hidden="true" />
                Keep planning
              </button>
              <button type="button" class="cw-btn cw-btn--primary" (click)="approve.emit({ remember: false })">
                <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
                Approve plan
              </button>
            </footer>
          }
        }

        @default {
          <header class="cw-perm__head">
            <span class="cw-perm__icon" aria-hidden="true">
              <ng-icon name="lucideShield" size="13" />
            </span>
            <span class="cw-perm__eyebrow">Approval required</span>
            <span class="cw-perm__tool">{{ requestToolLabel() }}</span>
            @if (request().agentId) {
              <span class="cw-perm__agent" title="Delegated subagent">Subagent · {{ request().agentId }}</span>
            }
          </header>

          <h3 class="cw-perm__title">{{ requestTitle() }}</h3>
          @if (requestSubline(); as line) {
            <p class="cw-perm__path" [title]="line">{{ line }}</p>
          }
          @if (requestSubtitle(); as sub) {
            <p class="cw-perm__sub">{{ sub }}</p>
          }

          @if (permDiffHtml(); as diff) {
            <pre class="cw-perm__preview cw-perm__preview--code" [innerHTML]="diff"></pre>
          } @else if (permWriteContent()) {
            <pre class="cw-perm__preview cw-perm__preview--code">{{ permWriteContent() }}</pre>
          } @else if (permBashCommand()) {
            <pre class="cw-perm__preview cw-perm__preview--cmd">$ {{ permBashCommand() }}</pre>
          }

          @if (!denying()) {
            <section class="cw-perm__always" [attr.data-has-patterns]="alwaysAllowPatterns().length > 0">
              <div class="cw-perm__always-head">
                <span class="cw-perm__always-kicker">
                  {{ alwaysAllowPatterns().length ? 'Always allow saves this pattern' : 'No always-allow pattern available' }}
                </span>
                @if (!alwaysAllowPatterns().length) {
                  <span class="cw-perm__always-empty">No reusable pattern supplied</span>
                }
              </div>
              @if (alwaysAllowPatterns().length) {
                <div class="cw-perm__patterns">
                  @for (entry of alwaysAllowPatterns(); track entry.pattern + entry.detail) {
                    <div class="cw-perm__pattern">
                      <span class="cw-perm__pattern-label">{{ entry.label }}</span>
                      <code class="cw-perm__pattern-code">{{ entry.pattern }}</code>
                      <span class="cw-perm__pattern-detail">{{ entry.detail }}</span>
                    </div>
                  }
                </div>
              } @else {
                <p class="cw-perm__always-note">
                  Claude did not provide a reusable rule for this tool call, so this request can only be approved once.
                </p>
              }
            </section>

            <footer class="cw-perm__actions">
              <button type="button" class="cw-btn cw-btn--deny" (click)="startDeny()">
                <ng-icon name="lucideX" size="13" aria-hidden="true" />
                Deny
              </button>
              <span class="cw-perm__spacer"></span>
              <button
                type="button"
                class="cw-btn cw-btn--secondary"
                [title]="allowOnceCopy()"
                (click)="approve.emit({ remember: false })"
              >
                <ng-icon name="lucideCheck" size="13" aria-hidden="true" />
                Allow once
              </button>
              @if (alwaysAllowPatterns().length) {
                <button
                  type="button"
                  class="cw-btn cw-btn--primary"
                  [title]="allowAlwaysCopy()"
                  (click)="approve.emit({ remember: true })"
                >
                  <ng-icon name="lucideCheckCheck" size="13" aria-hidden="true" />
                  Always allow
                </button>
              }
            </footer>
          }
        }
      }

      @if (denying()) {
        <div class="cw-perm__deny" role="group" aria-label="Decline with feedback">
          <label class="cw-perm__deny-label" for="cw-perm-deny-msg">
            Tell Claude what to do instead
            <span class="cw-perm__deny-optional">(optional)</span>
          </label>
          <textarea
            #denyTa
            id="cw-perm-deny-msg"
            class="cw-perm__deny-input"
            rows="2"
            [ngModel]="denyMessage()"
            (ngModelChange)="denyMessage.set($event)"
            (keydown)="onDenyKeydown($event)"
            placeholder="e.g. don't run shell commands; ask me first…"
          ></textarea>
          <div class="cw-perm__deny-actions">
            <span class="cw-perm__deny-hint">⌘↵ to send · Esc to cancel</span>
            <button type="button" class="cw-btn cw-btn--ghost" (click)="cancelDeny()">Cancel</button>
            <button type="button" class="cw-btn cw-btn--deny-confirm" (click)="confirmDeny()">
              <ng-icon name="lucideX" size="13" aria-hidden="true" />
              {{ denyMessage().trim() ? 'Send & deny' : 'Deny' }}
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .cw-perm {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem 0.9rem 0.8rem;
        border: 1px solid var(--border);
        border-radius: var(--radius, 0.625rem);
        background: var(--card, var(--background));
        color: var(--card-foreground, var(--foreground));
        font-size: 0.8125rem;
        line-height: 1.45;
      }

      /* Dock variant: snug to composer above it */
      .cw-perm--dock {
        border-bottom: 0;
        border-bottom-left-radius: 0;
        border-bottom-right-radius: 0;
      }

      /* Header */
      .cw-perm__head {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
        min-width: 0;
      }
      .cw-perm__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.35rem;
        height: 1.35rem;
        border-radius: 0.4rem;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        color: var(--foreground);
        flex-shrink: 0;
      }
      .cw-perm__eyebrow {
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }
      .cw-perm__tool {
        font-size: 0.72rem;
        font-weight: 600;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--foreground);
        padding: 0.1rem 0.45rem;
        border-radius: 0.3rem;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
      }
      .cw-perm__agent {
        font-size: 0.7rem;
        color: var(--muted-foreground);
        padding: 0.05rem 0.4rem;
        border-radius: 0.3rem;
        border: 1px dashed color-mix(in oklab, var(--border) 80%, transparent);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Body */
      .cw-perm__title {
        margin: 0.05rem 0 0;
        font-size: 0.9rem;
        font-weight: 600;
        line-height: 1.35;
        color: var(--foreground);
        letter-spacing: -0.005em;
      }
      .cw-perm__sub {
        margin: 0;
        color: var(--muted-foreground);
        font-size: 0.78rem;
        line-height: 1.5;
      }
      .cw-perm__path {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        color: var(--muted-foreground);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
      }

      /* Preview area */
      .cw-perm__preview {
        margin: 0.2rem 0 0;
        padding: 0.55rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--foreground) 3%, var(--background));
        max-height: 12rem;
        overflow: auto;
      }
      .cw-perm__preview--code,
      .cw-perm__preview--cmd {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.7rem;
        line-height: 1.55;
        white-space: pre;
        overflow-x: auto;
        color: var(--foreground);
      }
      .cw-perm__preview--md {
        font-size: 0.8125rem;
        line-height: 1.6;
        max-height: 18rem;
      }
      .cw-perm__preview--md :first-child { margin-top: 0; }
      .cw-perm__preview--md :last-child { margin-bottom: 0; }

      /* Always allow pattern */
      .cw-perm__always {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        margin-top: 0.25rem;
        padding: 0.55rem 0.65rem;
        border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
        border-radius: 0.55rem;
        background: color-mix(in oklab, var(--foreground) 3%, var(--background));
      }
      .cw-perm__always[data-has-patterns='false'] {
        border-style: dashed;
        background: transparent;
      }
      .cw-perm__always-head {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
      }
      .cw-perm__always-kicker {
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }
      .cw-perm__always-empty {
        font-size: 0.68rem;
        color: var(--muted-foreground);
      }
      .cw-perm__patterns {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .cw-perm__pattern {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.45rem;
        min-width: 0;
      }
      .cw-perm__pattern-label {
        font-size: 0.68rem;
        color: var(--muted-foreground);
        white-space: nowrap;
      }
      .cw-perm__pattern-code {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0.18rem 0.4rem;
        border-radius: 0.35rem;
        background: var(--background);
        border: 1px solid color-mix(in oklab, var(--border) 75%, transparent);
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
      }
      .cw-perm__pattern-detail {
        font-size: 0.68rem;
        color: var(--muted-foreground);
        white-space: nowrap;
      }
      .cw-perm__always-note {
        margin: 0;
        color: var(--muted-foreground);
        font-size: 0.72rem;
        line-height: 1.45;
      }

      :host ::ng-deep .cw-diff-del {
        display: block;
        color: oklch(0.45 0.2 20);
        background: color-mix(in oklab, oklch(0.55 0.22 20) 10%, transparent);
      }
      :host ::ng-deep .cw-diff-add {
        display: block;
        color: oklch(0.42 0.18 240);
        background: color-mix(in oklab, oklch(0.52 0.18 240) 10%, transparent);
      }
      :host ::ng-deep .cw-diff-context {
        display: block;
        color: var(--muted-foreground);
      }
      :host-context(.dark) ::ng-deep .cw-diff-del {
        color: oklch(0.78 0.18 20);
        background: color-mix(in oklab, oklch(0.72 0.18 20) 15%, transparent);
      }
      :host-context(.dark) ::ng-deep .cw-diff-add {
        color: oklch(0.75 0.16 240);
        background: color-mix(in oklab, oklch(0.68 0.16 240) 15%, transparent);
      }

      /* Actions */
      .cw-perm__actions {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
        margin-top: 0.35rem;
      }
      .cw-perm__spacer { flex: 1; }

      .cw-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.35rem;
        font: inherit;
        font-size: 0.75rem;
        font-weight: 500;
        line-height: 1;
        padding: 0.4rem 0.75rem;
        border-radius: 0.45rem;
        border: 1px solid var(--border);
        background: var(--background);
        color: var(--foreground);
        cursor: pointer;
        white-space: nowrap;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease;
      }
      .cw-btn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 35%, transparent);
      }
      .cw-btn:active:not(:disabled) {
        transform: translateY(0.5px);
      }
      .cw-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .cw-btn ng-icon {
        flex-shrink: 0;
        opacity: 0.85;
      }

      /* Primary — solid, prominent (Always allow / Submit / Approve) */
      .cw-btn--primary {
        background: var(--primary);
        color: var(--primary-foreground);
        border-color: var(--primary);
      }
      .cw-btn--primary:hover:not(:disabled) {
        background: color-mix(in oklab, var(--primary) 88%, var(--background));
        border-color: color-mix(in oklab, var(--primary) 88%, var(--background));
      }
      .cw-btn--primary ng-icon { opacity: 1; }

      /* Secondary — subtle filled (Allow once) */
      .cw-btn--secondary {
        background: var(--secondary, color-mix(in oklab, var(--foreground) 6%, var(--background)));
        color: var(--secondary-foreground, var(--foreground));
        border-color: transparent;
      }
      .cw-btn--secondary:hover:not(:disabled) {
        background: color-mix(in oklab, var(--foreground) 10%, var(--background));
      }

      /* Deny — destructive ghost on the left */
      .cw-btn--deny {
        background: transparent;
        color: var(--muted-foreground);
        border-color: transparent;
        padding-left: 0.55rem;
        padding-right: 0.55rem;
      }
      .cw-btn--deny:hover:not(:disabled) {
        background: color-mix(in oklab, var(--destructive) 9%, transparent);
        color: var(--destructive);
      }

      /* Confirm-deny — solid destructive */
      .cw-btn--deny-confirm {
        background: var(--destructive);
        color: var(--primary-foreground, #fff);
        border-color: var(--destructive);
      }
      .cw-btn--deny-confirm:hover:not(:disabled) {
        background: color-mix(in oklab, var(--destructive) 88%, var(--background));
        border-color: color-mix(in oklab, var(--destructive) 88%, var(--background));
      }
      .cw-btn--deny-confirm ng-icon { opacity: 1; }

      /* Ghost — minimal */
      .cw-btn--ghost {
        background: transparent;
        border-color: transparent;
        color: var(--muted-foreground);
      }
      .cw-btn--ghost:hover:not(:disabled) {
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--foreground);
      }

      /* Deny composer */
      .cw-perm__deny {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        margin-top: 0.15rem;
        padding: 0.6rem 0.7rem 0.65rem;
        border: 1px solid color-mix(in oklab, var(--destructive) 25%, var(--border));
        border-radius: 0.55rem;
        background: color-mix(in oklab, var(--destructive) 4%, var(--background));
      }
      .cw-perm__deny-label {
        font-size: 0.72rem;
        font-weight: 600;
        color: var(--foreground);
      }
      .cw-perm__deny-optional {
        font-weight: 400;
        color: var(--muted-foreground);
        margin-left: 0.25rem;
      }
      .cw-perm__deny-input {
        min-height: 2.5rem;
        padding: 0.45rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 0.45rem;
        background: var(--background);
        color: inherit;
        font: inherit;
        font-size: 0.8125rem;
        line-height: 1.45;
        resize: vertical;
        outline: none;
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      .cw-perm__deny-input:focus {
        border-color: color-mix(in oklab, var(--destructive) 50%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 18%, transparent);
      }
      .cw-perm__deny-actions {
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      .cw-perm__deny-hint {
        flex: 1;
        font-size: 0.68rem;
        color: var(--muted-foreground);
      }

      /* Ask user question */
      .cw-ask {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        margin-top: 0.15rem;
      }
      .cw-ask__nav {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        min-height: 1rem;
      }
      .cw-ask__progress {
        font-size: 0.68rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted-foreground);
      }
      .cw-ask__q {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
      }
      .cw-ask__qhead {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
      }
      .cw-ask__chip {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 7%, transparent);
        color: var(--muted-foreground);
      }
      .cw-ask__qtext {
        font-size: 0.83rem;
        font-weight: 600;
        line-height: 1.4;
        color: var(--foreground);
      }
      .cw-ask__options {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }
      .cw-ask__opt {
        display: flex;
        align-items: flex-start;
        gap: 0.55rem;
        padding: 0.45rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        cursor: pointer;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .cw-ask__opt:hover {
        border-color: color-mix(in oklab, var(--foreground) 25%, var(--border));
      }
      .cw-ask__opt input {
        margin-top: 0.18rem;
        accent-color: var(--foreground);
      }
      .cw-ask__opt--on {
        border-color: var(--foreground);
        background: color-mix(in oklab, var(--foreground) 5%, var(--background));
      }
      .cw-ask__opt-body {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        min-width: 0;
      }
      .cw-ask__opt-label {
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--foreground);
      }
      .cw-ask__opt-desc {
        font-size: 0.72rem;
        color: var(--muted-foreground);
        line-height: 1.45;
      }
      .cw-ask__other {
        min-height: 3.5rem;
        padding: 0.5rem 0.65rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        color: inherit;
        font: inherit;
        font-size: 0.8125rem;
        resize: vertical;
        outline: none;
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      .cw-ask__other:focus {
        border-color: color-mix(in oklab, var(--ring) 60%, var(--border));
        box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 25%, transparent);
      }
      .cw-ask__recap {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        max-height: 12rem;
        overflow: auto;
      }
      .cw-ask__recap-item {
        display: grid;
        grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
        gap: 0.5rem;
        align-items: start;
        padding: 0.45rem 0.55rem;
        border: 1px solid color-mix(in oklab, var(--border) 82%, transparent);
        border-radius: 0.45rem;
        background: color-mix(in oklab, var(--foreground) 3%, var(--background));
      }
      .cw-ask__recap-question {
        min-width: 0;
        color: var(--muted-foreground);
        font-size: 0.74rem;
        line-height: 1.35;
      }
      .cw-ask__recap-answer {
        min-width: 0;
        color: var(--foreground);
        font-size: 0.78rem;
        font-weight: 500;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      @media (max-width: 540px) {
        .cw-perm { padding: 0.7rem 0.75rem; }
        .cw-perm__spacer { display: none; }
        .cw-btn { flex: 1; }
        .cw-perm__pattern {
          grid-template-columns: 1fr;
          gap: 0.2rem;
        }
        .cw-perm__pattern-detail {
          white-space: normal;
        }
        .cw-ask__recap-item {
          grid-template-columns: 1fr;
          gap: 0.2rem;
        }
      }
    `,
  ],
})
export class ClaudePermissionInlineComponent {
  @ViewChild('denyTa') private denyTa?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('otherTa') private otherTa?: ElementRef<HTMLTextAreaElement>;

  readonly request = input.required<ClaudePermissionRequest>();
  readonly appearance = input<'inline' | 'dock'>('inline');
  readonly approve = output<ClaudePermissionApproval>();
  readonly deny = output<string | undefined>();

  readonly denying = signal(false);
  readonly denyMessage = signal('');
  readonly currentQuestionIndex = signal(0);

  readonly kind = computed<'generic' | 'ask_user_question' | 'enter_plan_mode' | 'exit_plan_mode'>(() => {
    const name = normalizeToolName(this.request().toolName);
    if (name === 'askuserquestion') return 'ask_user_question';
    if (name === 'enterplanmode') return 'enter_plan_mode';
    if (name === 'exitplanmode') return 'exit_plan_mode';
    return 'generic';
  });

  readonly permToolKind = computed<string>(() => normalizeToolName(this.request().toolName));

  readonly requestTitle = computed(() => {
    const title = this.request().title?.trim();
    if (title) return title;
    const displayName = this.request().displayName?.trim();
    if (displayName) return `Allow ${displayName}?`;
    return `Approve ${this.requestToolLabel()}`;
  });

  readonly requestSubtitle = computed(() => {
    const description = this.request().description?.trim();
    return description || '';
  });

  readonly requestToolLabel = computed(() => {
    const displayName = this.request().displayName?.trim();
    if (displayName) return displayName;
    const toolName = this.request().toolName?.trim();
    return toolName || 'requested tool';
  });

  readonly requestSubline = computed(() => {
    const data = asRecord(this.request().input);
    const path =
      strField(data, 'file_path') ||
      strField(data, 'path') ||
      strField(data, 'notebook_path') ||
      strField(data, 'url') ||
      this.request().blockedPath ||
      '';
    return path;
  });

  readonly allowOnceCopy = computed(
    () =>
      `Approve this single action only. ${this.request().agentId ? 'The subagent' : 'Claude'} will ask again next time.`,
  );

  readonly allowAlwaysCopy = computed(() =>
    this.request().suggestions?.length
      ? `Approve and save ${this.alwaysAllowPatterns().length ? 'the displayed pattern' : 'Claude’s suggested permission rule'} for similar requests.`
      : 'Approve this request, but Claude did not provide a reusable pattern to save.',
  );

  readonly alwaysAllowPatterns = computed<AlwaysAllowPattern[]>(() =>
    (this.request().suggestions ?? []).flatMap((suggestion) => describePermissionSuggestion(suggestion)),
  );

  private readonly sanitizer = inject(DomSanitizer);

  readonly permDiffHtml = computed<SafeHtml | null>(() => {
    if (this.kind() !== 'generic') return null;
    const name = this.permToolKind();
    if (name !== 'edit' && name !== 'multiedit' && name !== 'fileedit' && name !== 'fileedittool') return null;
    const data = asRecord(this.request().input);
    const oldStr = typeof data['old_string'] === 'string' ? data['old_string'] : '';
    const newStr = typeof data['new_string'] === 'string' ? data['new_string'] : '';
    if (!oldStr && !newStr) return null;
    const filePath = typeof data['file_path'] === 'string' ? data['file_path'] : '';
    const html = highlightedDiffHtml(oldStr, newStr, filePath);
    const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(safe);
  });

  readonly permWriteContent = computed<string>(() => {
    if (this.kind() !== 'generic') return '';
    const name = this.permToolKind();
    if (name !== 'write' && name !== 'filewrite' && name !== 'filewritetool') return '';
    const data = asRecord(this.request().input);
    return typeof data['content'] === 'string' ? data['content'] : '';
  });

  readonly permBashCommand = computed<string>(() => {
    if (this.kind() !== 'generic') return '';
    const name = this.permToolKind();
    if (name !== 'bash' && name !== 'powershell') return '';
    const data = asRecord(this.request().input);
    return typeof data['command'] === 'string' ? String(data['command']).trim() : '';
  });

  readonly questions = computed<AskQuestion[]>(() => {
    if (this.kind() !== 'ask_user_question') return [];
    const input = asRecord(this.request().input);
    return Array.isArray(input['questions']) ? (input['questions'] as AskQuestion[]) : [];
  });

  readonly planContent = computed(() => {
    const input = asRecord(this.request().input);
    return typeof input['plan'] === 'string' ? input['plan'] : '';
  });

  readonly planPath = computed(() => {
    const input = asRecord(this.request().input);
    return typeof input['planFilePath'] === 'string' ? input['planFilePath'] : '';
  });

  readonly selectedAnswers = signal<Record<string, string[]>>({});
  readonly otherAnswers = signal<Record<string, string>>({});

  readonly isAskReviewing = computed(() => {
    const questions = this.questions();
    return questions.length > 0 && this.currentQuestionIndex() >= questions.length;
  });

  readonly activeQuestion = computed<AskQuestion | null>(() => {
    const questions = this.questions();
    if (!questions.length || this.isAskReviewing()) return null;
    return questions[this.currentQuestionIndex()] ?? null;
  });

  readonly askProgressLabel = computed(() => {
    const questions = this.questions();
    if (!questions.length) return 'No questions';
    if (this.isAskReviewing()) return 'Review answers';
    return `Question ${this.currentQuestionIndex() + 1} of ${questions.length}`;
  });

  readonly canSubmitQuestions = computed(() =>
    this.questions().every((question) => {
      const selections = this.selectedAnswers()[question.question] ?? [];
      if (selections.length === 0) return false;
      if (selections.includes('__other__')) {
        return !!this.otherAnswers()[question.question]?.trim();
      }
      return true;
    }),
  );

  private lastRequestId = '';

  constructor() {
    effect(() => {
      const requestId = this.request().requestId;
      if (requestId === this.lastRequestId) return;
      this.lastRequestId = requestId;
      this.selectedAnswers.set({});
      this.otherAnswers.set({});
      this.currentQuestionIndex.set(0);
      this.denying.set(false);
      this.denyMessage.set('');
    });
  }

  startDeny(): void {
    this.denying.set(true);
    queueMicrotask(() => this.denyTa?.nativeElement?.focus());
  }

  cancelDeny(): void {
    this.denying.set(false);
    this.denyMessage.set('');
  }

  confirmDeny(): void {
    const msg = this.denyMessage().trim();
    this.deny.emit(msg || undefined);
  }

  onDenyKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelDeny();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.confirmDeny();
    }
  }

  isSelected(question: AskQuestion, label: string): boolean {
    return (this.selectedAnswers()[question.question] ?? []).includes(label);
  }

  isOtherSelected(question: AskQuestion): boolean {
    return (this.selectedAnswers()[question.question] ?? []).includes('__other__');
  }

  toggleOption(question: AskQuestion, label: string, checked: boolean): void {
    this.selectedAnswers.update((current) => ({
      ...current,
      [question.question]: nextSelections(
        current[question.question] ?? [],
        label,
        checked,
        !!question.multiSelect,
      ),
    }));
    if (checked && !question.multiSelect) {
      this.advanceAskFlow();
    }
  }

  toggleOther(question: AskQuestion, checked: boolean): void {
    this.selectedAnswers.update((current) => ({
      ...current,
      [question.question]: nextSelections(
        current[question.question] ?? [],
        '__other__',
        checked,
        !!question.multiSelect,
      ),
    }));
    if (checked) {
      queueMicrotask(() => this.otherTa?.nativeElement?.focus());
    }
  }

  setOtherAnswer(questionText: string, value: string): void {
    this.otherAnswers.update((current) => ({ ...current, [questionText]: value }));
  }

  selectedPreview(question: AskQuestion): string {
    if (question.multiSelect) return '';
    const selected = (this.selectedAnswers()[question.question] ?? []).find((value) => value !== '__other__');
    if (!selected) return '';
    return question.options.find((option) => option.label === selected)?.preview ?? '';
  }

  canGoBack(): boolean {
    return this.currentQuestionIndex() > 0;
  }

  goBack(): void {
    this.currentQuestionIndex.update((index) => Math.max(index - 1, 0));
  }

  canAdvanceActiveQuestion(): boolean {
    const question = this.activeQuestion();
    return !!question && this.canAdvanceQuestion(question);
  }

  showAskNextButton(): boolean {
    const question = this.activeQuestion();
    if (!question) return false;
    return (this.selectedAnswers()[question.question] ?? []).length > 0;
  }

  advanceAskFlow(): void {
    const question = this.activeQuestion();
    if (!question || !this.canAdvanceQuestion(question)) return;
    const questions = this.questions();
    this.currentQuestionIndex.set(Math.min(this.currentQuestionIndex() + 1, questions.length));
  }

  submitQuestions(): void {
    if (!this.isAskReviewing() || !this.canSubmitQuestions()) return;
    const answers = Object.fromEntries(
      this.questions().map((question) => [question.question, this.serializeAnswer(question)]),
    );
    this.approve.emit({
      remember: false,
      content: { answers },
    });
  }

  serializeAnswer(question: AskQuestion): string {
    const selections = this.selectedAnswers()[question.question] ?? [];
    const mapped = selections.map((selection) =>
      selection === '__other__' ? (this.otherAnswers()[question.question] ?? '').trim() : selection,
    );
    return mapped.filter(Boolean).join(', ');
  }

  private canAdvanceQuestion(question: AskQuestion): boolean {
    const selections = this.selectedAnswers()[question.question] ?? [];
    if (selections.length === 0) return false;
    if (selections.includes('__other__')) {
      return !!this.otherAnswers()[question.question]?.trim();
    }
    return true;
  }
}

function normalizeToolName(name: string | undefined): string {
  return normalizeToolNameForUi(name ?? '');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function strField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function describePermissionSuggestion(suggestion: ClaudePermissionUpdate): AlwaysAllowPattern[] {
  switch (suggestion.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return suggestion.rules.map((rule) => ({
        label: formatRuleAction(suggestion.type),
        pattern: formatRulePattern(rule.toolName, rule.ruleContent),
        detail: `${formatPermissionBehavior(suggestion.behavior)} in ${formatPermissionDestination(suggestion.destination)}`,
      }));
    case 'addDirectories':
    case 'removeDirectories':
      return suggestion.directories.map((directory) => ({
        label: suggestion.type === 'addDirectories' ? 'Directory' : 'Remove directory',
        pattern: directory,
        detail: `Applies in ${formatPermissionDestination(suggestion.destination)}`,
      }));
    case 'setMode':
      return [
        {
          label: 'Mode',
          pattern: suggestion.mode,
          detail: `Applies in ${formatPermissionDestination(suggestion.destination)}`,
        },
      ];
  }
}

function formatRulePattern(toolName: string, ruleContent?: string): string {
  const cleanTool = toolName.trim() || 'Tool';
  const cleanRule = ruleContent?.trim();
  return cleanRule ? `${cleanTool}(${cleanRule})` : cleanTool;
}

function formatRuleAction(type: 'addRules' | 'replaceRules' | 'removeRules'): string {
  switch (type) {
    case 'addRules':
      return 'Rule';
    case 'replaceRules':
      return 'Replace';
    case 'removeRules':
      return 'Remove';
  }
}

function formatPermissionBehavior(behavior: string): string {
  const clean = behavior.trim();
  if (!clean) return 'Saved';
  if (clean.toLowerCase() === 'allow') return 'Allow';
  if (clean.toLowerCase() === 'deny') return 'Deny';
  return clean;
}

function formatPermissionDestination(destination: ClaudePermissionUpdate['destination']): string {
  switch (destination) {
    case 'userSettings':
      return 'user settings';
    case 'projectSettings':
      return 'project settings';
    case 'localSettings':
      return 'local settings';
    case 'session':
      return 'this session';
    case 'cliArg':
      return 'the current run';
  }
}

function nextSelections(
  current: string[],
  value: string,
  checked: boolean,
  multiSelect: boolean,
): string[] {
  if (!multiSelect) {
    return checked ? [value] : [];
  }
  const without = current.filter((entry) => entry !== value);
  return checked ? [...without, value] : without;
}
