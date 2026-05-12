import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, effect, ElementRef, forwardRef, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import {
  detectHljsLang,
  escapeHtml,
  highlightedUnifiedDiffHtml,
  splitHighlightedLines,
} from '../util/code-highlight';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBraces,
  lucideCheck,
  lucideChevronRight,
  lucideCircleAlert,
  lucideFilePen,
  lucideFilePlus,
  lucideFileText,
  lucideGitBranch,
  lucideGlobe,
  lucideListTodo,
  lucideLoaderCircle,
  lucideLockKeyhole,
  lucideMap,
  lucidePlugZap,
  lucideSearch,
  lucideSparkles,
  lucideTerminal,
  lucideUsers,
} from '@ng-icons/lucide';
import {
  ClaudePermissionApproval,
  ClaudeToolProgress,
  ClaudeToolInteractionSummary,
  ClaudeTranscriptItem,
} from '@/shared/models/claude-runtime.model';
import {
  ResultSummary,
  ToolDisplay,
  contentToString,
  describeTool,
  extractToolError,
  isHardError,
  resultSummary,
} from '../util/tool-format';
import { PairedTranscriptUnit, pairTranscript } from '../util/paired-transcript';
import { ClaudeMessageComponent } from './claude-message.component';
import { ClaudeThinkingComponent } from './claude-thinking.component';
import { MarkdownPipe } from '../pipes/markdown.pipe';

interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  activeForm?: string;
}

