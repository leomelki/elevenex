import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  effect,
  inject,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  untracked,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  EaseSwapComponent,
  IconButtonComponent,
  IconComponent,
  ModalLayerComponent,
  SegmentedComponent,
  type SegmentOption,
} from "../../ui";
import type { AgentConfig, AgentHarness } from "../conversation.models";
import type {
  PresetAgentCatalog,
  PresetCatalogProvider,
} from "./preset-catalog.models";
import { thinkingLabel } from "../composer/agent-config";
import { AgentMarkComponent } from "../composer/agent-mark.component";
import { AgentMenuComponent } from "../composer/agent-menu.component";

/**
 * One retained draft. The integrating owner persists it and closes only after
 * confirmation. The harness/model/thinking/fast choices are the composer's own
 * AgentMenu, and the name field previews the composer chip the preset becomes.
 */
@Component({
  selector: "ex-preset-creator",
  imports: [
    AgentMarkComponent,
    AgentMenuComponent,
    AutoHeightDirective,
    ButtonComponent,
    EaseSwapComponent,
    IconButtonComponent,
    IconComponent,
    ModalLayerComponent,
    SegmentedComponent,
  ],
  templateUrl: "./preset-creator.component.html",
  styleUrl: "./preset-creator.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetCreatorComponent {
  readonly initial = input.required<AgentConfig>();
  readonly editing = input(false);
  readonly chatSettings = input<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly harnessLocked = input(true);
  readonly catalogProvider = input<PresetCatalogProvider>();
  readonly catalogBusy = signal(false);
  readonly catalogError = signal("");
  private readonly catalogs = signal<ReadonlyMap<string, PresetAgentCatalog>>(
    new Map(),
  );
  private readonly savedDrafts = new Map<string, AgentConfig>();
  private readonly destroy = inject(DestroyRef);
  private catalogRequest?: AbortController;
  readonly availableHarnesses = computed(() =>
    this.harnesses().map((h) => this.catalogs().get(h.id)?.harness ?? h),
  );
  readonly currentCatalog = computed(() =>
    this.catalogs().get(this.draft().harness),
  );
  readonly canReason = computed(
    () =>
      this.currentCatalog()?.reasoningAvailable ??
      (this.draft().harness === this.initial().harness &&
        this.reasoningAvailable()),
  );
  readonly names = input<readonly string[]>([]);
  readonly open = input(true);
  readonly busy = input(false);
  readonly error = input("");
  readonly blocked = input(false);
  readonly reasoningAvailable = input(true);
  readonly defaultAvailable = input(false);
  readonly useAsDefault = linkedSignal(() => this.initial().default === true);
  readonly defaultOptions = computed<readonly SegmentOption[]>(() => {
    const disabled = !this.open() || this.busy() || this.blocked();
    return [
      { id: "keep", label: "Keep current", disabled },
      { id: "use", label: "Use this preset", disabled },
    ];
  });
  readonly fastAvailable = input(true);
  readonly submitted = output<AgentConfig>();
  readonly closeRequested = output<void>();
  readonly closed = output<void>();
  readonly draft = linkedSignal(() => this.initial());
  readonly name = linkedSignal(() => this.editing() ? this.initial().preset ?? "" : "");
  readonly nameId = `preset-name-${crypto.randomUUID()}`;
  readonly titleId = `preset-title-${crypto.randomUUID()}`;
  readonly issueId = `preset-issue-${crypto.randomUUID()}`;
  readonly duplicate = computed(() =>
    this.names().some(
      (name) => name.toLowerCase() === this.name().trim().toLowerCase(),
    ),
  );
  readonly supportsFast = computed(
    () =>
      (this.currentCatalog()?.fastAvailable ??
        (this.draft().harness === this.initial().harness &&
          this.fastAvailable())) &&
      this.availableHarnesses()
        .find((h) => h.id === this.draft().harness)
        ?.models.find((m) => m.id === this.draft().model)?.supportsFastMode ===
        true,
  );
  /** The menu edits the mix only; the name, account usage and preset label
   * belong to the preset being drafted. */
  readonly menuValue = computed<AgentConfig>(() => ({
    ...this.draft(),
    preset: undefined,
    context: undefined,
    tokens: undefined,
    plan: undefined,
  }));
  /** Keyed by harness so a new harness's mark enters as a new element. */
  readonly identityMark = computed(() => [
    { harness: this.draft().harness, mark: this.draft().mark },
  ]);
  /** Read in the composer chip after the preset name, as `model · thinking`. */
  readonly summary = computed(() => {
    const draft = this.draft();
    if (this.catalogBusy()) return "Loading models…";
    const model =
      this.availableHarnesses()
        .find((h) => h.id === draft.harness)
        ?.models.find((m) => m.id === draft.model)?.label ||
      draft.modelLabel ||
      draft.model ||
      "Choose model";
    return [
      model,
      draft.thinking && this.canReason() ? thinkingLabel(draft.thinking) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  });
  readonly chatSummary = computed(() => {
    const chat = this.chatSettings();
    return chat
      ? [chat.modelLabel || chat.model, chat.thinking ? thinkingLabel(chat.thinking) : ""]
          .filter(Boolean)
          .join(" · ")
      : "";
  });
  /** The draft already matches this chat's mix, so copying it changes nothing. */
  readonly chatApplied = computed(() => {
    const chat = this.chatSettings(),
      draft = this.draft();
    return (
      !!chat &&
      chat.harness === draft.harness &&
      chat.model === draft.model &&
      (chat.thinking ?? "") === (draft.thinking ?? "") &&
      !!chat.fast === !!draft.fast
    );
  });
  readonly submitLabel = computed(() =>
    this.busy() ? "Saving…" : this.editing() ? "Save changes" : "Create preset",
  );
  /** Changes made while the dialog is open animate; its first paint is still. */
  readonly live = signal(false);
  constructor() {
    afterNextRender(() => this.live.set(true));
    effect(() => {
      if (!this.open()) this.cancelCatalog();
    });
    effect(() => {
      if (!this.editing() || !this.open() || !this.catalogProvider()) return;
      const initial = this.initial();
      this.savedDrafts.set(initial.harness, initial);
      void untracked(() => this.loadCatalog());
    });
    this.destroy.onDestroy(() => this.cancelCatalog());
  }
  useChatSettings(): void {
    const current = this.draft();
    const chat = this.chatSettings();
    if (
      !chat ||
      this.chatApplied() ||
      !this.open() ||
      this.busy() ||
      this.blocked()
    )
      return;
    this.savedDrafts.set(current.harness, current);
    this.savedDrafts.set(chat.harness, chat);
    this.cancelCatalog();
    this.catalogError.set("");
    this.draft.set(chat);
    if (!this.catalogs().has(chat.harness)) void this.loadCatalog();
  }
  private cancelCatalog(): void {
    this.catalogRequest?.abort();
    this.catalogRequest = undefined;
    this.catalogBusy.set(false);
  }
  async loadCatalog(refresh = false): Promise<void> {
    const provider = this.catalogProvider(),
      harness = this.draft().harness;
    if (!provider || !this.open() || this.busy() || this.blocked()) return;
    this.cancelCatalog();
    if (this.catalogs().has(harness)) return;
    const request = new AbortController();
    this.catalogRequest = request;
    this.catalogError.set("");
    this.catalogBusy.set(true);
    try {
      const catalog = await provider(harness, request.signal, refresh);
      if (
        request.signal.aborted ||
        this.destroy.destroyed ||
        this.catalogRequest !== request ||
        this.draft().harness !== harness ||
        !this.open()
      )
        return;
      this.catalogs.update((catalogs) =>
        new Map(catalogs).set(harness, catalog),
      );
      this.draft.set(this.savedDrafts.get(harness) ?? catalog.initial);
    } catch (error) {
      if (
        !request.signal.aborted &&
        !this.destroy.destroyed &&
        this.catalogRequest === request &&
        this.open()
      )
        this.catalogError.set(
          error instanceof Error
            ? error.message
            : "Could not load models. Try again.",
        );
    } finally {
      if (this.catalogRequest === request && !this.destroy.destroyed) {
        this.catalogRequest = undefined;
        this.catalogBusy.set(false);
      }
    }
  }
  chooseDefault(value: string): void {
    if (
      !this.defaultAvailable() ||
      !this.open() ||
      this.busy() ||
      this.blocked()
    )
      return;
    if (value === "keep" || value === "use")
      this.useAsDefault.set(value === "use");
  }
  updateName(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.name.set(event.target.value);
  }
  change(value: AgentConfig): void {
    if (!this.open() || this.busy() || this.blocked()) return;
    const current = this.draft();
    if (value.harness !== current.harness) {
      if (this.harnessLocked()) return;
      if (
        !this.catalogBusy() &&
        !this.catalogError() &&
        (current.harness === this.initial().harness ||
          this.catalogs().has(current.harness))
      )
        this.savedDrafts.set(current.harness, current);
      this.cancelCatalog();
      this.catalogError.set("");
      const cached =
        this.savedDrafts.get(value.harness) ??
        this.catalogs().get(value.harness)?.initial;
      this.draft.set(cached ?? value);
      if (
        value.harness !== this.initial().harness &&
        !this.catalogs().has(value.harness)
      )
        void this.loadCatalog();
      return;
    }
    const model = this.availableHarnesses()
      .find((h) => h.id === value.harness)
      ?.models.find((m) => m.id === value.model);
    this.draft.set({
      ...value,
      fast: model?.supportsFastMode === true && !!value.fast,
    });
  }
  submit(event: Event): void {
    event.preventDefault();
    if (
      !this.open() ||
      this.busy() ||
      this.catalogBusy() ||
      !!this.catalogError() ||
      this.blocked() ||
      this.duplicate() ||
      !this.name().trim()
    )
      return;
    this.submitted.emit({
      ...this.draft(),
      preset: this.name().trim(),
      default: this.defaultAvailable() && this.useAsDefault(),
    });
  }
}
