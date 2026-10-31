import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  computed,
  input,
  linkedSignal,
  output,
  signal,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  IconButtonComponent,
  IconComponent,
  ModalLayerComponent,
  SegmentedComponent,
  SetRowComponent,
  type SegmentOption,
} from "../../ui";
import type { AgentConfig, AgentHarness } from "../conversation.models";
import type {
  PresetAgentCatalog,
  PresetCatalogProvider,
} from "./preset-catalog.models";
import { AgentSettingsComponent } from "../composer/agent-settings.component";

/** One retained draft. The integrating owner persists it and closes only after confirmation. */
@Component({
  selector: "ex-preset-creator",
  imports: [
    AutoHeightDirective,
    ButtonComponent,
    IconButtonComponent,
    IconComponent,
    ModalLayerComponent,
    SegmentedComponent,
    SetRowComponent,
    AgentSettingsComponent,
  ],
  templateUrl: "./preset-creator.component.html",
  styleUrl: "./preset-creator.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetCreatorComponent {
  readonly initial = input.required<AgentConfig>();
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
  readonly useAsDefault = signal(false);
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
  readonly name = signal("");
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
  constructor() {
    effect(() => {
      if (!this.open()) this.cancelCatalog();
    });
    this.destroy.onDestroy(() => this.cancelCatalog());
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
