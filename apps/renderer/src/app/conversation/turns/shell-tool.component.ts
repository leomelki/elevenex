import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { ButtonComponent, IconButtonComponent } from "../../ui";
import type { ShellToolPresentation } from "../tool-presentation";
import {
  parseTerminalOutput,
  shellOutputWindow,
  terminalPlainText,
} from "./shell-output";

/** Inert captured output, not a PTY. The owning session handles copy and full-content reads. */
@Component({
  selector: "ex-shell-tool",
  imports: [ButtonComponent, IconButtonComponent],
  templateUrl: "./shell-tool.component.html",
  styleUrl: "./shell-tool.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellToolComponent {
  readonly shell = input.required<ShellToolPresentation>();
  readonly status = input<"running" | "done" | "failed" | "unknown">("done");
  readonly copiedCode = input<string | null>(null);
  readonly copyRequested = output<string>();
  readonly wrap = signal(true);
  readonly expanded = signal(false);
  private readonly reading = signal<ReturnType<
    typeof parseTerminalOutput
  > | null>(null);
  readonly following = computed(() => this.reading() === null);
  readonly newOutput = computed(
    () => this.reading() !== null && this.reading() !== this.lines(),
  );
  private readonly screen = viewChild<ElementRef<HTMLElement>>("screen");
  private readonly source = computed(() => this.shell().output);
  private readonly lines = computed(() => parseTerminalOutput(this.source()));
  readonly plain = computed(() => terminalPlainText(this.lines()));
  readonly window = computed(() =>
    shellOutputWindow(this.reading() ?? this.lines(), this.expanded()),
  );
  readonly count = computed(() => this.lines().length);
  readonly directory = computed(() => {
    const value = this.shell().directory;
    const parts = value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : value;
  });
  readonly emptyMessage = computed(() => {
    if (this.shell().interrupted) return "Command interrupted without output.";
    if (this.status() === "running") return "Waiting for output…";
    if (this.status() === "unknown")
      return "No result was recorded for this command.";
    if (this.shell().failed || this.status() === "failed")
      return "Command failed without output.";
    return "Command completed without output.";
  });
  private anchor: number | null = null;

  constructor() {
    afterRenderEffect(() => {
      this.window();
      this.wrap();
      const screen = this.screen()?.nativeElement;
      if (!screen) return;
      if (this.anchor !== null) {
        screen.scrollTop =
          screen.scrollHeight - screen.clientHeight - this.anchor;
        this.anchor = null;
      } else if (this.following()) screen.scrollTop = screen.scrollHeight;
    });
  }
  onScroll(): void {
    const screen = this.screen()?.nativeElement;
    if (!screen) return;
    const following =
      screen.scrollHeight - screen.clientHeight - screen.scrollTop <= 24;
    if (following) this.reading.set(null);
    else if (this.reading() === null) this.reading.set(this.lines());
  }
  showMore(): void {
    const screen = this.screen()?.nativeElement;
    if (screen)
      this.anchor =
        screen.scrollHeight - screen.clientHeight - screen.scrollTop;
    this.expanded.update((value) => !value);
  }
  jumpToEnd(): void {
    const screen = this.screen()?.nativeElement;
    if (screen) screen.scrollTop = screen.scrollHeight;
    this.reading.set(null);
  }
}
