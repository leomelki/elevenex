import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  type AnimationCallbackEvent,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from "@angular/core";
import { CdkMenuModule } from "@angular/cdk/menu";
import {
  ButtonComponent,
  IconComponent,
  KbdComponent,
  StatusGlyphComponent,
} from "../../ui";
import type { GitAction } from "../task.models";
import { GitBarMotion } from "./git-bar-motion";

interface ActionContent {
  readonly key: string;
  readonly step: "commit" | "push";
  readonly label: string;
  readonly busy: boolean;
  readonly count: number;
  readonly shortcut: boolean;
}
interface StatContent {
  readonly key: "changes" | "quiet";
  readonly files: number;
  readonly add: number;
  readonly del: number;
}

@Component({
  selector: "ex-git-bar",
  imports: [
    CdkMenuModule,
    ButtonComponent,
    IconComponent,
    KbdComponent,
    StatusGlyphComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./git-bar.component.html",
  styleUrls: ["../tasks-menu.css", "./git-bar.component.css"],
})
export class GitBarComponent {
  readonly files = input(0);
  readonly add = input(0);
  readonly del = input(0);
  readonly ahead = input(0);
  readonly busy = input<"commit" | "push">();
  readonly compact = input(false);
  readonly action = output<GitAction>();
  readonly changesRequested = output<void>();
  protected readonly ready = signal(false);
  protected readonly step = computed(
    () =>
      this.busy() ?? (this.files() ? "commit" : this.ahead() ? "push" : null),
  );
  protected readonly actionContent = computed<ActionContent | null>(() => {
    const step = this.step();
    if (!step) return null;
    const busy = !!this.busy();
    const shortcut = !this.compact() && step === "commit" && !busy;
    return {
      key: `${step}:${busy}:${shortcut}`,
      step,
      label: busy
        ? step === "commit"
          ? "Committing…"
          : "Pushing…"
        : step === "commit"
          ? "Commit"
          : "Push",
      busy,
      count: busy ? 0 : step === "commit" ? this.files() : this.ahead(),
      shortcut,
    };
  });
  protected readonly statContent = computed<StatContent | null>(() =>
    this.files()
      ? {
          key: "changes",
          files: this.files(),
          add: this.add(),
          del: this.del(),
        }
      : !this.step()
        ? { key: "quiet", files: 0, add: 0, del: 0 }
        : null,
  );
  // Closing slots retain the last content until they have no visible area.
  protected readonly renderedAction = linkedSignal<
    ActionContent | null,
    ActionContent | null
  >({
    source: this.actionContent,
    computation: (next, previous) => next ?? previous?.value ?? null,
  });
  protected readonly renderedStat = linkedSignal<
    StatContent | null,
    StatContent | null
  >({
    source: this.statContent,
    computation: (next, previous) => next ?? previous?.value ?? null,
  });
  protected readonly actionLabel = computed(() => {
    const content = this.actionContent();
    return content
      ? `${content.label}${content.count ? ` ${content.count}` : ""}`
      : "No git action";
  });
  protected readonly menuItems = computed<
    readonly { readonly action: GitAction; readonly label: string }[]
  >(() =>
    this.step() === "commit"
      ? [
          { action: "commit-push", label: "Commit and push" },
          ...(this.ahead()
            ? [
                {
                  action: "push" as const,
                  label: `Push the ${this.ahead()} waiting`,
                },
              ]
            : []),
          { action: "commit-pr", label: "Commit and open PR" },
          { action: "sync", label: "Sync with main" },
        ]
      : [
          { action: "push-pr", label: "Push and open PR" },
          { action: "push-new-name", label: "Push to a new name" },
          { action: "sync", label: "Sync with main" },
        ],
  );

  private readonly motion = new GitBarMotion(
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement,
  );

  constructor() {
    afterRenderEffect(() =>
      this.motion.update({
        action: !!this.actionContent(),
        stat: !!this.statContent(),
      }),
    );
    afterNextRender(() => {
      this.motion.initialize({
        action: !!this.actionContent(),
        stat: !!this.statContent(),
      });
      this.ready.set(true);
    });
    inject(DestroyRef).onDestroy(() => this.motion.destroy());
  }

  protected leaveInk(event: AnimationCallbackEvent): void {
    this.motion.leaveInk(event);
  }

  protected primary(): void {
    const step = this.step();
    if (step && !this.busy()) this.action.emit(step);
  }
}
