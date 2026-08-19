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
  lucideBan,
  lucideCheckCircle,
  lucideChevronDown,
  lucideCheck,
  lucideCopy,
  lucideExternalLink,
  lucideFileCode,
  lucideFileText,
  lucideGitFork,
  lucideInfo,
  lucideMessageSquarePlus,
  lucidePencil,
  lucidePlus,
  lucideSquare,
  lucideTriangleAlert,
  lucideX,
  lucideXCircle,
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
import { type TaskNotification, parseTaskNotifications } from '@/shared/utils/task-notification';
import { parseSessionMentions } from '@/shared/utils/session-mention';

@Component({
  selector: 'cw-message',
  standalone: true,
  imports: [CommonModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBan,
      lucideCheckCircle,
      lucideChevronDown,
      lucideCheck,
      lucideCopy,
      lucideExternalLink,
      lucideFileCode,
      lucideFileText,
      lucideGitFork,
      lucideInfo,
      lucideMessageSquarePlus,
      lucidePencil,
      lucidePlus,
      lucideSquare,
      lucideTriangleAlert,
      lucideX,
      lucideXCircle,
    }),
  ],
  templateUrl: './claude-message.component.html',
  styleUrl: './claude-message.component.scss',
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

  readonly messageCopy = output<string | null>();
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
  readonly openPlanChat = output<PlanReviewRequest>();

  readonly isEmpty = computed(() => !this.item().content);
  readonly syntheticMessageInfo = computed(() => getSyntheticMessageInfo(this.item()));
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
  readonly userTaskNotificationDisplay = computed(() =>
    parseTaskNotifications(this.item().content),
  );
  readonly userTaskNotifications = computed(
    () => this.userTaskNotificationDisplay().notifications,
  );
  readonly isTaskNotificationOnly = computed(
    () =>
      this.userTaskNotifications().length > 0 &&
      !this.userTaskNotificationDisplay().text.trim(),
  );
  readonly userSessionMentionDisplay = computed(() =>
    parseSessionMentions(this.userTaskNotificationDisplay().text),
  );
  readonly userMessageDisplay = computed(() =>
    parseDiffSelectionMentions(this.userSessionMentionDisplay().text),
  );
  readonly userMessageText = computed(() => this.userMessageDisplay().text);
  readonly userDiffMentions = computed(() => this.userMessageDisplay().mentions);
  readonly userSessionMentions = computed(() => this.userSessionMentionDisplay().mentions);

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

interface SyntheticMessageInfo {
  icon: string;
  label: string;
}

function getSyntheticMessageInfo(item: ClaudeTranscriptItem): SyntheticMessageInfo | null {
  if (!item.isSynthetic || item.kind !== 'user') return null;
  const text = item.content ?? '';
  if (text === '[Request interrupted by user]' || text === '[Request interrupted by user for tool use]') {
    return { icon: 'lucideSquare', label: 'Request interrupted' };
  }
  if (text.startsWith("The user doesn't want to take this action right now.")) {
    return { icon: 'lucideBan', label: 'Action cancelled' };
  }
  if (text.startsWith("The user doesn't want to proceed with this tool use.")) {
    return { icon: 'lucideBan', label: 'Tool use rejected' };
  }
  if (text === 'No response requested.') {
    return null;
  }
  return { icon: 'lucideBan', label: 'Request stopped' };
}
