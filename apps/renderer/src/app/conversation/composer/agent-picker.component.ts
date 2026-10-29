import { CdkTrapFocus, A11yModule } from "@angular/cdk/a11y";
import {
  CdkConnectedOverlay,
  OverlayModule,
  type ConnectedPosition,
} from "@angular/cdk/overlay";
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { ContextMeterComponent, IconComponent, KbdComponent } from "../../ui";
import type { AgentConfig, AgentHarness } from "../conversation.models";
import { AgentPlanMeterComponent } from "./agent-plan-meter.component";
import { AgentSettingsComponent } from "./agent-settings.component";
import { AgentUsageComponent } from "./agent-usage.component";
import { PopoverPresence } from "./popover-presence";

import { AgentMarkComponent } from "./agent-mark.component";

/** Owns anchored surfaces, delayed usage disclosure and focus; settings stay controlled. */
@Component({
  selector: "ex-agent-picker",
  imports: [
    AgentMarkComponent,
    OverlayModule,
    A11yModule,
    IconComponent,
    ContextMeterComponent,
    KbdComponent,
    AgentPlanMeterComponent,
    AgentSettingsComponent,
    AgentUsageComponent,
  ],
  templateUrl: "./agent-picker.component.html",
  styleUrl: "./agent-picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(mouseenter)": "pointerInside.set(true)",
    "(mouseleave)": "pointerInside.set(false)",
    "(focusin)": "triggerFocused.set(true)",
    "(focusout)": "triggerFocused.set(false)",
  },
})
export class AgentPickerComponent {
  readonly value = input.required<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly locked = input(true);
  readonly disabled = input(false);
  readonly busy = input(false);
  readonly showFork = input(true);
  readonly showSavePreset = input(true);
  readonly reasoningAvailable = input(true);
  readonly fastAvailable = input(true);
  readonly canCompact = input(false);
  readonly changed = output<AgentConfig>();
  readonly fork = output<void>();
  readonly savePreset = output<AgentConfig>();
  readonly compactRequested = output<void>();
  readonly open = signal(false);
  protected readonly usageOpen = signal(false);
  protected readonly pointerInside = signal(false);
  protected readonly triggerFocused = signal(false);
  private readonly destroy = inject(DestroyRef);
  private readonly element =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly menu = new PopoverPresence(
    this.open,
    () => ({
      value: this.value(),
      harnesses: this.harnesses(),
      locked: this.locked(),
      busy: this.busy(),
      showFork: this.showFork(),
      showSavePreset: this.showSavePreset(),
      reasoningAvailable: this.reasoningAvailable(),
      fastAvailable: this.fastAvailable(),
      canCompact: this.canCompact(),
    }),
    this.element,
    this.destroy,
  );
  protected readonly usage = new PopoverPresence(
    this.usageOpen,
    () => this.value(),
    this.element,
    this.destroy,
  );
  private readonly dialog = viewChild<ElementRef<HTMLElement>>("dialog");
  private readonly focusTrap = viewChild(CdkTrapFocus);
  private readonly overlay = viewChild<CdkConnectedOverlay>("settingsOverlay");
  private readonly usageOverlay =
    viewChild<CdkConnectedOverlay>("usageOverlay");
  protected readonly above = signal(true);
  protected readonly usageId = `agent-usage-${crypto.randomUUID()}`;
  protected readonly positions: ConnectedPosition[] = [
    {
      originX: "start",
      originY: "top",
      overlayX: "start",
      overlayY: "bottom",
      offsetY: -6,
    },
    {
      originX: "start",
      originY: "bottom",
      overlayX: "start",
      overlayY: "top",
      offsetY: 6,
    },
  ];
  protected readonly hasUsage = computed(
    () => this.value().context !== undefined || !!this.value().plan,
  );
  protected readonly harnessLabel = computed(
    () =>
      this.harnesses().find((h) => h.id === this.value().harness)?.label ||
      this.value().harness,
  );
  protected readonly modelLabel = computed(
    () =>
      this.harnesses()
        .find((h) => h.id === this.value().harness)
        ?.models.find((m) => m.id === this.value().model)?.label ||
      this.value().model ||
      "Provider default",
  );
  protected readonly subtitle = computed(() =>
    [
      this.value().preset ? this.modelLabel() : this.harnessLabel(),
      this.thinkingLabel(this.value().thinking),
    ]
      .filter(Boolean)
      .join(" · "),
  );
  private readonly disclosureEligible = computed(
    () =>
      this.hasUsage() &&
      !this.open() &&
      !this.disabled() &&
      (this.pointerInside() || this.triggerFocused()),
  );
  private restoreTarget: HTMLElement | null = null;
  private focused = false;

