import type { SessionChatAction, SessionChatPreset, SessionChatPresetDefault, SessionChatState } from "@elevenex/shared";
import { computed, signal, type Signal } from "@angular/core";
import type {
  PresetCatalogProvider,
  AgentConfig,
  AgentHarness,
  AgentModel,
} from "../conversation";
import type { SessionChatClient } from "../backend/session-chat-client.service";
import type { ChatSelection, SessionChatStore } from "./session-chat.store";

interface PresetOwner {
  readonly store: SessionChatStore;
  readonly client: SessionChatClient;
  readonly selection: Signal<ChatSelection | null>;
  readonly identity: Signal<string>;
  readonly harnesses: Signal<readonly AgentHarness[]>;
  readonly models: Signal<readonly AgentModel[]>;
  readonly blocked: Signal<boolean>;
  readonly showWelcome: Signal<boolean>;
  readonly agent: () => AgentConfig | undefined;
  readonly focusComposer: () => void;
  readonly closeAgent: () => void;
  readonly focusPreset: (id?: string) => void;
}

function matchesMix(preset: AgentConfig, state: SessionChatState): boolean {
  return preset.harness === state.provider &&
    preset.model === (state.model ?? "") &&
    (preset.thinking ?? null) === state.reasoning &&
    !!preset.fast === !!state.fast;
}

/** Owns the starting choice and retained creator, independently of transcript rendering. */
export class SessionChatPresets {
  private disposed = false;
  private readonly tweakBase = signal<AgentConfig | undefined>(undefined);
  constructor(private readonly owner: PresetOwner) {}
  readonly presetDraft = signal<{
    readonly id: string;
    readonly editing?: { readonly id: string; readonly revision: string };
    readonly initial: AgentConfig;
    readonly identity: string;
    readonly harnesses: readonly AgentHarness[];
    readonly catalogProvider?: PresetCatalogProvider;
  } | null>(null);
  readonly creatorOpen = signal(false);
  readonly presetSaving = signal(false);
  readonly presetError = signal("");
  readonly defaultNoticeOpen = signal(false);
  readonly undoBusy = signal(false);
  readonly editing = signal(false);
  readonly naming = signal(false);
  readonly newName = signal("");
  readonly changeNotice = signal("");
  readonly changeNoticeOpen = signal(false);
  private noticeTimer?: ReturnType<typeof setTimeout>;
  readonly removal = signal<{
    readonly label: string;
    readonly detail?: string;
    readonly action: Extract<SessionChatAction, { type: "preset-restore" }>;
  } | null>(null);
  readonly removalOpen = signal(false);
  readonly defaultUndo = signal<{
    before: SessionChatPresetDefault;
    afterRevision: string;
    label: string;
    identity: string;
  } | null>(null);
  readonly defaultPreset = computed(
    () => this.owner.store.state()?.presetDefault,
  );
  readonly canEdit = computed(() =>
    !!this.owner.store.state()?.presetEditing && !!this.defaultPreset(),
  );
  readonly defaultOptions = computed(() =>
    this.presets().map((p) => ({
      id: p.id ?? "",
      label: p.preset ?? p.model,
      mark: p.mark,
      detail: [p.harnessLabel, p.modelLabel, p.thinking]
        .filter(Boolean)
        .join(" · "),
    })),
  );