@Component({
  selector: 'cw-tool-call',
  standalone: true,
  imports: [CommonModule, NgIcon, MarkdownPipe, ClaudeMessageComponent, ClaudeThinkingComponent, forwardRef(() => ClaudeToolCallComponent)],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBraces,
      lucideCheck,
      lucideChevronRight,
      lucideCircleAlert,
      lucideFilePen,
      lucideFilePlus,
      lucideFileText,
      lucideGitBranch,
      lucideGlobe,
      lucideListTodo,
      lucideLoaderCircle,
      lucideLockKeyhole,
      lucideMap,
      lucidePlugZap,
      lucideSearch,
      lucideSparkles,
      lucideTerminal,
      lucideUsers,
    }),
  ],
  template: `
    <div class="cw-tool" [attr.data-state]="state()">
      <!-- TodoWrite gets special inline rendering — no toggle needed, checklist is the point. -->
      @if (display().kind === 'todo_write') {
        <div class="cw-tool__head cw-tool__head--static">
          <span class="cw-tool__state-icon"><ng-icon name="lucideListTodo" size="13" /></span>
          <span class="cw-tool__verb">Todos</span>
          <span class="cw-tool__count">{{ todos().length }}</span>
        </div>
        <ul class="cw-todos">
          @for (todo of todos(); track $index) {
            <li [attr.data-status]="todo.status">
              @switch (todo.status) {
                @case ('completed') { <span class="cw-todos__box cw-todos__box--done">✓</span> }
                @case ('in_progress') { <span class="cw-todos__box cw-todos__box--active"></span> }
                @default { <span class="cw-todos__box"></span> }
              }
              <span class="cw-todos__text">
                {{ todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content }}
              </span>
            </li>
          }
        </ul>
      } @else {
        <button type="button" class="cw-tool__head" (click)="toggle()">
          <span class="cw-tool__state-icon">
            @if (state() === 'running') {
              <ng-icon name="lucideLoaderCircle" size="13" class="animate-spin" />
            } @else if (state() === 'waiting') {
              <ng-icon name="lucideLockKeyhole" size="12" />
            } @else if (state() === 'error') {
              <ng-icon name="lucideCircleAlert" size="12" />
            } @else {
              <ng-icon name="lucideCheck" size="12" />
            }
          </span>

          <ng-icon [name]="display().icon" size="13" class="cw-tool__glyph" />
          <span class="cw-tool__verb">{{ display().verb }}</span>

          @if (display().target) {
            <span class="cw-tool__target" [title]="display().target">{{ display().target }}</span>
          }

          @if (summary(); as s) {
            <span class="cw-tool__result" [attr.data-tone]="s.tone">{{ s.text }}</span>
          }

          @if (canExpand()) {
            <ng-icon
              name="lucideChevronRight"
              size="12"
              class="cw-tool__chevron"
              [class.rotate-90]="open()"
            />
          }
        </button>

        @if (open() && canExpand()) {
          <div class="cw-tool__body">
            @if (interaction(); as interaction) {
              <div class="cw-agent">
                <div class="cw-agent__label">Your choice</div>
                <div class="cw-tool__decision">
                  <span class="cw-tool__decision-pill" [attr.data-tone]="interaction.decisionTone">
                    {{ interaction.decisionLabel }}
                  </span>

                  @if (interactionAnswers().length) {
                    <div class="cw-tool__answers">
                      @for (entry of interactionAnswers(); track entry.question) {
                        <div class="cw-tool__answer-row">
                          <span class="cw-tool__answer-question">{{ entry.question }}</span>
                          <span class="cw-tool__answer-value">{{ entry.answer }}</span>
                        </div>
                      }
                    </div>
                  }

                  @if (interactionContentText()) {
                    <pre class="cw-tool__output">{{ interactionContentText() }}</pre>
                  }
                </div>
              </div>
            }

            @switch (display().kind) {
              @case ('bash') {
                <pre class="cw-tool__cmd">$ {{ bashCommand() }}</pre>
                @if (resultText()) {
                  <pre class="cw-tool__output" [class.cw-tool__output--error]="state() === 'error'">{{ resultText() }}</pre>
                }
              }
              @case ('edit') {
                @if (isEditDiff()) {
                  <pre class="cw-tool__diff" [innerHTML]="diffHtml()"></pre>
                }
                @if (resultText() && state() === 'error') {
                  <pre class="cw-tool__output cw-tool__output--error">{{ resultText() }}</pre>
                }
              }
              @case ('write') {
                @if (writeContent()) {
                  <pre class="cw-tool__write" [innerHTML]="writeContentHtml()"></pre>
                  @if (writeHiddenLines() > 0) {
                    <button type="button" class="cw-tool__write-expand" (click)="toggleWriteExpand()">
                      @if (writeExpanded()) {
                        Show less
                      } @else {
                        Show {{ writeHiddenLines() }} more {{ writeHiddenLines() === 1 ? 'line' : 'lines' }}
                      }
                    </button>
                  }
                }
              }
              @case ('task_agent') {
                @if (agentPrompt()) {
                  <div class="cw-agent">
                    <button
                      type="button"
                      class="cw-agent__toggle"
                      (click)="togglePrompt()"
                      [attr.aria-expanded]="promptOpen()"
                    >
                      <ng-icon
                        name="lucideChevronRight"
                        size="11"
                        class="cw-agent__toggle-chevron"
                        [class.rotate-90]="promptOpen()"
                      />
                      <span class="cw-agent__label">Prompt</span>
                      @if (!promptOpen()) {
                        <span class="cw-agent__preview">{{ agentPromptPreview() }}</span>
                      }
                    </button>
                    @if (promptOpen()) {
                      <div class="cw-agent__prompt cw-agent__markdown" [innerHTML]="agentPrompt() | cwMarkdown"></div>
                    }
                  </div>
                }
                @if (agentUsageSummary()) {
                  <div class="cw-agent">
                    <div class="cw-agent__label">Run summary</div>
                    <div class="cw-agent__response">{{ agentUsageSummary() }}</div>
                  </div>
                }
                @if (childUnits().length) {
                  <div class="cw-subagent-stream">
                    <button
                      type="button"
                      class="cw-subagent-stream__header"
                      (click)="toggleStream()"
                      [attr.aria-expanded]="streamOpen()"
                    >
                      <ng-icon
                        name="lucideChevronRight"
                        size="10"
                        class="cw-subagent-stream__chevron"
                        [class.rotate-90]="streamOpen()"
                      />
                      <span class="cw-subagent-stream__label">Agent activity</span>
                      <span class="cw-subagent-stream__count">{{ childUnits().length }}</span>
                      @if (isLive()) {
                        <span class="cw-subagent-stream__live">live</span>
                      }
                    </button>
                    @if (streamOpen()) {
                      <div class="cw-subagent-stream__body" #streamBody (scroll)="onStreamScroll($event)">
                        @for (unit of childUnits(); track unit.id) {
                          @switch (unit.kind) {
                            @case ('message') {
                              <cw-message [item]="unit.item" />
                            }
                            @case ('thinking') {
                              <cw-thinking [item]="unit.item" />
                            }
                            @case ('tool') {
                              <cw-tool-call
                                [call]="unit.call"
                                [result]="unit.result"
                                [childItems]="nestedChildItems(unit.toolUseId)"
                                [isLive]="isNestedLiveToolUse(unit.toolUseId)"
                                (approve)="approve.emit($event)"
                                (deny)="deny.emit($event)"
                              />
                            }
                          }
                        }
                      </div>
                    }
                  </div>
                }
                @if (agentResponse()) {
                  <div class="cw-agent">
                    <div class="cw-agent__label">Response</div>
                    <div class="cw-agent__response cw-agent__markdown" [innerHTML]="agentResponse() | cwMarkdown"></div>
                  </div>
                }
                @if (turnId() && hasAgentHistory() && state() === 'done') {
                  <button type="button" class="cw-agent__deepdive" (click)="onDeepDiveClick()">
                    View full agent history →
                  </button>
                }
              }
              @case ('grep') {
                @if (resultText()) {
                  <pre class="cw-tool__output">{{ resultText() }}</pre>
                }
              }
              @case ('glob') {
                @if (resultText()) {
                  <pre class="cw-tool__output">{{ resultText() }}</pre>
                }
              }
              @case ('web_fetch') {
                @if (resultText()) {
                  <div class="cw-tool__web">{{ resultText() }}</div>
                }
              }
              @case ('web_search') {
                @if (resultText()) {
                  <div class="cw-tool__web">{{ resultText() }}</div>
                }
              }
              @case ('ask_user_question') {
                @if (!interaction() && askAnswers().length) {
                  <div class="cw-agent">
                    <div class="cw-agent__label">Answers</div>
                    <div class="cw-tool__answers">
                      @for (entry of askAnswers(); track entry.question) {
                        <div class="cw-tool__answer-row">
                          <span class="cw-tool__answer-question">{{ entry.question }}</span>
                          <span class="cw-tool__answer-value">{{ entry.answer }}</span>
                        </div>
                      }
                    </div>
                  </div>
                }
              }
              @case ('plan_mode') {
                <div class="cw-tool__web">Claude switched into planning mode and stayed read-only.</div>
              }
              @case ('exit_plan_mode') {
                @if (planFilePath()) {
                  <div class="cw-agent">
                    <div class="cw-agent__label">Plan file</div>
                    <div class="cw-agent__response">{{ planFilePath() }}</div>
                  </div>
                }
                @if (planMarkdown()) {
                  <div class="cw-tool__plan" [innerHTML]="planMarkdown() | cwMarkdown"></div>
                }
              }
              @default {
                <div class="cw-tool__kv">
                  @for (entry of fallbackEntries(); track entry.k) {
                    <div class="cw-tool__kv-row">
                      <span class="cw-tool__kv-key">{{ entry.k }}</span>
                      <span class="cw-tool__kv-val">{{ entry.v }}</span>
                    </div>
                  }
                </div>
                @if (resultText()) {
                  <pre class="cw-tool__output" [class.cw-tool__output--error]="state() === 'error'">{{ resultText() }}</pre>
                }
              }
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cw-tool {
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--card) 96%, transparent);
        overflow: hidden;
        font-size: 0.8125rem;
      }
      .cw-tool[data-state='waiting'] {
        border-color: color-mix(in oklab, #f59e0b 45%, var(--border));
      }
      .cw-tool[data-state='running'] {
        border-color: color-mix(in oklab, var(--primary) 30%, var(--border));
      }
      .cw-tool__head {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.4375rem 0.625rem;
        background: transparent;
        border: 0;
        cursor: pointer;
        text-align: left;
        color: inherit;
        font: inherit;
        min-width: 0;
      }
      .cw-tool__head--static {
        cursor: default;
        padding-bottom: 0.25rem;
      }
      .cw-tool__head:not(.cw-tool__head--static):hover {
        background: color-mix(in oklab, var(--foreground) 4%, transparent);
      }
      .cw-tool__state-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1rem;
        height: 1rem;
        flex-shrink: 0;
        color: var(--muted-foreground);
      }
      .cw-tool[data-state='running'] .cw-tool__state-icon {
        color: var(--primary);
      }
      .cw-tool[data-state='waiting'] .cw-tool__state-icon {
        color: #d97706;
      }
      .cw-tool[data-state='error'] .cw-tool__state-icon {
        color: var(--destructive);
      }
      .cw-tool[data-state='done'] .cw-tool__state-icon {
        color: color-mix(in oklab, #16a34a 90%, var(--muted-foreground));
      }
      .cw-tool__glyph {
        color: var(--muted-foreground);
        flex-shrink: 0;
      }
      .cw-tool__verb {
        font-weight: 600;
        flex-shrink: 0;
        color: var(--foreground);
      }
      .cw-tool__target {
        color: var(--muted-foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 1;
      }
      .cw-tool__result {
        font-size: 0.6875rem;
        color: var(--muted-foreground);
        flex-shrink: 0;
        padding: 0.0625rem 0.375rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
      }
      .cw-tool__result[data-tone='ok'] {
        color: color-mix(in oklab, #16a34a 85%, var(--foreground));
      }
      .cw-tool__result[data-tone='warn'] {
        color: #d97706;
      }
      .cw-tool__result[data-tone='error'] {
        color: var(--destructive);
        background: color-mix(in oklab, var(--destructive) 10%, transparent);
      }
      .cw-tool__count {
        font-size: 0.6875rem;
        color: var(--muted-foreground);
        padding: 0.0625rem 0.375rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
      }
      .cw-tool__chevron {
        color: var(--muted-foreground);
        transition: transform 120ms ease;
        flex-shrink: 0;
        margin-left: 0.125rem;
      }
      .cw-tool__chevron.rotate-90 {
        transform: rotate(90deg);
      }
      .cw-tool__body {
        padding: 0 0.625rem 0.5rem;
        border-top: 1px dashed var(--border);
        padding-top: 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cw-tool__cmd,
      .cw-tool__output,
      .cw-tool__file {
        margin: 0;
        padding: 0.5rem 0.625rem;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        border-radius: 0.375rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 24rem;
        overflow: auto;
      }
      .cw-tool__output--error {
        background: color-mix(in oklab, var(--destructive) 8%, transparent);
        color: var(--destructive);
      }
      .cw-tool__web {
        padding: 0.5rem 0.625rem;
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        border-radius: 0.375rem;
        font-size: 0.8125rem;
        line-height: 1.55;
        white-space: pre-wrap;
        max-height: 28rem;
        overflow: auto;
      }
      .cw-tool__diff {
        margin: 0;
        max-height: 24rem;
        overflow: auto;
        border-radius: 0.375rem;
        background: color-mix(in oklab, var(--background) 88%, var(--surface-shade));
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.72rem;
        line-height: 1.55;
        white-space: pre;
      }
      :host ::ng-deep .cw-diff-line {
        display: grid;
        grid-template-columns: 2.5rem 2.5rem 1.15rem minmax(0, 1fr);
        min-width: max-content;
      }
      :host ::ng-deep .cw-diff-ln,
      :host ::ng-deep .cw-diff-marker {
        user-select: none;
        color: var(--muted-foreground);
        background: color-mix(in oklab, var(--foreground) 3%, transparent);
      }
      :host ::ng-deep .cw-diff-ln {
        padding: 0 0.45rem;
        text-align: right;
        border-right: 1px solid color-mix(in oklab, var(--border) 70%, transparent);
      }
      :host ::ng-deep .cw-diff-marker {
        padding: 0 0.25rem;
        text-align: center;
      }
      :host ::ng-deep .cw-diff-code {
        padding: 0 0.75rem 0 0.5rem;
        min-width: 0;
      }
      :host ::ng-deep .cw-diff-add {
        background: color-mix(in oklab, var(--success) 10%, transparent);
      }
      :host ::ng-deep .cw-diff-add .cw-diff-marker {
        color: color-mix(in oklab, var(--success) 85%, var(--foreground));
      }
      :host ::ng-deep .cw-diff-del {
        background: color-mix(in oklab, var(--destructive) 10%, transparent);
      }
      :host ::ng-deep .cw-diff-del .cw-diff-marker {
        color: color-mix(in oklab, var(--destructive) 85%, var(--foreground));
      }
      :host ::ng-deep .cw-diff-hunk {
        color: color-mix(in oklab, var(--primary) 78%, var(--foreground));
        background: color-mix(in oklab, var(--primary) 8%, transparent);
      }
      .cw-tool__write {
        margin: 0;
        padding: 0.25rem 0;
        background: color-mix(in oklab, var(--foreground) 4%, transparent);
        border-radius: 0.375rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
        line-height: 1.55;
        white-space: normal;
        max-height: 24rem;
        overflow: auto;
      }
      .cw-write__line {
        display: grid;
        grid-template-columns: 1.75rem 1fr;
        background: color-mix(in oklab, oklch(0.52 0.18 240) 8%, transparent);
      }
      :host-context(.dark) .cw-write__line {
        background: color-mix(in oklab, oklch(0.68 0.16 240) 13%, transparent);
      }
      .cw-write__sign {
        user-select: none;
        text-align: center;
        color: oklch(0.45 0.2 240);
        background: color-mix(in oklab, oklch(0.52 0.18 240) 16%, transparent);
      }
      :host-context(.dark) .cw-write__sign {
        color: oklch(0.72 0.16 240);
        background: color-mix(in oklab, oklch(0.68 0.16 240) 22%, transparent);
      }
      .cw-write__code {
        padding: 0 0.5rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cw-tool__write-expand {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.2rem 0.55rem;
        background: transparent;
        border: 1px dashed var(--border);
        border-radius: 0.375rem;
        cursor: pointer;
        color: var(--muted-foreground);
        font-size: 0.6875rem;
        font-family: inherit;
      }
      .cw-tool__write-expand:hover {
        color: var(--foreground);
        border-color: color-mix(in oklab, var(--foreground) 25%, var(--border));
      }
      .cw-tool__kv {
        display: grid;
        gap: 0.125rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.75rem;
      }
      .cw-tool__kv-row {
        display: grid;
        grid-template-columns: 8rem 1fr;
        gap: 0.5rem;
        padding: 0.125rem 0.25rem;
      }
      .cw-tool__kv-key {
        color: var(--muted-foreground);
      }
      .cw-tool__kv-val {
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cw-agent {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .cw-agent__label {
        font-size: 0.625rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted-foreground);
        font-weight: 600;
      }
      .cw-agent__toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0;
        border: 0;
        background: none;
        color: inherit;
        cursor: pointer;
        text-align: left;
        align-self: flex-start;
        max-width: 100%;
      }
      .cw-agent__toggle-chevron {
        color: var(--muted-foreground);
        transition: transform 120ms ease;
        flex-shrink: 0;
      }
      .cw-agent__toggle-chevron.rotate-90 {
        transform: rotate(90deg);
      }
      .cw-agent__preview {
        font-size: 0.75rem;
        color: var(--muted-foreground);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
      }
      .cw-agent__toggle:hover .cw-agent__label,
      .cw-agent__toggle:hover .cw-agent__toggle-chevron {
        color: var(--foreground);
      }
      .cw-agent__prompt,
      .cw-agent__response,
      .cw-tool__answers {
        padding: 0.5rem 0.625rem;
        background: color-mix(in oklab, var(--foreground) 4%, transparent);
        border-radius: 0.375rem;
        font-size: 0.8125rem;
        line-height: 1.6;
        white-space: pre-wrap;
        max-height: 20rem;
        overflow: auto;
      }
      .cw-agent__markdown {
        white-space: normal;
      }
      .cw-agent__markdown > :first-child { margin-top: 0; }
      .cw-agent__markdown > :last-child { margin-bottom: 0; }
      .cw-agent__markdown p {
        margin: 0 0 0.5rem 0;
      }
      .cw-agent__markdown p:last-child { margin-bottom: 0; }
      .cw-agent__markdown h1,
      .cw-agent__markdown h2,
      .cw-agent__markdown h3,
      .cw-agent__markdown h4 {
        margin: 0.75rem 0 0.375rem;
        font-weight: 600;
        line-height: 1.3;
      }
      .cw-agent__markdown h1 { font-size: 1rem; }
      .cw-agent__markdown h2 { font-size: 0.9375rem; }
      .cw-agent__markdown h3,
      .cw-agent__markdown h4 { font-size: 0.875rem; }
      .cw-agent__markdown ul,
      .cw-agent__markdown ol {
        margin: 0 0 0.5rem;
        padding-left: 1.25rem;
      }
      .cw-agent__markdown li {
        margin: 0.125rem 0;
      }
      .cw-agent__markdown li > p {
        margin: 0;
      }
      .cw-agent__markdown code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8125em;
        padding: 0.05rem 0.3rem;
        border-radius: 0.25rem;
        background: color-mix(in oklab, var(--foreground) 8%, transparent);
      }
      .cw-agent__markdown pre.cw-code,
      .cw-agent__markdown pre {
        margin: 0.5rem 0;
        padding: 0.625rem 0.75rem;
        background: color-mix(in oklab, var(--foreground) 7%, var(--card));
        border: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent);
        border-radius: 0.375rem;
        overflow-x: auto;
        font-size: 0.75rem;
        line-height: 1.5;
      }
      .cw-agent__markdown pre code {
        background: transparent;
        padding: 0;
        border-radius: 0;
        font-size: inherit;
      }
      .cw-agent__markdown blockquote {
        margin: 0.5rem 0;
        padding: 0.125rem 0.75rem;
        border-left: 2px solid color-mix(in oklab, var(--primary) 40%, var(--border));
        color: var(--muted-foreground);
      }
      .cw-agent__markdown a {
        color: color-mix(in oklab, var(--primary) 75%, var(--foreground));
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .cw-agent__markdown a:hover {
        text-decoration-thickness: 2px;
      }
      .cw-agent__markdown hr {
        margin: 0.75rem 0;
        border: 0;
        border-top: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent);
      }
      .cw-agent__markdown table {
        border-collapse: collapse;
        margin: 0.5rem 0;
        font-size: 0.75rem;
      }
      .cw-agent__markdown th,
      .cw-agent__markdown td {
        padding: 0.25rem 0.5rem;
        border: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent);
        text-align: left;
      }
      .cw-agent__markdown th {
        background: color-mix(in oklab, var(--foreground) 5%, transparent);
        font-weight: 600;
      }
      .cw-tool__decision {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .cw-tool__decision-pill {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        min-height: 1.5rem;
        padding: 0.125rem 0.5rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--foreground);
        font-size: 0.75rem;
        font-weight: 600;
      }
      .cw-tool__decision-pill[data-tone='ok'] {
        color: color-mix(in oklab, #16a34a 85%, var(--foreground));
        background: color-mix(in oklab, #16a34a 12%, transparent);
      }
      .cw-tool__decision-pill[data-tone='warn'] {
        color: #d97706;
        background: color-mix(in oklab, #f59e0b 14%, transparent);
      }
      .cw-tool__decision-pill[data-tone='neutral'] {
        color: var(--muted-foreground);
      }
      .cw-agent__deepdive {
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
        padding: 0.35rem 0.75rem;
        border-radius: 999px;
        border: 1px solid color-mix(in oklab, var(--primary) 35%, var(--border));
        background: color-mix(in oklab, var(--primary) 7%, var(--card));
        color: color-mix(in oklab, var(--primary) 80%, var(--foreground));
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .cw-agent__deepdive:hover {
        background: color-mix(in oklab, var(--primary) 13%, var(--card));
        border-color: color-mix(in oklab, var(--primary) 55%, var(--border));
      }
      .cw-subagent-stream {
        border: 1px solid color-mix(in oklab, var(--primary) 22%, var(--border));
        border-radius: 0.5rem;
        background: color-mix(in oklab, var(--primary) 3%, var(--card));
        overflow: hidden;
      }
      .cw-subagent-stream__header {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.3rem 0.625rem;
        background: color-mix(in oklab, var(--primary) 8%, var(--card));
        border-bottom: 1px solid color-mix(in oklab, var(--primary) 18%, var(--border));
        width: 100%;
        cursor: pointer;
        border: none;
        text-align: left;
        font: inherit;
        color: inherit;
        &:not([aria-expanded='true']) {
          border-bottom: none;
        }
      }
      .cw-subagent-stream__chevron {
        color: var(--muted-foreground);
        transition: transform 120ms ease;
        flex-shrink: 0;
      }
      .cw-subagent-stream__label {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        font-weight: 700;
        color: color-mix(in oklab, var(--primary) 65%, var(--muted-foreground));
      }
      .cw-subagent-stream__count {
        font-size: 0.6rem;
        padding: 0.0625rem 0.3rem;
        border-radius: 999px;
        background: color-mix(in oklab, var(--foreground) 6%, transparent);
        color: var(--muted-foreground);
      }
      .cw-subagent-stream__live {
        font-size: 0.6rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 700;
        color: var(--primary);
        background: color-mix(in oklab, var(--primary) 14%, transparent);
        padding: 0.0625rem 0.375rem;
        border-radius: 999px;
        margin-left: auto;
      }
      .cw-subagent-stream__body {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.5rem;
        max-height: 18rem;
        overflow-y: auto;
        scrollbar-width: thin;
      }
      .cw-tool__answer-row {
        display: grid;
        gap: 0.125rem;
      }
      .cw-tool__answer-row + .cw-tool__answer-row {
        margin-top: 0.5rem;
        padding-top: 0.5rem;
        border-top: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
      }
      .cw-tool__answer-question {
        font-size: 0.75rem;
        font-weight: 600;
      }
      .cw-tool__answer-value {
        color: var(--muted-foreground);
      }
      .cw-tool__plan {
        padding: 0.75rem;
        border-radius: 0.5rem;
        border: 1px solid var(--border);
        background: color-mix(in oklab, var(--foreground) 4%, transparent);
        font-size: 0.8125rem;
        line-height: 1.6;
        max-height: 26rem;
        overflow: auto;
      }
      .cw-tool__plan :first-child {
        margin-top: 0;
      }
      .cw-tool__plan :last-child {
        margin-bottom: 0;
      }
      .cw-todos {
        list-style: none;
        margin: 0;
        padding: 0 0.625rem 0.5rem 2rem;
        display: flex;
        flex-direction: column;
        gap: 0.1875rem;
      }
      .cw-todos li {
        display: flex;
        gap: 0.5rem;
        align-items: baseline;
        font-size: 0.8125rem;
        line-height: 1.4;
      }
      .cw-todos__box {
        width: 0.75rem;
        height: 0.75rem;
        border-radius: 0.1875rem;
        border: 1.5px solid var(--muted-foreground);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.6875rem;
        line-height: 1;
        color: transparent;
        flex-shrink: 0;
        align-self: center;
      }
      .cw-todos__box--done {
        background: color-mix(in oklab, #16a34a 85%, transparent);
        border-color: color-mix(in oklab, #16a34a 85%, transparent);
        color: white;
      }
      .cw-todos__box--active {
        border-color: var(--primary);
        background: color-mix(in oklab, var(--primary) 25%, transparent);
        position: relative;
      }
      .cw-todos__box--active::after {
        content: '';
        position: absolute;
        inset: 2px;
        border-radius: 1px;
        background: var(--primary);
        animation: cw-todos-pulse 1.4s ease-in-out infinite;
      }
      .cw-todos li[data-status='completed'] .cw-todos__text {
        color: var(--muted-foreground);
        text-decoration: line-through;
        text-decoration-color: color-mix(in oklab, var(--muted-foreground) 50%, transparent);
      }
      .cw-todos li[data-status='in_progress'] .cw-todos__text {
        font-weight: 500;
      }
      @keyframes cw-todos-pulse {
        0%,
        100% {
          opacity: 0.5;
        }
        50% {
          opacity: 1;
        }
      }
    `,
  ],
})
export class ClaudeToolCallComponent {
  readonly call = input.required<ClaudeTranscriptItem>();
  readonly result = input<ClaudeTranscriptItem | null>(null);
  readonly childItems = input<ClaudeTranscriptItem[]>([]);
  readonly isLive = input<boolean>(false);
  readonly progress = input<ClaudeToolProgress | null>(null);
  readonly turnId = input<string | null>(null);
  readonly hasAgentHistory = input<boolean>(false);