  constructor() {
    let wasOpen = false;
    effect(() => {
      const open = this.open();
      if (open && !wasOpen) {
        this.restoreTarget =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        this.usageOpen.set(false);
      } else if (!open && wasOpen) {
        this.restoreFocus();
      }
      wasOpen = open;
    });
    effect((cleanup) => {
      if (!this.disclosureEligible()) {
        this.usageOpen.set(false);
        return;
      }
      const timer = setTimeout(() => {
        if (this.disclosureEligible()) this.usageOpen.set(true);
      }, 400);
      cleanup(() => clearTimeout(timer));
    });
    afterRenderEffect(() => {
      if (this.disabled()) {
        this.open.set(false);
      }
      const open = this.open();
      const trap = this.focusTrap();
      const settingsRef = this.menu.rendered()
        ? this.overlay()?.overlayRef
        : undefined;
      const usageRef = this.usage.rendered()
        ? this.usageOverlay()?.overlayRef
        : undefined;
      // Keep portals for exit without intercepting the underlying interface.
      if (settingsRef?.backdropElement)
        settingsRef.backdropElement.style.pointerEvents = open ? "" : "none";
      if (settingsRef)
        settingsRef.overlayElement.style.pointerEvents = open ? "" : "none";
      if (usageRef) usageRef.overlayElement.style.pointerEvents = "none";
      if (open && trap && !this.focused) {
        this.focused = true;
        void trap.focusTrap.focusInitialElementWhenReady();
      }
      if (!open) this.focused = false;
      if (open && this.busy()) {
        // A nested dropdown can close after becoming disabled. Wait until all
        // render callbacks have released it before recovering its lost focus.
        queueMicrotask(() => {
          if (this.destroy.destroyed || !this.open() || !this.busy()) return;
          const active = document.activeElement;
          if (
            active === document.body ||
            (active instanceof HTMLElement &&
              this.dialog()?.nativeElement.contains(active) &&
              active.matches(":disabled"))
          )
            this.dialog()
              ?.nativeElement.querySelector<HTMLElement>("[cdkFocusInitial]")
              ?.focus({ preventScroll: true });
        });
      }
    });
    this.destroy.onDestroy(() => {
      this.restoreFocus();
    });
  }
  openPicker(): void {
    if (!this.disabled()) this.open.set(true);
  }
  protected toggle(): void {
    if (!this.disabled()) this.open.update((open) => !open);
  }
  protected compact(): void {
    // A successful compaction removes its button. Move focus to stable content.
    this.dialog()
      ?.nativeElement.querySelector<HTMLElement>("[cdkFocusInitial]")
      ?.focus({ preventScroll: true });
    this.compactRequested.emit();
  }
  protected changeAgent(value: AgentConfig): void {
    const harnessChanged = value.harness !== this.value().harness;
    this.changed.emit(value);
    if (harnessChanged) this.open.set(false);
  }
  protected overlayKey(event: KeyboardEvent): void {
    const pane = this.overlay()?.overlayRef?.overlayElement;
    if (
      !this.open() ||
      event.defaultPrevented ||
      !(event.target instanceof Node) ||
      !pane?.contains(event.target)
    )
      return;
    // CDK's trap anchors are also owned by the pane. A fully disabled form
    // needs a stable focus destination until its controls become available.
    if (
      event.key === "Tab" &&
      !this.dialog()?.nativeElement.querySelector("button:not(:disabled)")
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.dialog()
        ?.nativeElement.querySelector<HTMLElement>("[cdkFocusInitial]")
        ?.focus({ preventScroll: true });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.open.set(false);
    }
  }
  private restoreFocus(): void {
    const focus = document.activeElement;
    if (
      (this.overlay()?.overlayRef?.overlayElement?.contains(focus) ||
        focus === document.body) &&
      this.restoreTarget?.isConnected &&
      !this.restoreTarget.matches(":disabled")
    )
      this.restoreTarget.focus({ preventScroll: true });
  }
  private thinkingLabel(value: string | undefined): string {
    return value === "xhigh"
      ? "Extra high"
      : value
        ? value.charAt(0).toUpperCase() + value.slice(1)
        : "";
  }
}