  readonly presets = computed<readonly AgentConfig[]>(() =>
    (this.owner.store.state()?.presets ?? []).map((preset) => ({
      id: preset.id,
      default: preset.id === this.defaultPreset()?.id,
      preset: preset.name,
      harness: preset.provider,
      harnessLabel: preset.providerLabel,
      mark:
        this.owner.harnesses().find((h) => h.id === preset.provider)?.mark ??
        preset.providerLabel.slice(0, 2),
      model: preset.model ?? "",
      modelLabel:
        preset.provider === this.owner.store.state()?.provider
          ? this.owner.models().find((m) => m.id === preset.model)?.label ||
            preset.modelLabel
          : preset.modelLabel,
      thinking: preset.reasoning ?? undefined,
      fast: preset.fast,
    })),
  );
  readonly visiblePresets = computed(() => {
    const visible = this.presets().slice(0, 6);
    if (this.canEdit()) return visible;
    const pinned = [this.defaultPreset()?.id, this.selectedPreset()?.id].filter(
      Boolean,
    );
    for (const id of pinned) {
      const preset = this.presets().find((p) => p.id === id);
      if (preset && !visible.some((p) => p.id === id)) {
        const replace = visible
          .map((p) => !pinned.includes(p.id))
          .lastIndexOf(true);
        if (replace >= 0) visible[replace] = preset;
      }
    }
    return visible;
  });
  readonly presetNames = computed(() =>
    this.presets().filter(preset => preset.id !== this.presetDraft()?.editing?.id)
      .map((preset) => preset.preset ?? ""),
  );
  readonly selectedPreset = computed(() => {
    const state = this.owner.store.state();
    if (!state) return undefined;
    const matching = this.presets().filter(preset => matchesMix(preset, state));
    return (
      matching.find((preset) => preset.id === this.owner.store.preferredPresetId()) ??
      matching.find((preset) => preset.id === this.defaultPreset()?.id) ??
      matching[0]
    );
  });
  readonly drift = computed(() => {
    const base = this.tweakBase();
    const saved = base?.id && this.presets().find((preset) => preset.id === base.id);
    const state = this.owner.store.state();
    if (!saved || !base || !state || !this.canEdit() || matchesMix(base, state)) return null;
    const harness = this.owner.harnesses().find(item => item.id === state.provider);
    const fields = [
      { label: "Harness", from: saved.harnessLabel ?? saved.harness, to: harness?.label ?? state.provider, changed: saved.harness !== state.provider },
      { label: "Model", from: saved.modelLabel || saved.model, to: this.owner.models().find(item => item.id === state.model)?.label ?? state.model ?? "Provider default", changed: saved.model !== (state.model ?? "") },
      { label: "Thinking", from: saved.thinking ?? "Default", to: state.reasoning ?? "Default", changed: (saved.thinking ?? null) !== state.reasoning },
      { label: "Fast mode", from: saved.fast ? "On" : "Off", to: state.fast ? "On" : "Off", changed: !!saved.fast !== !!state.fast },
    ].filter(field => field.changed);
    return fields.length ? { saved, fields } : null;
  });
  readonly invalidNewName = computed(() => {
    const name = this.newName().trim().toLowerCase();
    return !name || this.presets().some(preset => preset.preset?.toLowerCase() === name);
  });

  trackTweak(): void {
    if (!this.owner.showWelcome() || !this.canEdit()) return;
    if (!this.drift()) this.tweakBase.set(this.selectedPreset());
    this.naming.set(false);
    this.clearChangeNotice();
  }

  setEditing(value: boolean): void {
    if (value === this.editing() || (value && !this.canEdit())) return;
    if (value) this.owner.closeAgent();
    this.editing.set(value);
    this.naming.set(false);
    this.clearChangeNotice();
  }

  openPresetEditor(id: string): void {
    const preset = this.presets().find(item => item.id === id);
    const revision = this.defaultPreset()?.revision;
    if (!this.canEdit() || !preset || !revision) return;
    this.openDraft(preset, { id, revision });
  }