  readonly approve = output<ClaudePermissionApproval>();
  readonly deny = output<string | undefined>();
  readonly inspect = output<string>();

  private readonly openState = signal<boolean | null>(null);
  private readonly promptOpenState = signal<boolean>(false);
  private readonly streamOpenState = signal<boolean | null>(null);
  private readonly timerTick = signal(Date.now());
  private userHasScrolledUp = false;
  private readonly streamBodyEl = viewChild<ElementRef<HTMLElement>>('streamBody');

  readonly streamOpen = computed(() => this.streamOpenState() ?? this.isLive());

  readonly promptOpen = computed(() => this.promptOpenState());

  constructor() {
    effect(() => {
      const live = this.isLive();
      untracked(() => {
        if (!live) {
          if (this.userHasScrolledUp && this.streamOpenState() === null) {
            this.streamOpenState.set(true);
          }
          this.userHasScrolledUp = false;
        }
      });
    });

    effect((onCleanup) => {
      if (this.display().kind !== 'bash' || this.state() !== 'running') return;
      this.timerTick.set(Date.now());
      const id = window.setInterval(() => this.timerTick.set(Date.now()), 1000);
      onCleanup(() => window.clearInterval(id));
    });

    afterRenderEffect(() => {
      this.childUnits();
      const el = this.streamBodyEl()?.nativeElement;
      if (!el || !untracked(() => this.streamOpen()) || this.userHasScrolledUp) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  toggleStream(): void {
    this.streamOpenState.update((cur) => !(cur ?? this.isLive()));
  }

  onStreamScroll(event: Event): void {
    const el = event.target as HTMLElement;
    this.userHasScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - 10;
  }

  togglePrompt(): void {
    this.promptOpenState.update((v) => !v);
  }

  readonly agentPromptPreview = computed(() => {
    const text = this.agentPrompt().replace(/\s+/g, ' ').trim();
    return text.length > 120 ? text.slice(0, 117) + '…' : text;
  });

  readonly display = computed<ToolDisplay>(() => describeTool(this.call().toolName, this.call().toolInput));

  readonly state = computed<'running' | 'waiting' | 'error' | 'done'>(() => {
    if (!this.result() && this.isLive()) return 'running';
    if (isHardError(this.result())) return 'error';
    return 'done';
  });

  readonly summary = computed<ResultSummary | null>(() => {
    if (this.state() === 'running') {
      if (this.display().kind === 'bash') {
        return {
          text: `Running ${formatElapsedSeconds(this.runningElapsedSeconds())}`,
          tone: 'neutral',
        };
      }
      return null;
    }
    if (this.state() === 'waiting') return null;
    return resultSummary(this.display().kind, this.result(), this.interaction());
  });

  readonly runningElapsedSeconds = computed(() => {
    const progress = this.progress();
    if (progress && Number.isFinite(progress.elapsedTimeSeconds)) {
      const updatedAt = Date.parse(progress.timestamp);
      const secondsSinceProgress =
        Number.isFinite(updatedAt)
          ? Math.floor((this.timerTick() - updatedAt) / 1000)
          : 0;
      return Math.max(0, Math.floor(progress.elapsedTimeSeconds) + secondsSinceProgress);
    }

    const startedAt = Date.parse(this.call().receivedAt ?? this.call().timestamp);
    if (!Number.isFinite(startedAt)) return 0;
    return Math.max(0, Math.floor((this.timerTick() - startedAt) / 1000));
  });

  readonly resultText = computed(() => {
    const raw = contentToString(this.result()?.content);
    return isHardError(this.result()) ? extractToolError(raw) : raw;
  });

  readonly canExpand = computed(() => {
    const k = this.display().kind;
    if (k === 'todo_write' || k === 'worktree') return false;
    // Always expandable if we have a result, or if this is an agent (has prompt)
    if (k === 'plan_mode' || k === 'exit_plan_mode' || k === 'ask_user_question') {
      return !!this.result() || !!this.interaction();
    }
    return (
      !!this.result()
      || !!this.interaction()
      || !!this.agentPrompt()
      || this.isEditDiff()
      || !!this.bashCommand()
      || this.childUnits().length > 0
    );
  });

  readonly open = computed(() => {
    const explicit = this.openState();
    if (explicit !== null) return explicit;
    return this.state() === 'error';
  });

  readonly todos = computed<Todo[]>(() => {
    if (this.display().kind !== 'todo_write') return [];
    const input = this.call().toolInput as { todos?: Todo[] } | undefined;
    return Array.isArray(input?.todos) ? (input!.todos as Todo[]) : [];
  });

  readonly bashCommand = computed(() => {
    if (this.display().kind !== 'bash') return '';
    const input = this.call().toolInput as { command?: string } | undefined;
    return input?.command ?? '';
  });

  readonly isEditDiff = computed(() => {
    if (this.display().kind !== 'edit') return false;
    const data = this.call().toolInput as Record<string, unknown> | undefined;
    return (
      !!data && typeof data['old_string'] === 'string' && typeof data['new_string'] === 'string'
    );
  });

  readonly editFilePath = computed(() => {
    if (this.display().kind !== 'edit') return '';
    const data = this.call().toolInput as { file_path?: string } | undefined;
    return data?.file_path ?? '';
  });

  readonly diffHtml = computed<SafeHtml>(() => {
    const data = this.call().toolInput as { old_string?: string; new_string?: string } | undefined;
    const html = highlightedUnifiedDiffHtml(data?.old_string ?? '', data?.new_string ?? '', this.editFilePath());
    const safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(safe);
  });

  readonly writeContent = computed(() => {
    if (this.display().kind !== 'write') return '';
    const data = this.call().toolInput as { content?: string } | undefined;
    return data?.content ?? '';
  });

  readonly writeFilePath = computed(() => {
    if (this.display().kind !== 'write') return '';
    const data = this.call().toolInput as { file_path?: string } | undefined;
    return data?.file_path ?? '';
  });

  private readonly writeExpandedState = signal(false);
  readonly writeExpanded = computed(() => this.writeExpandedState());

  readonly writeLineCount = computed(() => {
    const c = this.writeContent();
    if (!c) return 0;
    const parts = c.split('\n');
    return c.endsWith('\n') ? parts.length - 1 : parts.length;
  });

  readonly writeHiddenLines = computed(() => {
    const total = this.writeLineCount();
    return total > WRITE_PREVIEW_LINES ? total - WRITE_PREVIEW_LINES : 0;
  });

  private readonly sanitizer = inject(DomSanitizer);

  readonly writeContentHtml = computed<SafeHtml>(() => {
    const content = this.writeContent();
    if (!content) return '';
    const expanded = this.writeExpanded();
    const visible = expanded
      ? content
      : content.split('\n').slice(0, WRITE_PREVIEW_LINES).join('\n');
    const lang = detectHljsLang(this.writeFilePath());
    let highlighted: string;
    try {
      highlighted = lang
        ? hljs.highlight(visible, { language: lang, ignoreIllegals: true }).value
        : hljs.highlightAuto(visible).value;
    } catch {
      highlighted = escapeHtml(visible);
    }
    const lines = splitHighlightedLines(highlighted);
    const wrapped = lines
      .map(
        (line) =>
          `<span class="cw-write__line"><span class="cw-write__sign">+</span><span class="cw-write__code">${line.length ? line : ' '}</span></span>`,
      )
      .join('\n');
    const safe = DOMPurify.sanitize(wrapped, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(safe);
  });

  toggleWriteExpand(): void {
    this.writeExpandedState.update((v) => !v);
  }

  readonly agentPrompt = computed(() => {
    if (this.display().kind !== 'task_agent') return '';
    const parsedPrompt = this.parsedResult()?.['prompt'];
    if (typeof parsedPrompt === 'string' && parsedPrompt.trim()) return parsedPrompt;
    const data = this.call().toolInput as { prompt?: string; description?: string } | undefined;
    return data?.prompt ?? data?.description ?? '';
  });

  readonly parsedResult = computed<Record<string, unknown> | null>(() => {
    const text = this.resultText().trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      // Arrays (legacy serialized tool_result content) are handled in
      // agentResponse via a separate parse — skip here so keyed consumers
      // (agentPrompt, askAnswers, planMarkdown, etc.) stay simple.
      if (Array.isArray(parsed)) return null;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  });

  readonly interaction = computed<ClaudeToolInteractionSummary | null>(() => this.call().interaction ?? null);

  readonly interactionAnswers = computed<Array<{ question: string; answer: string }>>(() => {
    const answers = this.interaction()?.answers ?? [];
    return answers.map((entry) => ({ question: entry.question, answer: entry.answer }));
  });

  readonly interactionContentText = computed(() => {
    const interaction = this.interaction();
    if (!interaction?.content) return '';
    const { answers: _answers, ...rest } = interaction.content;
    if (!Object.keys(rest).length) return '';
    return JSON.stringify(rest, null, 2);
  });

  readonly askAnswers = computed<Array<{ question: string; answer: string }>>(() => {
    if (this.interactionAnswers().length) return this.interactionAnswers();
    if (this.display().kind !== 'ask_user_question') return [];
    const answers = this.parsedResult()?.['answers'];
    if (!answers || typeof answers !== 'object') return [];
    return Object.entries(answers as Record<string, unknown>).map(([question, answer]) => ({
      question,
      answer: String(answer ?? ''),
    }));
  });

  readonly planMarkdown = computed(() => {
    if (this.display().kind !== 'exit_plan_mode') return '';
    const plan = this.parsedResult()?.['plan'];
    if (typeof plan === 'string' && plan) return plan;
    const input = this.call().toolInput as Record<string, unknown> | undefined;
    return typeof input?.['plan'] === 'string' ? input['plan'] : '';
  });

  readonly planFilePath = computed(() => {
    if (this.display().kind !== 'exit_plan_mode') return '';
    const filePath = this.parsedResult()?.['filePath'];
    if (typeof filePath === 'string' && filePath) return filePath;
    const input = this.call().toolInput as Record<string, unknown> | undefined;
    return typeof input?.['planFilePath'] === 'string' ? input['planFilePath'] : '';
  });

  readonly fallbackEntries = computed<Array<{ k: string; v: string }>>(() => {
    const input = this.call().toolInput;
    if (!input || typeof input !== 'object') return [];
    return Object.entries(input as Record<string, unknown>).map(([k, v]) => ({
      k,
      v: typeof v === 'string' ? v : JSON.stringify(v, null, 2),
    }));
  });

  readonly agentResponse = computed(() => {
    if (this.display().kind !== 'task_agent') return this.resultText();

    const raw = this.resultText().trim();

    // Legacy/resumed sessions have the whole tool_result content serialized
    // as a JSON string (`[{"type":"text","text":"..."}]`). Detect and unwrap.
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const text = extractTextBlocks(parsed);
          if (text) return stripAgentTrailer(text);
        }
      } catch {
        // fall through to other handling
      }
    }

    const parsed = this.parsedResult();
    if (parsed) {
      const content = parsed['content'];
      if (Array.isArray(content)) {
        const text = extractTextBlocks(content);
        if (text) return stripAgentTrailer(text);
      }
      const result = parsed['result'];
      if (typeof result === 'string' && result.trim()) return stripAgentTrailer(result);
    }

    return stripAgentTrailer(raw);
  });

  readonly agentUsageSummary = computed(() => {
    if (this.display().kind !== 'task_agent') return '';
    const parsed = this.parsedResult();
    if (!parsed) return '';

    const parts: string[] = [];
    const toolUses = parsed['totalToolUseCount'];
    const durationMs = parsed['totalDurationMs'];
    const tokens = parsed['totalTokens'];

    if (typeof toolUses === 'number' && toolUses > 0) {
      parts.push(`${toolUses} tool call${toolUses === 1 ? '' : 's'}`);
    }
    if (typeof durationMs === 'number' && durationMs > 0) {
      parts.push(formatDuration(durationMs));
    }
    if (typeof tokens === 'number' && tokens > 0) {
      parts.push(`${tokens.toLocaleString()} tokens`);
    }

    return parts.join(' · ');
  });

  readonly childUnits = computed<PairedTranscriptUnit[]>(() => pairTranscript(this.childItems()));
  readonly childItemsByParentToolUseId = computed(() => {
    const grouped: Record<string, ClaudeTranscriptItem[]> = {};
    for (const item of this.childItems()) {
      if (!item.parentToolUseId) continue;
      grouped[item.parentToolUseId] = [...(grouped[item.parentToolUseId] ?? []), item];
    }
    return grouped;
  });

  childStateLabel(unit: PairedTranscriptUnit): string {
    switch (unit.kind) {
      case 'message':
        return unit.item.kind === 'user' ? 'Prompt' : 'Message';
      case 'thinking':
        return 'Thinking';
      case 'tool':
        return this.childToolLabel(unit.call);
      case 'system':
        return 'System';
    }
  }

  childSummary(unit: Extract<PairedTranscriptUnit, { kind: 'tool' }>): string {
    const display = describeTool(unit.call.toolName, unit.call.toolInput);
    return resultSummary(display.kind, unit.result)?.text ?? '';
  }

  childToolLabel(item: ClaudeTranscriptItem): string {
    const display = describeTool(item.toolName, item.toolInput);
    return display.target ? `${display.verb} ${display.target}` : display.verb;
  }

  nestedChildItems(toolUseId: string): ClaudeTranscriptItem[] {
    return this.childItemsByParentToolUseId()[toolUseId] ?? [];
  }

  isNestedLiveToolUse(toolUseId: string): boolean {
    return this.childItems().some((item) => item.kind === 'tool_use' && item.toolUseId === toolUseId);
  }

  contentAsString(content: unknown): string {
    return contentToString(content);
  }

  onDeepDiveClick(): void {
    const id = this.turnId();
    if (id) this.inspect.emit(id);
  }

  toggle(): void {
    if (!this.canExpand()) return;
    this.openState.set(!this.open());
  }
}

const WRITE_PREVIEW_LINES = 12;

function extractTextBlocks(blocks: unknown[]): string {
  return blocks
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string') {
        return record['text'];
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// The Task tool appends a trailer to every completed-agent tool_result:
//   "agentId: ...\n<usage>total_tokens: ...\ntool_uses: ...\nduration_ms: ...</usage>"
// (see claude-code/src/tools/AgentTool/AgentTool.tsx, mapToolResultToToolResultBlockParam).
// That block is a machine-readable metadata footer — we surface it separately
// via `agentUsageSummary`, so strip it from the human-facing response.
function stripAgentTrailer(text: string): string {
  if (!text) return '';
  let cleaned = text.replace(/<usage>[\s\S]*?<\/usage>\s*$/i, '').trimEnd();
  cleaned = cleaned.replace(/\n*agentId:[^\n]*(?:\n(?:worktreePath|worktreeBranch):[^\n]*)*\s*$/i, '').trimEnd();
  return cleaned;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) return `${totalSeconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  if (minutes <= 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}
