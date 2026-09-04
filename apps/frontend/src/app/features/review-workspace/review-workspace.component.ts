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
  untracked,
  viewChild,
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
import type {
  DiffSelectionMention,
  DiffSelectionMentionScope,
} from '@/shared/models/diff-selection-mention.model';
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
import {
  ReviewFileTabsComponent,
  isMarkdownPath,
  type ReviewFileTab,
} from './review-file-tabs.component';
import { ReviewMarkdownPreviewComponent } from './review-markdown-preview.component';
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
    ReviewFileTabsComponent,
    ReviewMarkdownPreviewComponent,
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
  private readonly diffPanel = viewChild(ChangeReviewPanelComponent);

  readonly fullFileMode = signal(true);
  /** Text handed to the session composer by "Ask in session". */
  readonly draftSeed = signal<string | null>(null);
  /** Worktree files opened explicitly, on top of the ones with a diff. */
  readonly extraFiles = signal<readonly string[]>([]);
  readonly fileOpenerVisible = signal(false);
  /**
   * Files open as tabs. Each remembers its own scroll offset and, for markdown,
   * whether it was left on rendered preview — so switching back restores where
   * you were rather than dumping you at the top.
   */
  readonly tabs = signal<readonly ReviewFileTab[]>([]);
  readonly activeTabPath = signal<string | null>(null);

  readonly activeTab = computed(
    () => this.tabs().find((tab) => tab.path === this.activeTabPath()) ?? null,
  );

  /** Markdown tabs left on preview render the document instead of the diff. */
  readonly showMarkdownPreview = computed(() => {
    const tab = this.activeTab();
    return tab !== null && tab.preview && isMarkdownPath(tab.path);
  });

  /**
   * Selection metadata for the markdown preview, taken from the diff panel so a
   * discussion started while reading a document anchors like a diff-made one.
   */
  readonly previewScope = computed<DiffSelectionMentionScope>(
    () => this.diffPanel()?.scope() ?? 'branch',
  );

  readonly previewChangeHash = computed(() => {
    const path = this.activeTabPath();
    if (!path) return null;
    return this.diffPanel()?.fileChangeHashes().get(path) ?? null;
  });

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

    // A deep-linked file opens as a tab, so it behaves like any other file the
    // user opened rather than being a special filtered mode.
    effect(() => {
      const path = this.focusFilePath();
      if (!path) return;
      untracked(() => {
        // Also register it as an extra file: a deep link may point at a file
        // with no diff in this scope, which would otherwise render blank.
        // `extraFileSummaries` drops paths that are already in the diff, so
        // this is a no-op for changed files.
        this.extraFiles.update((files) =>
          files.includes(path) ? files : [...files, path],
        );
        this.openTab(path);
      });
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
   * The preview has no diff panel underneath to handle "Ask in session" for it,
   * so route that here and send everything else down the shared path.
   */
  async onPreviewSelectionAction(event: {
    id: string;
    mentions: DiffSelectionMention[];
  }): Promise<void> {
    if (event.id === 'mention') {
      this.onMentionInSession(event.mentions);
      return;
    }
    await this.onSelectionAction(event);
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
    this.openTab(path, { extra: true });
  }

  /** Open a file as a tab, or focus it if it is already open. */
  openTab(path: string, options: { extra?: boolean } = {}): void {
    this.captureActiveScroll();
    if (!this.tabs().some((tab) => tab.path === path)) {
      this.tabs.update((tabs) => [
        ...tabs,
        {
          path,
          scrollTop: 0,
          // Markdown opens rendered: that is how you want to read a document,
          // and the toggle is one click away when you want the diff.
          preview: isMarkdownPath(path),
          extra: Boolean(options.extra),
        },
      ]);
    }
    this.activeTabPath.set(path);
    this.restoreActiveScroll();
  }

  /** `null` selects the "All changes" pseudo-tab (continuous stacked scroll). */
  selectTab(path: string | null): void {
    if (path === this.activeTabPath()) return;
    this.captureActiveScroll();
    this.activeTabPath.set(path);
    this.restoreActiveScroll();
  }

  closeTab(path: string): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.path === path);
    if (index < 0) return;

    const remaining = tabs.filter((tab) => tab.path !== path);
    this.tabs.set(remaining);
    this.extraFiles.update((files) => files.filter((file) => file !== path));

    if (this.activeTabPath() === path) {
      // Focus the neighbour, the way an editor does.
      const next = remaining[index] ?? remaining[index - 1] ?? null;
      this.activeTabPath.set(next?.path ?? null);
      this.restoreActiveScroll();
    }
  }

  toggleTabPreview(path: string): void {
    // Diff and preview scroll independently, so reset rather than restoring an
    // offset measured in the other view.
    this.tabs.update((tabs) =>
      tabs.map((tab) =>
        tab.path === path ? { ...tab, preview: !tab.preview, scrollTop: 0 } : tab,
      ),
    );
  }

  onPreviewScrolled(offset: number): void {
    this.rememberScroll(offset);
  }

  private captureActiveScroll(): void {
    if (this.showMarkdownPreview()) return; // the preview reports its own offset
    const panel = this.diffPanel();
    if (!panel) return;
    this.rememberScroll(panel.readScrollTop());
  }

  private restoreActiveScroll(): void {
    const tab = this.activeTab();
    if (!tab || this.showMarkdownPreview()) return;
    this.diffPanel()?.restoreScrollTop(tab.scrollTop);
  }

  private rememberScroll(offset: number): void {
    const active = this.activeTabPath();
    if (!active) return;
    this.tabs.update((tabs) =>
      tabs.map((tab) => (tab.path === active ? { ...tab, scrollTop: offset } : tab)),
    );
  }

  onPromoted(response: unknown): void {
    this.promoted.emit(response as CreateSessionForkResponse);
  }
}
