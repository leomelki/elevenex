import { AgentMarkdownComponent } from '@/shared/agent-chat/markdown/agent-markdown.component';
import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import type { LocalFileTarget } from '@/shared/models/local-file-target.model';
import type { PlanReviewRequest } from '@/shared/models/plan-review.model';
import type { SessionFork } from '@/shared/models/session.model';
import { parseDiffSelectionMentions } from '@/shared/utils/diff-selection-mention';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { parseTaskNotifications } from '@/shared/utils/task-notification';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBan, lucideSquare } from '@ng-icons/lucide';
import { MessageActionsComponent, type MessageActionState } from './message-actions.component';
import { MessageDiagnosticComponent } from './message-diagnostic.component';
import { MessageForksComponent } from './message-forks.component';
import { MessageMentionsComponent } from './message-mentions.component';
import { MessageNotificationsComponent } from './message-notifications.component';
import { MessagePlanLauncherComponent } from './message-plan-launcher.component';
import { formatMessageTimestamp } from './message-timestamp';

/** Message composition and selection; each presentation block owns its UI. */
@Component({
  selector: 'cw-message',
  imports: [
    AgentMarkdownComponent,
    NgIcon,
    MessageActionsComponent,
    MessageDiagnosticComponent,
    MessageForksComponent,
    MessageMentionsComponent,
    MessageNotificationsComponent,
    MessagePlanLauncherComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  viewProviders: [provideIcons({ lucideBan, lucideSquare })],
  templateUrl: './claude-message.component.html',
  styleUrl: './claude-message.component.scss',
})
export class ClaudeMessageComponent {
  private readonly elementRef = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly item = input.required<AgentTranscriptItem>();
  readonly worktreePath = input<string | null>(null);
  readonly streaming = input<boolean>(false);

  readonly showCopy = input<boolean>(false);
  readonly showEdit = input<boolean>(false);
  readonly showFork = input<boolean>(false);
  readonly actionsDisabled = input<boolean>(false);
  readonly editArmed = input<boolean>(false);
  readonly forkDisabled = input<boolean>(false);
  readonly forkDisabledReason = input<string>('');
  readonly forking = input<boolean>(false);
  readonly forks = input<readonly SessionFork[]>([]);
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

  readonly openPlanReview = output<PlanReviewRequest>();
  readonly openPlanChat = output<PlanReviewRequest>();
  readonly openLocalFile = output<LocalFileTarget>();

  readonly isUser = computed(() => this.item().kind === 'user');
  readonly syntheticMessageInfo = computed(() => getSyntheticMessageInfo(this.item()));
  readonly hasInlineAffordances = computed(
    () => this.showCopy() || this.showEdit() || this.showFork() || this.forks().length > 0,
  );
  readonly timestampLabel = computed(() => {
    const item = this.item();
    const value = item.receivedAt || item.authoredAt || item.timestamp;
    return value ? formatMessageTimestamp(value) : null;
  });
  readonly timestampTitle = this.timestampLabel;
  readonly actionState = computed<MessageActionState>(() => ({
    copy: this.showCopy(),
    edit: this.isUser() && this.showEdit(),
    fork: this.showFork(),
    disabled: this.actionsDisabled(),
    editArmed: this.editArmed(),
    forkDisabled: this.forkDisabled(),
    forkDisabledReason: this.forkDisabledReason(),
    forking: this.forking(),
  }));
  readonly userTaskNotificationDisplay = computed(() =>
    parseTaskNotifications(this.item().content),
  );
  readonly userTaskNotifications = computed(() => this.userTaskNotificationDisplay().notifications);
  readonly isTaskNotificationOnly = computed(
    () =>
      this.userTaskNotifications().length > 0 && !this.userTaskNotificationDisplay().text.trim(),
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

interface SyntheticMessageInfo {
  icon: string;
  label: string;
}

function getSyntheticMessageInfo(item: AgentTranscriptItem): SyntheticMessageInfo | null {
  if (!item.isSynthetic || item.kind !== 'user') return null;
  const text = item.content ?? '';
  if (
    text === '[Request interrupted by user]' ||
    text === '[Request interrupted by user for tool use]'
  ) {
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
