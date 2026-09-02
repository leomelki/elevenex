import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowLeft,
  lucideFileCode,
  lucideFilePlus,
  lucideMessageSquarePlus,
  lucideSparkles,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import type { AgentProviderId } from '@/shared/models/agent-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { CreateSessionForkResponse } from '@/shared/models/session.model';
import { appendDiffSelectionMentions } from '@/shared/utils/diff-selection-mention';
import {
  ZardResizableComponent,
  ZardResizableHandleComponent,
  ZardResizablePanelComponent,
} from '@/shared/components/resizable';
import { ChangeReviewPanelComponent } from '@/features/change-review/change-review-panel.component';
import type { DiffSelectionMenuAction } from '@/features/change-review/diff-selection-menu.component';
import { ReviewFileOpenerComponent } from './review-file-opener.component';
import { ReviewThreadDockComponent } from './review-thread-dock.component';
import {
  ReviewWorkspaceStateService,
  SESSION_TAB_ID,
} from './review-workspace-state.service';

/** Providers that can fork a conversation; the rest cannot host discussions. */
const FORKABLE_PROVIDERS: readonly AgentProviderId[] = ['claude', 'codex'];

@Component({
  selector: 'app-review-workspace',
  standalone: true,
  imports: [
    CommonModule,
    NgIcon,
    ZardResizableComponent,
    ZardResizableHandleComponent,
    ZardResizablePanelComponent,
    ChangeReviewPanelComponent,
    ReviewFileOpenerComponent,
    ReviewThreadDockComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowLeft,
      lucideFileCode,
      lucideFilePlus,
      lucideMessageSquarePlus,
      lucideSparkles,
    }),
  ],
  templateUrl: './review-workspace.component.html',
  styleUrl: './review-workspace.component.scss',
})
export class ReviewWorkspaceComponent {
  readonly sessionId = input.required<number>();
  readonly worktreePath = input.required<string>();
  readonly provider = input.required<AgentProviderId>();
  /** Deep-link target: focus this discussion once loaded. */
  readonly focusThreadId = input<number | null>(null);
  /** Deep-link target: show this file when the workspace opens. */
  readonly focusFilePath = input<string | null>(null);

  readonly exit = output<void>();
  readonly promoted = output<CreateSessionForkResponse>();

  readonly state = inject(ReviewWorkspaceStateService);

  readonly fullFileMode = signal(true);
  /** Text handed to the session composer by "Ask in session". */
  readonly draftSeed = signal<string | null>(null);
  /** Worktree files opened explicitly, on top of the ones with a diff. */
  readonly extraFiles = signal<readonly string[]>([]);
  readonly fileOpenerVisible = signal(false);
  /** Rail filter, driven by the `?file=` deep link. */
  readonly fileFilter = signal<string | null>(null);

  readonly canFork = computed(() =>
    FORKABLE_PROVIDERS.includes(this.provider()),
  );

  /**
   * Actions offered over a diff selection. "Add to discussion" only appears
   * once there is one to add to, and forking is hidden entirely for providers
   * that cannot do it rather than failing on click.
   */
  readonly selectionActions = computed<DiffSelectionMenuAction[]>(() => {
    const actions: DiffSelectionMenuAction[] = [];
    if (this.canFork()) {
      actions.push({
        id: 'new-thread',
        label: 'New discussion',
        icon: 'lucideSparkles',
        primary: true,
      });
    }
    if (this.canFork() && this.state.openChats().length) {
      actions.push({
        id: 'add-to-thread',
        label: 'Add to current',
        icon: 'lucideMessageSquarePlus',
      });
    }
    actions.push({
      id: 'mention',
      label: 'Ask in session',
      icon: 'lucideMessageSquarePlus',
    });
    return actions;
  });

  /**
   * Discussions whose anchored file has moved on. Computed from the anchor's
   * own recorded identity, so it stays honest without re-fetching anything.
   */
  readonly staleThreadIds = computed(() => {
    const stale = new Set<number>();
    for (const chat of this.state.openChats()) {
      if (chat.status === 'promoted') continue;
      // Without a recorded change hash there is nothing to compare against, so
      // treat it as current rather than crying wolf.
      if (chat.changeHash && chat.anchors[0]?.changeHash !== chat.changeHash) {
        stale.add(chat.id);
      }
    }
    return stale;
  });

  constructor() {
    effect(() => {
      const sessionId = this.sessionId();
      void this.state.load(sessionId);
    });

    // A deep-linked file is filtered in the rail rather than merely scrolled
    // to, so it is unambiguous which file the link meant — including when the
    // file has no diff and was never in the list.
    effect(() => {
      const path = this.focusFilePath();
      if (!path) return;
      this.fileFilter.set(path);
      this.extraFiles.update((files) =>
        files.includes(path) ? files : [...files, path],
      );
    });

    effect(() => {
      const target = this.focusThreadId();
      if (target === null) return;
      const exists = this.state.chats().some((chat) => chat.id === target);
      if (exists) this.state.focusThread(target);
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.exit.emit();
  }

  toggleFullFile(): void {
    this.fullFileMode.update((value) => !value);
  }

  async onSelectionAction(event: {
    id: string;
    mentions: DiffSelectionMention[];
  }): Promise<void> {
    if (!event.mentions.length) return;

    if (event.id === 'new-thread') {
      const chat = await this.state.createThread(event.mentions, {
        scope: event.mentions[0].scope,
      });
      if (chat) {
        toast.success('Discussion started', { description: chat.title });
      }
      return;
    }

    if (event.id === 'add-to-thread') {
      const target = this.state.activeChat() ?? this.state.openChats()[0];
      if (!target) return;
      await this.state.addAnchors(target.id, event.mentions);
      toast.success('Added to discussion', { description: target.title });
    }
  }

  /**
   * "Ask in session" switches to the session tab and drops the serialized
   * selection into its composer, so the user adds their question and sends it
   * to the main session — the same mention format the Claude composer uses.
   */
  onMentionInSession(mentions: readonly DiffSelectionMention[]): void {
    if (!mentions.length) return;
    this.state.activeThreadId.set(SESSION_TAB_ID);
    this.draftSeed.set(appendDiffSelectionMentions('', mentions));
  }

  openWorktreeFile(path: string): void {
    this.fileOpenerVisible.set(false);
    this.extraFiles.update((files) =>
      files.includes(path) ? files : [...files, path],
    );
  }

  closeWorktreeFile(path: string): void {
    this.extraFiles.update((files) => files.filter((file) => file !== path));
  }

  onPromoted(response: unknown): void {
    this.promoted.emit(response as CreateSessionForkResponse);
  }
}
