import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  AgentImageInput,
  AgentProviderModelCatalogPayload,
  AgentRuntimeProvider,
  AgentTranscriptItem,
  InteractivePromptOrigin,
} from '../agent-runtime/agent-runtime.types.js';
import { QueuedPromptDispatches } from '../agent-runtime/queued-prompt-dispatches.js';
import { TurnChangesService } from '../agent-runtime/turn-changes.service.js';
import type { TurnChangeCapture } from '../agent-runtime/turn-changes.service.js';
import type {
  ClaudePendingPrompt,
  ClaudeRunPhase,
} from '../claude-runtime/claude-runtime.types.js';
import {
  buildAugmentedEnvAsync,
  findBinaryAsync,
} from '../config/system-paths.js';
import { DRIZZLE, type DrizzleDB } from '../database/database.provider.js';
import { antigravityTurns, sessions } from '../database/schema/index.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AcpRequestError, AcpStdio, acpObject } from './acp-stdio.js';
import {
  ANTIGRAVITY_INSTALL,
  ANTIGRAVITY_PROVIDER,
  ANTIGRAVITY_SIGN_IN,
  AntigravityTurn,
  acpText,
  antigravityEnvironment,
  initializeAntigravity,
  sessionOptions,
} from './antigravity-acp.js';
import { AntigravityCatalog } from './antigravity-catalog.js';
import {
  AntigravityDecisions,
  type AntigravityAnswer,
} from './antigravity-decisions.js';
import {
  AntigravityQuota,
  acpContextUsage,
  acpQuotaTier,
  antigravityQuotaFailure,
  type AntigravityContextUsage,
} from './antigravity-usage.js';

type Session = Awaited<ReturnType<SessionsService['findOne']>>;
type Selection = NonNullable<Session['antigravitySelection']>;
interface Entry {
  id: number;
  nativeId: string | null;
  selection: Selection;
  transport?: AcpStdio;
  options: ReturnType<typeof sessionOptions>;
  defaults: { model?: string; thought?: string; mode?: string };
  imagePrompts: boolean;
  decisions: AntigravityDecisions;
  pendingPrompts: ClaudePendingPrompt[];
  liveItems: AgentTranscriptItem[];
  queuePaused: boolean;
  turn?: AntigravityTurn;
  storedTurnId?: number;
  run?: Promise<void>;
  stopping: boolean;
  closed: boolean;
  error: string | null;
  idleTimer?: NodeJS.Timeout;
  stopTimer?: NodeJS.Timeout;
  updateTimer?: NodeJS.Timeout;
}

const IDLE_TIMEOUT = 60_000;
const CANCEL_TIMEOUT = 5_000;
const QUEUE_LIMIT = 8;
/** Context outlives idle CLI processes; bound it for long-running backends. */
const CONTEXT_LIMIT = 256;
const ANTIGRAVITY_QUOTA =
  'This model has used its Antigravity quota. Choose another model, or send again after it resets.';

