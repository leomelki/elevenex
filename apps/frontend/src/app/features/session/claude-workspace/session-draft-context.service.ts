import {
  ComposerImageAttachment,
  ComposerSendPayload,
} from '@/shared/agent-chat/composer/claude-composer.component';
import { ComposerDraftService } from '@/shared/agent-chat/composer/composer-draft.service';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type {
  SessionMention,
  SessionMentionCandidate,
} from '@/shared/models/session-mention.model';
import { WorktreeContextSnapshot } from '@/shared/models/worktree-context.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { ConversationForkDraftService } from '@/shared/services/conversation-fork-draft.service';
import { NavigationService } from '@/shared/services/navigation.service';
import { WorktreeContextService } from '@/shared/services/worktree-context.service';
import {
  appendDiffSelectionMentions,
  parseDiffSelectionMentions,
} from '@/shared/utils/diff-selection-mention';
import { appendSessionMentions, parseSessionMentions } from '@/shared/utils/session-mention';
import { DestroyRef, Injectable, computed, inject, linkedSignal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { toast } from 'ngx-sonner';
import { Subject, firstValueFrom } from 'rxjs';
import { SessionRuntime } from './session-runtime.service';
import { getHttpErrorMessage } from './workspace-error';

@Injectable()
export class SessionDraftContext {
  private readonly agentApi = inject(AgentRuntimeApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly runtime = inject(SessionRuntime);
  readonly focusRequested = new Subject<void>();

  private readonly forkDrafts = inject(ConversationForkDraftService);

  private readonly worktreeContextService = inject(WorktreeContextService);

  private readonly composerDrafts = inject(ComposerDraftService);

  readonly navigationService = inject(NavigationService);

  readonly prompt = signal('');

  readonly pendingDiffMentions = signal<DiffSelectionMention[]>([]);

  readonly pendingSessionMentions = signal<SessionMention[]>([]);

  readonly loadingSessionMentionId = signal<number | null>(null);

  readonly composerImages = signal<ComposerImageAttachment[]>([]);

  readonly worktreeContext = signal<WorktreeContextSnapshot | null>(null);

  readonly worktreeContextLoading = signal(false);

  readonly worktreeContextBusy = signal(false);

  readonly firstPromptContextEnabled = signal(true);

  readonly worktreeRootEditorOpen = signal(false);

  readonly draftRootRef = signal('');

  private deferredContextGenerationTimer: number | null = null;

  private composerDraftRevision = 0;
  private mentionRequestVersion = 0;

  private composerDraftRestoreVersion = 0;

  lastSubmittedPromptText = '';

  readonly sessionMentionCandidates = computed<SessionMentionCandidate[]>(() => {
    const candidates: SessionMentionCandidate[] = [];
    for (const project of this.navigationService.tree()) {
      for (const repo of project.repos) {
        for (const workspace of repo.workspaces ?? []) {
          for (const session of [...workspace.sessions, ...(workspace.archivedSessions ?? [])]) {
            if (session.id === this.runtime.sessionId) continue;
            candidates.push({
              sessionId: session.id,
              title: session.name?.trim() || `Session ${session.id}`,
              branch: session.branchName,
              status: session.status,
            });
          }
        }
      }
    }
    return candidates.sort((a, b) => a.title.localeCompare(b.title));
  });

  readonly promptIsCommand = computed(() => this.prompt().trimStart().startsWith('/'));

  readonly canAppendContext = computed(
    () =>
      this.firstPromptContextEnabled() &&
      !this.hasInjectedContext() &&
      !this.promptIsCommand() &&
      this.worktreeContext()?.generationStatus === 'ready' &&
      !!this.worktreeContext()?.contextSentence,
  );

  readonly hasInjectedContext = linkedSignal(() => this.runtime.hasInjectedWorktreeContext);

  readonly contextExpanded = signal(false);

  readonly contextPinState = computed<
    'idle' | 'loading' | 'generating' | 'ready' | 'failed' | 'empty'
  >(() => {
    if (this.worktreeContextLoading()) return 'loading';
    const ctx = this.worktreeContext();
    if (!ctx) return 'idle';
    if (ctx.generationStatus === 'generating') return 'generating';
    if (ctx.generationStatus === 'failed') return 'failed';
    if (ctx.contextSentence) return 'ready';
    if (!ctx.hasChanges) return 'empty';
    return 'idle';
  });

  readonly showContextPin = computed(() => {
    if (this.runtime.readOnlyTranscript && !this.runtime.terminalTranscriptMirror) return false;
    if (this.runtime.archived) return false;
    const hasTranscript = this.runtime.transcriptItems().length > 0 || this.runtime.submitting();
    if (hasTranscript) return false;
    if (this.worktreeContextLoading()) return true;
    const ctx = this.worktreeContext();
    if (!ctx) return false;
    if (ctx.generationStatus === 'failed') return true;
    if (ctx.generationStatus === 'generating') return true;
    if (ctx.contextSentence) return true;
    if (!ctx.hasChanges) return true;
    return false;
  });

  readonly contextPinLabel = computed(() => {
    switch (this.contextPinState()) {
      case 'loading':
        return 'Reading context…';
      case 'generating':
        return 'Summarizing…';
      case 'failed':
        return 'Context unavailable';
      case 'empty':
        return 'No changes';
      case 'ready':
        return 'Context';
      default:
        return 'Context';
    }
  });

  readonly contextPinSummary = computed(() => {
    const ctx = this.worktreeContext();
    if (!ctx) return '';
    if (ctx.contextSentence) return ctx.contextSentence;
    if (ctx.generationStatus === 'failed') return ctx.errorMessage ?? 'Generation failed';
    if (!ctx.hasChanges) return `No diff vs ${ctx.rootRef || 'auto'}`;
    return '';
  });

  readonly contextPinBadge = computed<{
    text: string;
    variant: 'accent' | 'muted' | 'warn';
  } | null>(() => {
    const ctx = this.worktreeContext();
    if (!ctx) return null;
    if (this.contextPinState() === 'failed') return { text: 'Failed', variant: 'warn' };
    if (this.hasInjectedContext() && this.firstPromptContextEnabled())
      return { text: 'Used', variant: 'muted' };
    if (!ctx.contextSentence) return null;
    if (this.promptIsCommand() && this.firstPromptContextEnabled())
      return { text: 'Skip', variant: 'muted' };
    return this.firstPromptContextEnabled()
      ? { text: 'On', variant: 'accent' }
      : { text: 'Off', variant: 'muted' };
  });

  readonly canToggleContextEnabled = computed(() => {
    const ctx = this.worktreeContext();
    return !!ctx?.contextSentence && !this.hasInjectedContext();
  });

  readonly firstMessageContext = computed(() => {
    if (!this.hasInjectedContext() || !this.firstPromptContextEnabled()) return null;
    const ctx = this.worktreeContext();
    const sentence = ctx?.contextSentence?.trim();
    if (!sentence) return null;
    return { sentence, rootRef: ctx?.rootRef ?? null };
  });
  constructor() {
    this.runtime.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      switch (event.type) {
        case 'reset':
          this.reset();
          break;
        case 'restore-draft':
          this.restoreInitialComposerDraft();
          break;
        case 'load-context':
          void this.loadWorktreeContext(false);
          break;
        case 'context-generation':
          this.scheduleDeferredContextGeneration();
          break;
        case 'session-change':
          void this.composerDrafts.flush(event.previousSessionId);
          break;
        case 'runtime-error':
          if (this.lastSubmittedPromptText && !this.prompt())
            this.onPromptChange(this.lastSubmittedPromptText);
          break;
      }
    });
    this.destroyRef.onDestroy(() => {
      this.composerDraftRestoreVersion++;
      if (this.deferredContextGenerationTimer !== null)
        window.clearTimeout(this.deferredContextGenerationTimer);
      void this.composerDrafts.flush(this.runtime.sessionId);
    });
  }
  reset(): void {
    this.mentionRequestVersion++;
    this.prompt.set('');

    this.pendingDiffMentions.set([]);

    this.pendingSessionMentions.set([]);

    this.loadingSessionMentionId.set(null);

    this.composerImages.set([]);

    this.worktreeContext.set(null);

    this.worktreeContextLoading.set(false);

    this.worktreeContextBusy.set(false);

    this.firstPromptContextEnabled.set(true);

    if (this.deferredContextGenerationTimer !== null) {
      window.clearTimeout(this.deferredContextGenerationTimer);
      this.deferredContextGenerationTimer = null;
    }

    this.worktreeRootEditorOpen.set(false);

    this.draftRootRef.set('');
    this.hasInjectedContext.set(this.runtime.hasInjectedWorktreeContext);
    this.lastSubmittedPromptText = '';
    this.markComposerDraftChanged();
  }

  toggleContextExpanded(): void {
    this.contextExpanded.update((v) => !v);
  }

  toggleContextEnabled(): void {
    if (!this.canToggleContextEnabled()) {
      this.toggleContextExpanded();
      return;
    }
    if (this.runtime.terminalTranscriptMirror) {
      this.firstPromptContextEnabled.set(false);
      void firstValueFrom(this.worktreeContextService.consume(this.runtime.sessionId, false)).catch(
        (err) => {
          console.warn('[worktree-context] failed to skip TUI context injection', err);
        },
      );
      void firstValueFrom(
        this.worktreeContextService.updateEnabled(
          this.runtime.repoId,
          this.runtime.worktreePath,
          false,
        ),
      ).catch((err) => {
        console.warn('[worktree-context] failed to persist context enabled state', err);
      });
      return;
    }
    this.firstPromptContextEnabled.update((v) => !v);
    void firstValueFrom(
      this.worktreeContextService.updateEnabled(
        this.runtime.repoId,
        this.runtime.worktreePath,
        this.firstPromptContextEnabled(),
      ),
    ).catch((err) => {
      console.warn('[worktree-context] failed to persist context enabled state', err);
    });
  }

  onPromptChange(value: string): void {
    this.prompt.set(value);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  onComposerImagesChange(images: ComposerImageAttachment[]): void {
    this.composerImages.set(images);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  addDiffMentions(mentions: readonly DiffSelectionMention[]): void {
    if (this.runtime.isTranscriptReadOnly() || !mentions.length) return;
    this.pendingDiffMentions.update((items) => [...items, ...mentions]);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
    queueMicrotask(() => this.focusRequested.next());
  }

  removeDiffMention(id: string): void {
    this.pendingDiffMentions.update((items) => items.filter((mention) => mention.id !== id));
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  async addSessionMention(sessionId: number): Promise<void> {
    if (this.pendingSessionMentions().length >= 3) {
      toast.error('You can mention up to 3 sessions in one message.');
      return;
    }
    if (
      this.runtime.isTranscriptReadOnly() ||
      sessionId === this.runtime.sessionId ||
      this.loadingSessionMentionId() !== null ||
      this.pendingSessionMentions().some((mention) => mention.sessionId === sessionId)
    )
      return;
    const version = this.runtime.bootstrapVersion;
    const originSessionId = this.runtime.sessionId;
    const requestVersion = ++this.mentionRequestVersion;
    const isCurrent = () =>
      this.runtime.isCurrentConversation(version) &&
      this.runtime.sessionId === originSessionId &&
      requestVersion === this.mentionRequestVersion;
    this.loadingSessionMentionId.set(sessionId);
    try {
      const mention = await firstValueFrom(this.agentApi.getConversationMention(sessionId));
      if (!isCurrent()) return;
      this.pendingSessionMentions.update((items) => [...items, mention]);
      this.markComposerDraftChanged();
      this.persistComposerDraft();
      queueMicrotask(() => this.focusRequested.next());
    } catch (error) {
      if (isCurrent()) toast.error(getHttpErrorMessage(error, 'Could not mention that session.'));
    } finally {
      if (isCurrent() && this.loadingSessionMentionId() === sessionId)
        this.loadingSessionMentionId.set(null);
    }
  }

  restoreMessage(content: string): void {
    const sessions = parseSessionMentions(content);
    const diff = parseDiffSelectionMentions(sessions.text);
    this.prompt.set(diff.text);
    this.pendingDiffMentions.set(diff.mentions);
    this.pendingSessionMentions.set(sessions.mentions);
    this.composerImages.set([]);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
    this.focusRequested.next();
  }

  removeSessionMention(sessionId: number): void {
    this.pendingSessionMentions.update((items) =>
      items.filter((mention) => mention.sessionId !== sessionId),
    );
    this.markComposerDraftChanged();
    this.persistComposerDraft();
  }

  async submitPrompt(payload: ComposerSendPayload | string): Promise<void> {
    if (this.runtime.isTranscriptReadOnly()) return;
    const normalized: ComposerSendPayload =
      typeof payload === 'string'
        ? { text: payload, images: [], diffMentions: [], sessionMentions: [] }
        : payload;
    const trimmed = normalized.text.trim();
    const diffMentions = normalized.diffMentions ?? [];
    const sessionMentions = normalized.sessionMentions ?? [];
    const visiblePrompt =
      trimmed ||
      (sessionMentions.length
        ? 'Use the mentioned session context.'
        : diffMentions.length
          ? 'Review the mentioned diff selection.'
          : '');
    const promptWithDiffMentions = appendDiffSelectionMentions(visiblePrompt, diffMentions);
    const promptWithMentions = appendSessionMentions(promptWithDiffMentions, sessionMentions);
    const images = this.runtime.currentProviderSupportsImages() ? normalized.images : [];
    if (!promptWithMentions.trim() && !images.length) return;
    const optimisticContent = images.length
      ? [promptWithMentions, ...images.map(() => '[image]')].filter(Boolean).join('\n')
      : promptWithMentions;
    if (!this.runtime.acceptPrompt(optimisticContent)) return;
    this.lastSubmittedPromptText = normalized.text;
    this.mentionRequestVersion++;
    this.loadingSessionMentionId.set(null);
    this.prompt.set('');
    this.pendingDiffMentions.set([]);
    this.pendingSessionMentions.set([]);
    this.composerImages.set([]);
    this.markComposerDraftChanged();
    this.clearComposerDraft();
    const prepared = this.prepareRuntimePrompt(promptWithMentions);
    this.runtime.sendRuntimeAction({
      type: 'submit_prompt',
      prompt: prepared.prompt,
      titlePrompt: visiblePrompt,
      ...(images.length ? { images: images.map((i) => this.toRuntimeImage(i)) } : {}),
    });
    if (prepared.consumedContextSentence) {
      this.markWorktreeContextConsumed(prepared.consumedContextSentence);
    }
  }

  private toRuntimeImage(img: ComposerImageAttachment): {
    mediaType: ComposerImageAttachment['mediaType'];
    data: string;
  } {
    const commaIdx = img.dataUrl.indexOf(',');
    const data = commaIdx >= 0 ? img.dataUrl.slice(commaIdx + 1) : img.dataUrl;
    return { mediaType: img.mediaType, data };
  }

  restoreInitialComposerDraft(): void {
    if (this.runtime.isTranscriptReadOnly()) return;
    if (this.applyPendingForkDraft()) return;
    this.restoreSavedComposerDraft();
  }

  private applyPendingForkDraft(): boolean {
    const draft = this.forkDrafts.consumeDraft(this.runtime.sessionId);
    if (!draft) return false;
    const parsedSessions = parseSessionMentions(draft);
    const parsed = parseDiffSelectionMentions(parsedSessions.text);
    this.prompt.set(parsed.text);
    this.pendingDiffMentions.set(parsed.mentions);
    this.pendingSessionMentions.set(parsedSessions.mentions);
    this.composerImages.set([]);
    this.markComposerDraftChanged();
    this.persistComposerDraft();
    queueMicrotask(() => this.focusRequested.next());
    return true;
  }

  private restoreSavedComposerDraft(): void {
    const sessionId = this.runtime.sessionId;
    const restoreVersion = ++this.composerDraftRestoreVersion;
    const revision = this.composerDraftRevision;

    void this.composerDrafts.load(sessionId).then((draft) => {
      if (!draft) return;
      if (restoreVersion !== this.composerDraftRestoreVersion) return;
      if (sessionId !== this.runtime.sessionId || this.runtime.isTranscriptReadOnly()) return;
      if (revision !== this.composerDraftRevision) return;

      this.prompt.set(draft.text);
      this.pendingDiffMentions.set(draft.diffMentions);
      this.pendingSessionMentions.set(draft.sessionMentions);
      this.composerImages.set(draft.images);
      queueMicrotask(() => this.focusRequested.next());
    });
  }

  markComposerDraftChanged(): void {
    this.composerDraftRevision += 1;
    this.composerDraftRestoreVersion += 1;
  }

  persistComposerDraft(): void {
    if (this.runtime.isTranscriptReadOnly()) return;
    this.composerDrafts.save({
      sessionId: this.runtime.sessionId,
      text: this.prompt(),
      diffMentions: this.pendingDiffMentions(),
      sessionMentions: this.pendingSessionMentions(),
      images: this.composerImages(),
    });
  }

  private clearComposerDraft(): void {
    this.composerDrafts.delete(this.runtime.sessionId);
  }

  onRootRefInput(value: string): void {
    this.draftRootRef.set(value);
  }

  openRootRefEditor(): void {
    this.worktreeRootEditorOpen.set(true);
    this.draftRootRef.set(this.worktreeContext()?.rootRef ?? '');
  }

  cancelRootRefEditor(): void {
    this.worktreeRootEditorOpen.set(false);
    this.draftRootRef.set(this.worktreeContext()?.rootRef ?? '');
  }

  async saveRootRef(): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    const rootRef = this.draftRootRef().trim() || null;
    this.worktreeContextBusy.set(true);
    try {
      await firstValueFrom(
        this.worktreeContextService.updateRootRef(
          this.runtime.repoId,
          this.runtime.worktreePath,
          rootRef,
        ),
      );
      if (!this.runtime.isCurrentConversation(version)) return;
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.runtime.repoId, this.runtime.worktreePath, {
          force: true,
          rootRef,
          provider: this.runtime.currentProvider(),
        }),
      );
      if (!this.runtime.isCurrentConversation(version)) return;
      this.worktreeContext.set(snapshot);
      this.worktreeRootEditorOpen.set(false);
    } catch (error) {
      if (this.runtime.isCurrentConversation(version))
        toast.error(getHttpErrorMessage(error, 'Could not update the comparison root.'));
    } finally {
      if (this.runtime.isCurrentConversation(version)) this.worktreeContextBusy.set(false);
    }
  }

  async recomputeWorktreeContext(): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    if (this.worktreeContextBusy()) return;
    this.worktreeContextBusy.set(true);
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.generate(this.runtime.repoId, this.runtime.worktreePath, {
          force: true,
          provider: this.runtime.currentProvider(),
        }),
      );
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContext.set(snapshot);
    } catch (error) {
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      toast.error(getHttpErrorMessage(error, 'Could not recompute worktree context.'));
    } finally {
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContextBusy.set(false);
    }
  }

  private async loadWorktreeContext(triggerGenerate = true): Promise<void> {
    const version = this.runtime.bootstrapVersion;
    this.worktreeContextLoading.set(true);
    const deferGeneration =
      triggerGenerate &&
      (!this.runtime.runtimeStarted() ||
        this.runtime.runPhase() !== 'idle' ||
        this.runtime.submitting());
    try {
      const snapshot = await firstValueFrom(
        this.worktreeContextService.get(this.runtime.repoId, this.runtime.worktreePath, {
          cachedOnly: !triggerGenerate || deferGeneration,
        }),
      );
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContext.set(snapshot);
      this.draftRootRef.set(snapshot.rootRef ?? '');
      if (!this.hasInjectedContext()) {
        this.firstPromptContextEnabled.set(snapshot.contextEnabled ?? true);
      }

      const shouldAutoGenerate =
        triggerGenerate &&
        !deferGeneration &&
        !snapshot.hasRecord &&
        snapshot.canGenerate &&
        snapshot.generationStatus !== 'generating' &&
        !this.worktreeContextBusy();

      if (shouldAutoGenerate) {
        console.info(
          `[worktree-context] no prior record for ${this.runtime.worktreePath}; requesting first-time generation`,
        );
        this.worktreeContextBusy.set(true);
        const generated = await firstValueFrom(
          this.worktreeContextService.generate(this.runtime.repoId, this.runtime.worktreePath, {
            provider: this.runtime.currentProvider(),
          }),
        );
        if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
        this.worktreeContext.set(generated);
        console.info(
          `[worktree-context] first-time generation settled for ${this.runtime.worktreePath} (status=${generated.generationStatus})`,
        );
      } else if (triggerGenerate) {
        console.info(
          `[worktree-context] skipping auto-generate for ${this.runtime.worktreePath} (hasRecord=${snapshot.hasRecord}, canGenerate=${snapshot.canGenerate}, status=${snapshot.generationStatus})`,
        );
        if (deferGeneration) {
          this.scheduleDeferredContextGeneration();
        }
      }
    } catch (error) {
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      toast.error(getHttpErrorMessage(error, 'Could not load worktree context.'));
    } finally {
      if (version !== this.runtime.bootstrapVersion || this.destroyRef.destroyed) return;
      this.worktreeContextLoading.set(false);
      this.worktreeContextBusy.set(false);
    }
  }

  scheduleDeferredContextGeneration(): void {
    if (this.runtime.readOnlyTranscript) return;
    if (!this.runtime.runtimeStarted()) return;
    if (this.hasInjectedContext()) return;
    const context = this.worktreeContext();
    if (!context?.canGenerate || context.contextSentence) return;
    if (this.deferredContextGenerationTimer !== null) return;

    this.deferredContextGenerationTimer = window.setTimeout(() => {
      this.deferredContextGenerationTimer = null;
      if (
        !this.runtime.runtimeStarted() ||
        this.hasInjectedContext() ||
        this.runtime.runPhase() !== 'idle' ||
        this.runtime.submitting() ||
        this.worktreeContextBusy() ||
        this.worktreeContextLoading() ||
        this.worktreeContext()?.contextSentence
      ) {
        this.scheduleDeferredContextGeneration();
        return;
      }
      void this.loadWorktreeContext(true);
    }, 1500);
  }

  private prepareRuntimePrompt(prompt: string): {
    prompt: string;
    consumedContextSentence: string | null;
  } {
    if (
      this.hasInjectedContext() ||
      !this.firstPromptContextEnabled() ||
      prompt.trimStart().startsWith('/')
    ) {
      return { prompt, consumedContextSentence: null };
    }

    const localContextSentence = this.worktreeContext()?.contextSentence?.trim();
    if (this.worktreeContext()?.generationStatus !== 'ready' || !localContextSentence) {
      return { prompt, consumedContextSentence: null };
    }

    this.hasInjectedContext.set(true);
    this.worktreeContext.update((snapshot) =>
      snapshot ? { ...snapshot, lastUsedAt: new Date().toISOString() } : snapshot,
    );
    return {
      prompt: buildWorktreeContextPrompt(localContextSentence, prompt),
      consumedContextSentence: localContextSentence,
    };
  }

  private markWorktreeContextConsumed(contextSentence: string): void {
    void firstValueFrom(
      this.worktreeContextService.consume(this.runtime.sessionId, true, contextSentence),
    ).catch((error) => {
      console.warn('[worktree-context] failed to mark first-message context consumed', error);
    });
  }
}

function buildWorktreeContextPrompt(contextSentence: string, prompt: string): string {
  return [
    '<elevenex-worktree-context>',
    `Context for this session: ${contextSentence}`,
    '</elevenex-worktree-context>',
    '',
    prompt,
  ].join('\n');
}
