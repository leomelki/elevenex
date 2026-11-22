import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  effect,
  signal,
  input,
  output,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { AutoHeightDirective, FlipDirective, IconButtonComponent } from "../../ui";
import { NgTemplateOutlet } from "@angular/common";
import type { AgentConfig } from "../conversation.models";
import { PresetCardComponent } from "./preset-card.component";
@Component({
  selector: "ex-preset-picker",
  imports: [PresetCardComponent, AutoHeightDirective, FlipDirective, IconButtonComponent, NgTemplateOutlet],
  templateUrl: "./preset-picker.component.html",
  styleUrl: "./preset-picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class PresetPickerComponent {
  protected readonly ready = signal(false);
  private readonly slimGrid = viewChild<ElementRef<HTMLElement>>("slimGrid");
  protected readonly columns = signal(1);
  protected readonly dragged = signal("");
  protected readonly over = signal("");
  constructor() {
    afterNextRender(() => this.ready.set(true));
    effect((cleanup) => {
      const grid = this.slimGrid()?.nativeElement;
      if (!grid || typeof ResizeObserver === "undefined") return;
      const measure = () => {
        const tracks = getComputedStyle(grid).gridTemplateColumns;
        this.columns.set(tracks === "none" ? 1 : Math.max(1, tracks.split(" ").length));
      };
      const observer = new ResizeObserver(measure);
      observer.observe(grid);
      measure();
      cleanup(() => observer.disconnect());
    });
  }
  readonly presets = input<readonly AgentConfig[]>([]);
  readonly value = input("");
  readonly compact = input(false);
  readonly custom = input(true);
  readonly disabled = input(false);
  readonly adaptive = input(false);
  readonly editing = input(false);
  readonly editedPreset = input<AgentConfig>();
  readonly selected = output<string>();
  readonly editRequested = output<string>();
  readonly removed = output<string>();
  readonly moved = output<{ id: string; target: string; restoreFocus: boolean }>();
  private readonly entries = computed(() => {
    const entries: { id: string; preset?: AgentConfig }[] = this.presets().map(preset => ({
      id: preset.id || preset.preset || preset.model, preset,
    }));
    if (this.custom() && !this.editing()) entries.push({ id: "custom" });
    return entries;
  });
  protected readonly fullEntries = computed(() => this.entries().slice(0, 6));
  protected readonly slimEntries = computed(() => this.entries().slice(6));
  protected readonly order = computed(() => this.entries().map(entry => entry.id).join(","));

  protected activate(id: string): void {
    if (this.editing()) this.editRequested.emit(id);
    else this.selected.emit(id);
  }
  protected edit(event: Event, id: string): void {
    if (this.disabled()) return;
    event.preventDefault();
    this.editRequested.emit(id);
  }
  protected startDrag(event: DragEvent, id: string): void {
    if (!this.editing() || this.disabled() || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    this.dragged.set(id);
  }
  protected dragOver(event: DragEvent, id: string): void {
    if (!this.dragged() || this.disabled()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.over.set(this.dragged() === id ? "" : id);
  }
  protected drop(event: DragEvent, target: string): void {
    const id = this.dragged();
    if (!id || this.disabled()) return;
    event.preventDefault();
    this.stopDrag();
    if (id !== target) this.moved.emit({ id, target, restoreFocus: false });
  }
  protected stopDrag(): void {
    this.dragged.set("");
    this.over.set("");
  }
  protected cardKey(event: KeyboardEvent, id: string): void {
    if (this.disabled() || event.defaultPrevented || event.isComposing ||
      event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!this.editing() && !event.altKey && event.key.toLowerCase() === "e") {
      this.edit(event, id);
      return;
    }
    if (!this.editing()) return;
    if (!event.altKey && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      this.removed.emit(id);
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      const index = this.entries().findIndex(entry => entry.id === id);
      const target = this.entries()[index + (event.key === "ArrowLeft" ? -1 : 1)]?.id;
      if (target) {
        event.preventDefault();
        this.moved.emit({ id, target, restoreFocus: true });
      }
    }
  }
  private shortcutNumber(event: KeyboardEvent): number {
    return Number(
      /^Digit[1-9]$/.test(event.code)
        ? event.code.slice(-1)
        : /^[1-9]$/.test(event.key)
          ? event.key
          : 0,
    );
  }
  onKey(event: KeyboardEvent): void {
    if (
      this.disabled() ||
      this.editing() ||
      event.defaultPrevented ||
      event.isComposing ||
      event.shiftKey ||
      !event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      !this.shortcutNumber(event)
    )
      return;
    const index = this.shortcutNumber(event) - 1;
    const preset = !this.adaptive() || index < 6 ? this.presets()[index] : undefined;
    if (preset) {
      event.preventDefault();
      this.selected.emit(preset.id || preset.preset || preset.model);
    }
  }
}