@Injectable()
export class AntigravityRuntimeProvider
  extends EventEmitter
  implements AgentRuntimeProvider, OnModuleDestroy
{
  readonly info = ANTIGRAVITY_PROVIDER;
  private readonly entries = new Map<number, Entry>();
  private readonly dispatches = new QueuedPromptDispatches();
  private readonly logger = new Logger(AntigravityRuntimeProvider.name);
  /** Quota is metered per Google account, so every conversation shares it. */
  private readonly quota = new AntigravityQuota(() => {
    for (const id of this.entries.keys()) this.emitState(id);
  });
  private readonly catalog = new AntigravityCatalog((opened) =>
    this.quota.observeTier(acpQuotaTier(opened)),
  );
  private readonly contexts = new Map<number, AntigravityContextUsage>();
  private destroyed = false;

  constructor(
    private readonly sessionService: SessionsService,
    private readonly settings: SettingsService,
    private readonly changes: TurnChangesService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {
    super();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    await Promise.all([
      this.catalog.close(),
      ...[...this.entries.keys()].map((id) => this.cleanupSession(id)),
    ]);
  }

  async getHistory(sessionId: number, options?: { changeDetails?: 'summary' }) {
    const session = await this.sessionService.findOne(sessionId);
    const nativeId = session.antigravitySessionId;
    if (!nativeId) return [];
    const activeTurn = this.entries.get(sessionId)?.storedTurnId;
    const rows = this.db
      .select({ items: antigravityTurns.items })
      .from(antigravityTurns)
      .where(
        and(
          eq(antigravityTurns.sessionId, sessionId),
          activeTurn === undefined
            ? undefined
            : ne(antigravityTurns.id, activeTurn),
        ),
      )
      .orderBy(antigravityTurns.id)
      .all();
    return this.changes.attachHistory(
      sessionId,
      this.info.id,
      nativeId,
      rows.flatMap((row) => row.items),
      options?.changeDetails,
    );
  }

  private selection(session: Session): Selection {
    if (session.antigravitySelection) return session.antigravitySelection;
    if (session.antigravitySessionId) return {};
    const defaults = this.settings.getAgentProviderDefaults(this.info.id);
    return { model: defaults.model, reasoningEffort: defaults.reasoningEffort };
  }

  private currentSelection(session: Session): Selection {
    // Read immediately before merging a change or reserving a turn. Another
    // window can save preferences while findOne is still resolving.
    const current = this.db
      .select({ selection: sessions.antigravitySelection })
      .from(sessions)
      .where(this.activeSession(session.id))
      .get();
    return current?.selection ?? this.selection(session);
  }

  private modelList(options: Entry['options']) {
    const reasoningEfforts = options.thought?.values.map((value) => value.id);
    return (options.model?.values ?? []).map((model) => ({
      ...model,
      ...(model.id === options.model?.current && reasoningEfforts?.length
        ? { reasoningEfforts, supportsEffort: true }
        : {}),
    }));
  }

  async getModelCatalog(
    refresh = false,
  ): Promise<AgentProviderModelCatalogPayload> {
    const catalog = await this.catalog.load(refresh);
    const options = catalog?.options ?? {};
    return {
      models: this.modelList(options),
      reasoningEfforts: options.thought?.values.map((value) => value.id) ?? [],
      providerDefaultModelId: options.model?.current || null,
      providerDefaultReasoningEffort: options.thought?.current ?? null,
      supportsModelSelection: true,
      unavailableReason: catalog?.unavailableReason ?? null,
    };
  }

  async getRuntimeState(sessionId: number) {
    const entry = this.entries.get(sessionId);
    const session = entry
      ? undefined
      : await this.sessionService.findOne(sessionId);
    const selection =
      entry?.selection ?? (session ? this.selection(session) : {});
    const options = entry?.options.model
      ? entry.options
      : (this.catalog.current()?.options ?? {});
    const mode = this.modeOption(entry);
    const permissionModes = mode?.values.map(({ id }) => id) ?? [];
    const preferredMode = selection.mode === null
      ? entry?.defaults.mode ?? mode?.current
      : selection.mode ?? mode?.current;
    const phase = this.phase(entry);
    const decision = entry?.decisions.current;
    return {
      sessionId,
      runPhase: phase,
      claudeSessionId: entry?.nativeId ?? session?.antigravitySessionId ?? null,
      sessionState:
        phase === 'waiting'
          ? 'requires_action'
          : phase === 'running'
            ? 'running'
            : 'idle',
      canInterrupt: !!entry?.run,
      canSteer: false,
      selectedModel: selection.model ?? options.model?.current ?? null,
      reasoningEffort:
        selection.reasoningEffort ?? options.thought?.current ?? null,
      permissionMode:
        permissionModes.find((id) => id === preferredMode) ??
        permissionModes.find((id) => id === mode?.current) ??
        null,
      permissionModes,
      availableModels: this.modelList(options),
      pendingPermissionRequest:
        decision?.kind === 'permission' ? decision.view : null,
      pendingUserInputRequest:
        decision?.kind === 'question' ? decision.view : null,
      pendingPrompts: entry?.pendingPrompts.slice() ?? [],
      dispatchingPrompts: entry ? this.dispatches.current(entry) : [],
      liveItems: entry?.liveItems.slice() ?? [],
      queuePaused: entry?.queuePaused ?? false,
      lastError: entry?.error ?? null,
      contextUsage: this.contexts.get(sessionId) ?? null,
      modelQuota: this.quota.snapshot(),
    };
  }

  async getSnapshot(sessionId: number) {
    const history = await this.getHistory(sessionId);
    return { ...(await this.getRuntimeState(sessionId)), history };
  }

  getAutocompleteItems() {
    return Promise.resolve([]);
  }

  async setSelectedModel(sessionId: number, model: string | null) {
    return this.setSelection(sessionId, { model });
  }

  async setReasoningEffort(sessionId: number, reasoningEffort: string | null) {
    return this.setSelection(sessionId, { reasoningEffort });
  }

  async setPermissionMode(sessionId: number, mode: string | null) {
    return this.setSelection(sessionId, { mode });
  }

  private modeOption(entry?: Entry) {
    return entry?.options.model || entry?.options.mode
      ? entry.options.mode
      : this.catalog.mode;
  }

  private async setSelection(sessionId: number, patch: Selection) {
    const session = await this.sessionService.findOne(sessionId);
    this.assertInteractiveSession(session);
    const entry = this.entries.get(sessionId);
    if (entry?.run)
      throw new ConflictException(
        'Wait for Antigravity to finish before changing its configuration.',
      );
    const options = entry?.options ?? this.catalog.current()?.options;
    if (
      patch.mode != null &&
      !this.modeOption(entry)?.values.some(({ id }) => id === patch.mode)
    )
      throw new BadRequestException('This Antigravity mode is unavailable.');
    if (
      patch.model &&
      options?.model &&
      !options.model.values.some((value) => value.id === patch.model)
    )
      throw new BadRequestException('This Antigravity model is unavailable.');
    if (
      patch.reasoningEffort &&
      options?.thought &&
      !options.thought.values.some(
        (value) => value.id === patch.reasoningEffort,
      )
    )
      throw new BadRequestException(
        'This Antigravity thinking level is unavailable.',
      );
    const selection = { ...this.currentSelection(session), ...patch };
    const updated = this.db
      .update(sessions)
      .set({ antigravitySelection: selection })
      .where(this.activeSession(sessionId))
      .run();
    if (!updated.changes)
      throw new ConflictException(
        'The Antigravity session changed. Refresh the conversation.',
      );
    if (entry) entry.selection = selection;
    this.emitState(sessionId);
    return this.getRuntimeState(sessionId);
  }

  async submitPrompt(
    sessionId: number,
    prompt: string,
    titlePrompt?: string,
    images?: AgentImageInput[],
    options?: {
      origin?: InteractivePromptOrigin;
      queue?: boolean;
      waitForCompletion?: boolean;
    },
  ): Promise<void> {
    this.assertInteractiveOrigin(options?.origin);
    if (!prompt.trim() || prompt.length > 1_000_000)
      throw new BadRequestException('Invalid Antigravity message.');
    const session = await this.sessionService.findOne(sessionId);
    this.assertInteractiveSession(session);
    const entry = this.entry(session);
    if (entry.run || entry.queuePaused || entry.pendingPrompts.length) {
      if ((entry.run || entry.queuePaused) && options?.queue !== true)
        throw new ConflictException(
          'Queue the message while Antigravity is busy or its queue is paused.',
        );
      if (entry.pendingPrompts.length >= QUEUE_LIMIT)
        throw new BadRequestException(
          `Antigravity can queue up to ${QUEUE_LIMIT} messages.`,
        );
      const attachmentSize = (attachments?: AgentImageInput[]) =>
        attachments?.reduce((size, image) => size + image.data.length, 0) ?? 0;
      if (
        entry.pendingPrompts.reduce(
          (size, item) => size + attachmentSize(item.images),
          attachmentSize(images),
        ) > 24_000_000
      )
        throw new BadRequestException(
          'The Antigravity queue has too many image attachments.',
        );
      entry.pendingPrompts.push({
        id: randomUUID(),
        prompt,
        images,
        queuedAt: new Date().toISOString(),
      });
      if (entry.stopping) entry.queuePaused = true;
      this.emitState(entry.id);
      return;
    }
    const run = this.startRun(entry, session, prompt, titlePrompt, images);
    await run.receipt;
    if (options?.waitForCompletion !== false) await run.completed;
  }

  private assertInteractiveOrigin(origin?: InteractivePromptOrigin) {
    if (origin !== 'desktop-chat')
      throw new BadRequestException(
        'Send Antigravity messages directly from an Elevenex desktop conversation.',
      );
  }

  private assertInteractiveSession(session: Session) {
    if (
      this.destroyed ||
      session.activeAgentProvider !== this.info.id ||
      session.surface !== 'session' ||
      session.status === 'archived' ||
      session.workspaceArchivedAt ||
      !session.worktreePath
    )
      throw new BadRequestException(
        'Antigravity needs an open desktop session with an available task workspace.',
      );
  }

  private activeSession(id: number) {
    return and(
      eq(sessions.id, id),
      eq(sessions.activeAgentProvider, this.info.id),
      eq(sessions.surface, 'session'),
      ne(sessions.status, 'archived'),
    );
  }

  private entry(session: Session): Entry {
    const existing = this.entries.get(session.id);
    if (existing) return existing;
    const entry: Entry = {
      id: session.id,
      nativeId: session.antigravitySessionId,
      selection: this.currentSelection(session),
      options: {},
      defaults: {},
      imagePrompts: false,
      decisions: new AntigravityDecisions(() => this.emitState(session.id)),
      pendingPrompts: [],
      liveItems: [],
      queuePaused: false,
      stopping: false,
      closed: false,
      error: null,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  private assertOpen(entry: Entry) {
    if (entry.closed || entry.stopping)
      throw new Error('Antigravity turn was stopped.');
  }

  private async connect(entry: Entry, cwd: string): Promise<AcpStdio> {
    if (entry.transport && !entry.transport.closed) return entry.transport;
    const [binary, env] = await Promise.all([
      findBinaryAsync('agy'),
      buildAugmentedEnvAsync(process.env, cwd),
    ]);
    this.assertOpen(entry);
    if (!binary) throw new BadRequestException(ANTIGRAVITY_INSTALL);
    const transport = new AcpStdio(binary, cwd, antigravityEnvironment(env), {
      notification: (method, params) =>
        this.notification(entry, method, params),
      request: (method, params) => this.decision(entry, method, params),
    });
    entry.transport = transport;
    const capabilities = await initializeAntigravity(transport);
    this.assertOpen(entry);
    entry.imagePrompts =
      acpObject(capabilities.promptCapabilities).image === true;
    const sessionParams = { cwd, mcpServers: [] };
    const isNewSession = !entry.nativeId;
    const resume = acpObject(capabilities.sessionCapabilities).resume;
    if (
      entry.nativeId &&
      (resume === undefined || resume === null) &&
      capabilities.loadSession !== true
    )
      throw new Error(
        'Update the Antigravity CLI to resume this conversation.',
      );
    const opened = entry.nativeId
      ? await transport.request(
          resume !== undefined && resume !== null
            ? 'session/resume'
            : 'session/load',
          { ...sessionParams, sessionId: entry.nativeId },
        )
      : await transport.request('session/new', sessionParams);
    this.assertOpen(entry);
    if (!entry.nativeId) {
      const nativeId = opened.sessionId;
      if (
        typeof nativeId !== 'string' ||
        !nativeId.trim() ||
        nativeId.length > 1000
      )
        throw new Error('Antigravity did not return a valid session ID.');
      const updated = this.db
        .update(sessions)
        .set({
          antigravitySessionId: nativeId,
          antigravitySelection: entry.selection,
        })
        .where(
          and(
            this.activeSession(entry.id),
            isNull(sessions.antigravitySessionId),
          ),
        )
        .run();
      if (!updated.changes)
        throw new ConflictException(
          'The session changed while starting Antigravity.',
        );
      entry.nativeId = nativeId;
      this.emit('event', {
        type: 'session_created',
        payload: { sessionId: entry.id, claudeSessionId: nativeId },
      });
    }
    entry.options = sessionOptions(opened);
    this.quota.observeTier(acpQuotaTier(opened));
    entry.defaults = {
      model: entry.options.model?.current,
      thought: entry.options.thought?.current,
      mode: entry.options.mode?.current,
    };
    if (isNewSession) this.catalog.observe(entry.options);
    return transport;
  }

  private async configure(
    entry: Entry,
    transport: AcpStdio,
    key: 'model' | 'thought' | 'mode',
    value?: string | null,
  ) {
    if (value === undefined) return;
    const option = entry.options[key];
    const selected = value ?? entry.defaults[key];
    if (!selected || selected === option?.current) return;
    if (!option?.values.some((item) => item.id === selected))
      throw new BadRequestException(
        `The selected Antigravity ${key === 'thought' ? 'thinking level' : key} is unavailable. Choose another before sending.`,
      );
    const result = option.configId
      ? await transport.request('session/set_config_option', {
          sessionId: entry.nativeId,
          configId: option.configId,
          value: selected,
        })
      : await transport.request(
          key === 'mode' ? 'session/set_mode' : 'session/set_model',
          {
            sessionId: entry.nativeId,
            [key === 'mode' ? 'modeId' : 'modelId']: selected,
          },
        );
    const next = sessionOptions(result);
    if (key === 'mode' && option.configId && next.mode?.current !== selected)
      throw new BadRequestException(
        'Antigravity did not activate the selected mode. Choose another before sending.',
      );
    entry.options = {
      ...entry.options,
      [key]: { ...option, current: selected },
      ...(next.model ? { model: next.model } : {}),
      ...(next.thought ? { thought: next.thought } : {}),
      ...(next.mode ? { mode: next.mode } : {}),
    };
  }

  private startRun(
    entry: Entry,
    session: Session,
    prompt: string,
    visiblePrompt?: string,
    images?: AgentImageInput[],
  ) {
    clearTimeout(entry.idleTimer);
    entry.error = null;
    entry.stopping = false;
    let resolveReceipt!: () => void;
    let rejectReceipt!: (error: unknown) => void;
    const receipt = new Promise<void>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    entry.run = this.run(entry, session, prompt, visiblePrompt, images, {
      resolve: resolveReceipt,
      reject: rejectReceipt,
    }).finally(() => {
      clearTimeout(entry.stopTimer);
      clearTimeout(entry.updateTimer);
      entry.updateTimer = undefined;
      entry.decisions.cancel();
      this.dispatches.clear(entry);
      entry.run = undefined;
      entry.turn = undefined;
      entry.stopping = false;
      if (entry.closed) return;
      this.emitState(entry.id);
      this.retire(entry);
      if (!entry.queuePaused)
        void this.drain(entry).catch((error) => this.fail(entry, error));
    });
    // Receipt rejects only before dispatch. Later failures are published as
    // runtime errors and never cause the desktop to resend a submitted turn.
    void entry.run.catch(() => undefined);
    this.emitState(entry.id);
    return { receipt, completed: entry.run };
  }

  private async run(
    entry: Entry,
    session: Session,
    prompt: string,
    visiblePrompt: string | undefined,
    images: AgentImageInput[] | undefined,
    receipt: { resolve(): void; reject(error: unknown): void },
  ): Promise<void> {
    let capture: TurnChangeCapture | undefined;
    let successful = false;
    let failure: Error | undefined;
    const cwd = session.worktreePath;
    try {
      await this.sessionService.assertSessionWorkspaceLinked(entry.id);
      this.assertOpen(entry);
      const transport = await this.connect(entry, cwd);
      await this.configure(entry, transport, 'model', entry.selection.model);
      await this.configure(
        entry,
        transport,
        'thought',
        entry.selection.reasoningEffort,
      );
      await this.configure(entry, transport, 'mode', entry.selection.mode);
      if (images?.length && !entry.imagePrompts)
        throw new BadRequestException(
          'This Antigravity runtime does not accept images.',
        );
      this.assertOpen(entry);
      capture = await this.changes.begin(
        entry.id,
        this.info.id,
        cwd,
        entry.nativeId,
      );
      this.assertOpen(entry);
      if (transport.closed)
        throw new Error('Antigravity exited before receiving the message.');
      const id = randomUUID();
      const user: AgentTranscriptItem = {
        id,
        kind: 'user',
        content: visiblePrompt ?? prompt,
        timestamp: new Date().toISOString(),
        editUnsupported: true,
      };
      const stored = this.db
        .insert(antigravityTurns)
        .values({ sessionId: entry.id, items: [user] })
        .returning({ id: antigravityTurns.id })
        .get();
      entry.storedTurnId = stored.id;
      entry.turn = new AntigravityTurn(id, user);
      entry.liveItems = entry.turn.items;
      const response = transport.request(
        'session/prompt',
        {
          sessionId: entry.nativeId,
          prompt: [
            { type: 'text', text: prompt },
            ...(images ?? []).map((image) => ({
              type: 'image',
              mimeType: image.mediaType,
              data: image.data,
            })),
          ],
        },
        0,
      );
      receipt.resolve();
      this.emitState(entry.id);
      const result = await response;
      if (!acpText(result.stopReason))
        throw new Error('Antigravity did not confirm completion.');
      successful = !entry.stopping && result.stopReason !== 'cancelled';
      if (successful) this.quota.available(entry.options.model?.current);
      if (!successful && entry.pendingPrompts.length) entry.queuePaused = true;
    } catch (error) {
      entry.transport?.close();
      failure =
        entry.stopping || entry.closed
          ? new ConflictException('The Antigravity turn was stopped.')
          : this.fail(entry, error);
      receipt.reject(failure);
    } finally {
      try {
        await this.changes.finish(capture, entry.nativeId);
        if (entry.storedTurnId !== undefined) {
          this.db
            .update(antigravityTurns)
            .set({ items: entry.liveItems })
            .where(eq(antigravityTurns.id, entry.storedTurnId))
            .run();
        }
      } catch {
        failure = this.fail(
          entry,
          new Error('Could not save the Antigravity conversation.'),
        );
      } finally {
        entry.storedTurnId = undefined;
        entry.liveItems = [];
        if (!entry.closed)
          this.emit('event', {
            type: 'history_snapshot',
            payload: { sessionId: entry.id },
          });
      }
    }
    if (failure) throw failure;
    if (successful && !entry.closed && !entry.stopping) {
      void this.sessionService
        .markCompletionUnreviewed(entry.id, 'completed')
        .catch(() =>
          this.logger.warn(
            `Could not mark Antigravity session ${entry.id} complete.`,
          ),
        );
    }
  }

  private notification(
    entry: Entry,
    method: string,
    params: Record<string, unknown>,
  ) {
    // One transport carries one session. Its first usage report can arrive
    // before the session/new reply records the native ID.
    if (
      method !== 'session/update' ||
      (entry.nativeId !== null && params.sessionId !== entry.nativeId) ||
      entry.closed
    )
      return;
    const update = acpObject(params.update);
    if (update.sessionUpdate === 'usage_update') {
      const usage = acpContextUsage(update);
      if (!usage) return;
      this.contexts.delete(entry.id);
      this.contexts.set(entry.id, usage);
      for (const oldest of this.contexts.keys()) {
        if (this.contexts.size <= CONTEXT_LIMIT) break;
        this.contexts.delete(oldest);
      }
    } else if (entry.nativeId === null) {
      return;
    } else if (update.sessionUpdate === 'config_option_update') {
      entry.options = {
        ...entry.options,
        ...Object.fromEntries(
          Object.entries(sessionOptions(update)).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      };
    } else if (update.sessionUpdate === 'current_mode_update') {
      const mode = entry.options.mode;
      const current = acpText(update.currentModeId);
      if (!mode?.values.some(({ id }) => id === current)) return;
      entry.options = { ...entry.options, mode: { ...mode, current } };
    } else if (!entry.turn?.update(update)) return;
    // Keep token bursts from waking every desktop stream once per token.
    entry.updateTimer ??= setTimeout(() => {
      entry.updateTimer = undefined;
      this.emitState(entry.id, 'runtime_snapshot');
    }, 32).unref();
  }

  private decision(
    entry: Entry,
    method: string,
    params: Record<string, unknown>,
  ) {
    const turn =
      entry.run &&
      !entry.stopping &&
      !entry.closed &&
      params.sessionId === entry.nativeId
        ? entry.turn
        : undefined;
    return entry.decisions.receive(
      method,
      params,
      turn && ((nativeId) => turn.toolId(nativeId)),
    );
  }

  private pendingDecisions(sessionId: number): AntigravityDecisions {
    const decisions = this.entries.get(sessionId)?.decisions;
    if (!decisions?.current)
      throw new ConflictException(
        'This Antigravity decision is no longer pending.',
      );
    return decisions;
  }

  approvePermission(
    sessionId: number,
    requestId: string,
    remember = false,
  ): Promise<void> {
    return Promise.resolve().then(() =>
      this.pendingDecisions(sessionId).permission(
        requestId,
        remember ? 'allow_always' : 'allow_once',
      ),
    );
  }

  denyPermission(sessionId: number, requestId: string): Promise<void> {
    return Promise.resolve().then(() =>
      this.pendingDecisions(sessionId).permission(requestId, 'reject_once'),
    );
  }

  answerUserInput(
    sessionId: number,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel' = 'accept',
    content?: AntigravityAnswer,
  ): Promise<void> {
    return Promise.resolve().then(() =>
      this.pendingDecisions(sessionId).answer(requestId, action, content),
    );
  }

  async interrupt(sessionId: number): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry?.run || entry.stopping) return;
    entry.stopping = true;
    entry.queuePaused = entry.pendingPrompts.length > 0;
    if (entry.turn && entry.transport && !entry.transport.closed) {
      entry.transport.notify('session/cancel', { sessionId: entry.nativeId });
      entry.stopTimer = setTimeout(
        () => entry.transport?.close(),
        CANCEL_TIMEOUT,
      ).unref();
    } else {
      entry.transport?.close();
    }
    entry.decisions.cancel();
    this.emitState(sessionId);
    await entry.run.catch(() => undefined);
  }

  cancelPendingPrompt(sessionId: number, id: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.resolve();
    entry.pendingPrompts = entry.pendingPrompts.filter(
      (item) => item.id !== id,
    );
    if (!entry.pendingPrompts.length) entry.queuePaused = false;
    this.emitState(sessionId);
    this.retire(entry);
    return Promise.resolve();
  }

  clearPendingPrompts(sessionId: number): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return Promise.resolve();
    entry.pendingPrompts = [];
    entry.queuePaused = false;
    this.emitState(sessionId);
    this.retire(entry);
    return Promise.resolve();
  }

  steerPendingPrompt(): Promise<void> {
    return Promise.reject(
      new BadRequestException(
        'Antigravity follow-ups are queued until the current turn completes.',
      ),
    );
  }

  async resumePendingPrompts(
    sessionId: number,
    origin?: InteractivePromptOrigin,
  ): Promise<void> {
    this.assertInteractiveOrigin(origin);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (entry.run)
      throw new ConflictException(
        'Wait for Antigravity to finish stopping before resuming the queue.',
      );
    entry.queuePaused = false;
    this.emitState(sessionId);
    await this.drain(entry);
  }

  private async drain(entry: Entry): Promise<void> {
    if (
      entry.run ||
      entry.queuePaused ||
      entry.closed ||
      !entry.pendingPrompts.length
    )
      return;
    const session = await this.sessionService.findOne(entry.id);
    if (entry.run || entry.queuePaused || entry.closed) return;
    this.assertInteractiveSession(session);
    const next = entry.pendingPrompts.shift();
    if (!next) return;
    const clearDispatch = this.dispatches.begin(entry, next);
    try {
      await this.startRun(entry, session, next.prompt, undefined, next.images)
        .receipt;
    } catch (error) {
      clearDispatch();
      if (!entry.closed) {
        entry.pendingPrompts.unshift(next);
        entry.queuePaused = true;
        this.emitState(entry.id);
      }
      throw error;
    }
  }

  async cleanupSession(sessionId: number): Promise<void> {
    this.contexts.delete(sessionId);
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.dispose(entry);
    await entry.run?.catch(() => undefined);
  }

  private retire(entry: Entry) {
    if (entry.closed || entry.run) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      entry.transport?.close();
      entry.transport = undefined;
      if (!entry.pendingPrompts.length) this.dispose(entry);
    }, IDLE_TIMEOUT).unref();
  }

  private dispose(entry: Entry) {
    entry.closed = true;
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.stopTimer);
    clearTimeout(entry.updateTimer);
    entry.transport?.close();
    entry.decisions.cancel();
    if (this.entries.get(entry.id) === entry) {
      this.entries.delete(entry.id);
      this.emitState(entry.id);
    }
  }

  private phase(entry?: Entry): ClaudeRunPhase {
    return entry?.error
      ? 'error'
      : entry?.decisions.current
        ? 'waiting'
        : entry?.run
          ? 'running'
          : 'idle';
  }

  private emitState(
    sessionId: number,
    type: 'run_state' | 'runtime_snapshot' = 'run_state',
  ) {
    const entry = this.entries.get(sessionId);
    this.emit('event', {
      type,
      payload: {
        sessionId,
        runPhase: this.phase(entry),
        canInterrupt: !!entry?.run,
        pendingPrompts: entry?.pendingPrompts.map(({ id }) => ({ id })) ?? [],
      },
    });
  }

  private fail(entry: Entry, error: unknown) {
    const quota = antigravityQuotaFailure(error);
    if (quota) {
      const model = entry.options.model;
      const id = model?.current || entry.selection.model || '';
      this.quota.exhausted(
        id,
        model?.values.find((value) => value.id === id)?.displayName ?? id,
        quota.resetsAt,
      );
    }
    const failure = quota
      ? new BadRequestException(ANTIGRAVITY_QUOTA)
      : error instanceof AcpRequestError && error.code === -32000
        ? new BadRequestException(ANTIGRAVITY_SIGN_IN)
        : error instanceof Error
          ? error
          : new Error('Antigravity failed.');
    entry.error = failure.message;
    entry.queuePaused = entry.pendingPrompts.length > 0;
    this.emitState(entry.id);
    return failure;
  }
}