  createPresetFromAgent(value: AgentConfig): void {
    this.owner.closeAgent();
    this.openPresetCreator(value);
  }
  openPresetCreator(value = this.owner.agent()): void {
    this.openDraft(value);
  }
  private openDraft(value?: AgentConfig, editing?: { id: string; revision: string }): void {
    if (
      this.disposed ||
      !value ||
      this.owner.blocked() ||
      this.owner.store.state()?.providerLocked !== false ||
      this.owner.store.state()?.presets === undefined ||
      (!editing && this.presets().length >= 24)
    )
      return;
    this.presetError.set("");
    this.presetSaving.set(false);
    const selection = this.owner.selection();
    if (!selection) return;
    const id = crypto.randomUUID();
    this.presetDraft.set({
      id,
      editing,
      initial: editing ? value : {
        ...value,
        preset: undefined,
        default: this.defaultPreset()?.id === null,
      },
      identity: this.owner.identity(),
      harnesses: this.owner.harnesses(),
      ...(this.owner.store.state()?.presetCatalogs
        ? { catalogProvider: this.catalogProvider(selection, id) }
        : {}),
    });
    this.creatorOpen.set(true);
  }
  private catalogProvider(
    selection: ChatSelection,
    draftId: string,
  ): PresetCatalogProvider {
    return async (provider, signal, refresh = false) => {
      const current = () =>
        !this.disposed &&
        !signal.aborted &&
        this.creatorOpen() &&
        this.presetDraft()?.id === draftId &&
        this.owner.selection()?.scopeId === selection.scopeId &&
        this.owner.selection()?.sessionId === selection.sessionId &&
        this.owner.selection()?.taskId === selection.taskId;
      if (!current()) throw new Error("This preset draft is no longer active.");
      const requestId = crypto.randomUUID();
      const cancel = () =>
        this.owner.client.cancel(selection.scopeId, requestId);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = await this.owner.client.catalog(selection.scopeId, {
          taskId: selection.taskId,
          sessionId: selection.sessionId,
          requestId,
          provider,
          ...(refresh ? { refresh: true } : {}),
        });
        if (!current())
          throw new Error("This preset draft is no longer active.");
        if (!result.ok) throw new Error(result.error.message);
        const catalog = result.value;
        if (catalog.error) throw new Error(catalog.error);
        const mark =
          this.owner.harnesses().find((h) => h.id === provider)?.mark ??
          catalog.label.slice(0, 2);
        return {
          harness: {
            id: provider,
            label: catalog.label,
            mark,
            models: catalog.models.map((m) => ({
              id: m.id,
              label: m.label,
              thinking: m.reasoningEfforts ?? [],
              supportsFastMode: m.supportsFastMode,
            })),
          },
          initial: {
            harness: provider,
            harnessLabel: catalog.label,
            mark,
            model: catalog.model ?? "",
            thinking: catalog.reasoning ?? undefined,
            fast: catalog.fast,
          },
          reasoningAvailable: catalog.reasoningAvailable,
          fastAvailable: catalog.fastAvailable,
        };
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    };
  }
  async savePreset(value: AgentConfig): Promise<void> {
    const draft = this.presetDraft();
    if (
      this.disposed ||
      !draft ||
      this.owner.blocked() ||
      this.presetSaving() ||
      draft.identity !== this.owner.identity()
    )
      return;
    this.presetSaving.set(true);
    this.presetError.set("");
    const applyEditedMix = draft.editing && this.selectedPreset()?.id === draft.editing.id &&
      !this.drift() && (
        value.harness !== draft.initial.harness || value.model !== draft.initial.model ||
        value.thinking !== draft.initial.thinking || !!value.fast !== !!draft.initial.fast
      );
    const saved = await this.owner.store.perform(draft.editing ? {
      type: "preset-update",
      ...this.presetFields(draft.editing.id, value),
      expectedRevision: draft.editing.revision,
    } : {
      type: "save-preset",
      id: draft.id,
      name: value.preset ?? "",
      expectedProvider: draft.initial.harness,
      ...(draft.catalogProvider ? { provider: value.harness } : {}),
      model: value.model || null,
      reasoning: value.thinking || null,
      fast: !!value.fast,
      ...(value.default && this.defaultPreset()
        ? {
            makeDefault: true,
            expectedDefaultRevision: this.defaultPreset()!.revision,
          }
        : {}),
    });
    const state = this.owner.store.state();
    const revision = this.defaultPreset()?.revision;
    const updated = state?.presets?.find(preset => preset.id === draft.editing?.id);
    if (saved && applyEditedMix && draft.editing && this.presetDraft() === draft &&
      draft.identity === this.owner.identity() && !this.disposed && this.creatorOpen() &&
      revision && state && matchesMix(draft.initial, state) && updated &&
      updated.provider === value.harness && (updated.model ?? "") === value.model &&
      updated.reasoning === (value.thinking ?? null) && updated.fast === !!value.fast) {
      const applied = await this.owner.store.perform({
        type: "preset", id: draft.editing.id, expectedProvider: state.provider,
        expectedMix: { model: state.model, reasoning: state.reasoning, fast: !!state.fast, revision },
      });
      if (applied && this.presetDraft() === draft && draft.identity === this.owner.identity() && !this.disposed)
        this.owner.store.preferPreset(draft.editing.id);
    }
    if (!this.presetDraft() || this.presetDraft() === draft)
      this.presetSaving.set(false);
    if (
      this.disposed ||
      this.presetDraft() !== draft ||
      draft.identity !== this.owner.identity()
    )
      return;
    if (saved) {
      if (!draft.editing) {
        this.owner.store.preferPreset(draft.id);
        this.tweakBase.set(undefined);
      }
      // An edit saves the preset first, then makes it the default against the
      // revision that save produced. Both are guarded mutations on their own.
      const makeDefault = !!draft.editing && !!value.default && !draft.initial.default;
      const defaulted = makeDefault ? await this.makeEditedDefault(draft.editing!.id, draft) : true;
      if (this.disposed || this.presetDraft() !== draft || draft.identity !== this.owner.identity()) return;
      if (!defaulted) {
        this.presetError.set(
          this.owner.store.error() ||
            "The preset was saved, but could not be made the default. Try again.",
        );
        return;
      }
      this.creatorOpen.set(false);
      this.owner.store.notice.set(draft.editing ? "Preset updated" : "Preset created");
      if (value.default && (!draft.editing || makeDefault)) this.showDefaultUndo();
    } else
      this.presetError.set(
        this.owner.store.error() ||
          "Could not save this preset. Your draft is retained.",
      );
  }
  private async makeEditedDefault(id: string, draft: NonNullable<ReturnType<typeof this.presetDraft>>): Promise<boolean> {
    const current = this.defaultPreset();
    const state = this.owner.store.state();
    if (!current || !state || current.id === id) return true;
    return (
      (await this.owner.store.perform({
        type: "preset-default",
        id,
        expectedProvider: state.provider,
        expectedRevision: current.revision,
      })) && !this.disposed && this.presetDraft() === draft
    );
  }
  async selectPreset(id: string): Promise<void> {
    if (
      this.disposed ||
      this.owner.blocked() ||
      this.owner.store.loading() ||
      !this.owner.showWelcome()
    )
      return;
    if (id === "custom") {
      this.openPresetCreator();
      return;
    }
    this.clearChangeNotice();
    if (id === this.selectedPreset()?.id && !this.drift()) {
      this.owner.focusComposer();
      return;
    }
    const state = this.owner.store.state();
    if (!state || !(this.canEdit() ? this.presets() : this.visiblePresets()).some((preset) => preset.id === id))
      return;
    const identity = this.owner.identity();
    if (
      (await this.owner.store.perform({
        type: "preset",
        id,
        expectedProvider: state.provider,
      })) &&
      identity === this.owner.identity() &&
      !this.disposed
    ) {
      this.owner.store.preferPreset(id);
      this.tweakBase.set(undefined);
      this.naming.set(false);
      this.owner.focusComposer();
    }
  }
  async setDefault(id: string): Promise<void> {
    const current = this.defaultPreset();
    if (
      this.disposed ||
      !current ||
      current.id === id ||
      this.owner.blocked() ||
      this.owner.store.loading() ||
      !this.owner.showWelcome() ||
      !this.presets().some((p) => p.id === id)
    )
      return;
    const identity = this.owner.identity();
    if (
      (await this.owner.store.perform({
        type: "preset-default",
        id,
        expectedProvider: this.owner.store.state()!.provider,
        expectedRevision: current.revision,
      })) &&
      !this.disposed &&
      identity === this.owner.identity()
    ) {
      this.owner.store.preferPreset(id);
      this.tweakBase.set(undefined);
      this.naming.set(false);
      this.showDefaultUndo();
      this.owner.focusComposer();
    }
  }
  async movePreset(id: string, target: string, restoreFocus: boolean): Promise<void> {
    const ids = this.presets().flatMap(preset => preset.id ? [preset.id] : []);
    const from = ids.indexOf(id);
    const to = ids.indexOf(target);
    const revision = this.defaultPreset()?.revision;
    if (!this.editing() || !revision || from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    if (await this.performEdit({ type: "preset-reorder", ids, expectedRevision: revision })) {
      this.owner.store.notice.set("Presets reordered");
      if (restoreFocus && this.editing()) this.owner.focusPreset(id);
    }
  }

  async removePreset(id: string): Promise<void> {
    const settings = this.defaultPreset();
    const saved = this.owner.store.state()?.presets?.find(preset => preset.id === id);
    if (!this.editing() || !settings || !saved ||
      !await this.performEdit({ type: "preset-delete", id, expectedRevision: settings.revision })) return;
    const removal = this.owner.store.presetRemoval();
    if (!removal) return;
    const fallback = settings.id === id
      ? this.presets().find(preset => preset.id === this.defaultPreset()?.id)?.preset
      : undefined;
    this.removal.set({
      label: saved.name,
      detail: fallback ? `Default is now “${fallback}”` : undefined,
      action: this.restoreAction(saved, settings, removal),
    });
    this.defaultNoticeOpen.set(false);
    this.removalOpen.set(true);
    this.owner.store.notice.set("Preset removed");
    if (this.editing()) this.owner.focusPreset();
  }

  private restoreAction(
    preset: SessionChatPreset,
    settings: SessionChatPresetDefault,
    removal: { position: number; revision: string },
  ): Extract<SessionChatAction, { type: "preset-restore" }> {
    const { id, name, provider, model, reasoning, fast } = preset;
    return {
      type: "preset-restore", id, name, provider, model, reasoning, fast,
      position: removal.position, expectedRevision: removal.revision,
      defaultProvider: settings.provider, defaultIds: settings.defaultIds,
    };
  }

  async undoRemoval(): Promise<void> {
    const removal = this.removal();
    if (removal && await this.performEdit(removal.action)) {
      this.removalOpen.set(false);
      this.owner.store.notice.set("Preset restored");
      this.owner.focusPreset(this.editing() ? removal.action.id : undefined);
    }
  }

  async updateFromChat(): Promise<void> {
    const saved = this.drift()?.saved;
    const revision = this.defaultPreset()?.revision;
    const agent = this.owner.agent();
    if (!saved?.id || !agent || !revision) return;
    if (await this.performEdit({
      type: "preset-update", expectedRevision: revision,
      ...this.presetFields(saved.id, { ...agent, preset: saved.preset }),
    })) {
      this.owner.store.preferPreset(saved.id);
      this.tweakBase.set(undefined);
      this.owner.store.notice.set("Preset updated");
      this.showChangeNotice(`“${saved.preset}” updated`);
      this.owner.focusComposer();
    }
  }

  startNaming(): void {
    this.newName.set("");
    this.naming.set(true);
  }

  async saveChatAsNew(event: Event): Promise<void> {
    event.preventDefault();
    const agent = this.owner.agent();
    if (!agent || !this.drift() || this.invalidNewName() || this.presets().length >= 24) return;
    const id = crypto.randomUUID();
    const { provider, ...fields } = this.presetFields(id, { ...agent, preset: this.newName() });
    if (await this.performEdit({ type: "save-preset", ...fields, expectedProvider: provider })) {
      this.owner.store.preferPreset(id);
      this.tweakBase.set(undefined);
      this.naming.set(false);
      this.owner.store.notice.set("Preset created");
      this.showChangeNotice(`Saved as “${fields.name}”`);
      this.owner.focusComposer();
    }
  }

  private showChangeNotice(text: string): void {
    this.clearChangeNotice();
    this.changeNotice.set(text);
    this.changeNoticeOpen.set(true);
    this.noticeTimer = setTimeout(() => this.changeNoticeOpen.set(false), 2400);
  }

  private clearChangeNotice(): void {
    clearTimeout(this.noticeTimer);
    this.changeNoticeOpen.set(false);
  }

  private presetFields(id: string, config: AgentConfig) {
    return {
      id, name: config.preset?.trim() ?? "", provider: config.harness,
      model: config.model || null, reasoning: config.thinking || null, fast: !!config.fast,
    };
  }

  private async performEdit(action: SessionChatAction): Promise<boolean> {
    if (this.disposed || !this.canEdit() || this.owner.blocked() || !this.owner.showWelcome()) return false;
    const identity = this.owner.identity();
    return await this.owner.store.perform(action) && identity === this.owner.identity() && !this.disposed;
  }
  private showDefaultUndo(): void {
    const change = this.owner.store.defaultChange();
    if (!change) return;
    this.defaultUndo.set({
      before: change.before,
      afterRevision: change.after.revision,
      label:
        this.presets().find((p) => p.id === change.after.id)?.preset ??
        "preset",
      identity: this.owner.identity(),
    });
    this.defaultNoticeOpen.set(true);
    this.removalOpen.set(false);
  }
  async undoDefault(): Promise<void> {
    const undo = this.defaultUndo();
    if (
      !undo ||
      this.disposed ||
      this.owner.blocked() ||
      this.undoBusy() ||
      undo.identity !== this.owner.identity()
    )
      return;
    this.undoBusy.set(true);
    const restored = await this.owner.store.perform({
      type: "preset-default-restore",
      provider: undo.before.provider,
      defaultIds: undo.before.defaultIds,
      expectedRevision: undo.afterRevision,
    });
    if (
      this.disposed ||
      this.defaultUndo() !== undo ||
      undo.identity !== this.owner.identity()
    )
      return;
    this.undoBusy.set(false);
    if (restored) {
      this.defaultNoticeOpen.set(false);
      this.owner.focusComposer();
    }
  }
  presetShortcut(event: KeyboardEvent): void {
    if (
      !this.owner.showWelcome() ||
      this.editing() ||
      this.creatorOpen() ||
      this.owner.blocked() ||
      event.defaultPrevented ||
      event.isComposing ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const digit = /^Digit[1-9]$/.test(event.code)
      ? event.code.slice(-1)
      : event.key;
    const preset = /^[1-9]$/.test(digit)
      ? this.visiblePresets()[Number(digit) - 1]
      : undefined;
    if (preset?.id) {
      event.preventDefault();
      void this.selectPreset(preset.id);
    }
  }

  reset(): void {
    this.creatorOpen.set(false);
    this.presetSaving.set(false);
    this.defaultNoticeOpen.set(false);
    this.defaultUndo.set(null);
    this.undoBusy.set(false);
    this.tweakBase.set(undefined);
    this.editing.set(false);
    this.naming.set(false);
    this.removal.set(null);
    this.removalOpen.set(false);
    this.clearChangeNotice();
  }
  dispose(): void {
    this.clearChangeNotice();
    this.disposed = true;
  }
}
