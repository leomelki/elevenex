import type { SessionChatPresetDefault } from "@elevenex/shared";
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
  readonly selection: Signal<ChatSelection>;
  readonly identity: Signal<string>;
  readonly harnesses: Signal<readonly AgentHarness[]>;
  readonly models: Signal<readonly AgentModel[]>;
  readonly blocked: Signal<boolean>;
  readonly showWelcome: Signal<boolean>;
  readonly agent: () => AgentConfig | undefined;
  readonly focusComposer: () => void;
  readonly closeAgent: () => void;
}

/** Owns the starting choice and retained creator, independently of transcript rendering. */
export class SessionChatPresets {
  private disposed = false;
  private readonly preferredId = signal<string | null>(null);
  constructor(private readonly owner: PresetOwner) {}
  readonly presetDraft = signal<{
    readonly id: string;
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
  readonly defaultUndo = signal<{
    before: SessionChatPresetDefault;
    afterRevision: string;
    label: string;
    identity: string;
  } | null>(null);
  readonly defaultPreset = computed(
    () => this.owner.store.state()?.presetDefault,
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
    this.presets().map((preset) => preset.preset ?? ""),
  );
  readonly selectedPreset = computed(() => {
    const state = this.owner.store.state();
    const matching = this.presets().filter(
      (p) =>
        p.harness === state?.provider &&
        p.model === (state.model ?? "") &&
        (p.thinking ?? "") === (state.reasoning ?? "") &&
        !!p.fast === !!state.fast,
    );
    return (
      matching.find((preset) => preset.id === this.preferredId()) ??
      matching.find((preset) => preset.id === this.defaultPreset()?.id) ??
      matching[0]
    );
  });
  createPresetFromAgent(value: AgentConfig): void {
    this.owner.closeAgent();
    this.openPresetCreator(value);
  }
  openPresetCreator(value = this.owner.agent()): void {
    if (
      this.disposed ||
      !value ||
      this.owner.blocked() ||
      this.owner.store.historical() ||
      this.owner.store.state()?.providerLocked !== false ||
      this.owner.store.state()?.presets === undefined ||
      this.presets().length >= 24
    )
      return;
    this.presetError.set("");
    this.presetSaving.set(false);
    const id = crypto.randomUUID();
    this.presetDraft.set({
      id,
      initial: { ...value, preset: undefined },
      identity: this.owner.identity(),
      harnesses: this.owner.harnesses(),
      ...(this.owner.store.state()?.presetCatalogs
        ? { catalogProvider: this.catalogProvider(this.owner.selection(), id) }
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
        this.owner.selection().scopeId === selection.scopeId &&
        this.owner.selection().sessionId === selection.sessionId &&
        this.owner.selection().taskId === selection.taskId;
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
            models: [
              { id: "", label: "Provider default", thinking: [] },
              ...catalog.models.map((m) => ({
                id: m.id,
                label: m.label,
                thinking: m.reasoningEfforts ?? [],
                supportsFastMode: m.supportsFastMode,
              })),
            ],
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
    const saved = await this.owner.store.perform({
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
    if (!this.presetDraft() || this.presetDraft() === draft)
      this.presetSaving.set(false);
    if (
      this.disposed ||
      this.presetDraft() !== draft ||
      draft.identity !== this.owner.identity()
    )
      return;
    if (saved) {
      this.preferredId.set(draft.id);
      this.creatorOpen.set(false);
      this.owner.store.notice.set("Preset created");
      if (value.default) this.showDefaultUndo();
    } else
      this.presetError.set(
        this.owner.store.error() ||
          "Could not save this preset. Your draft is retained.",
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
    if (id === this.selectedPreset()?.id) {
      this.owner.focusComposer();
      return;
    }
    const state = this.owner.store.state();
    if (!state || !this.visiblePresets().some((preset) => preset.id === id))
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
      this.preferredId.set(id);
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
      this.preferredId.set(id);
      this.showDefaultUndo();
      this.owner.focusComposer();
    }
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
    this.preferredId.set(null);
  }
  dispose(): void {
    this.disposed = true;
  }
}
