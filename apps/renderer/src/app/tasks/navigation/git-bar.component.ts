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
  viewChild,
} from "@angular/core";
import { CdkMenuTrigger } from "@angular/cdk/menu";
import { OverlayModule } from "@angular/cdk/overlay";
import { A11yModule } from "@angular/cdk/a11y";
import {
  DropdownMenuComponent,
  DropdownItemComponent,
  ButtonComponent,
  IconComponent,
  KbdComponent,
  StatusGlyphComponent,
} from "../../ui";
import type { GitAction, GitJob } from "../task.models";
import { GitJobMenuComponent } from "./git-job-menu.component";
import { GitBarMotion } from "./git-bar-motion";

interface ActionContent {
  readonly key: string;
  readonly step: "commit" | "push" | "merge" | "job";
  readonly label: string;
  readonly busy: boolean;
  readonly count: number;
  readonly shortcut: boolean;
  readonly waiting: boolean;
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
    CdkMenuTrigger,
    OverlayModule,
    A11yModule,
    GitJobMenuComponent,
    DropdownMenuComponent,
    DropdownItemComponent,
    ButtonComponent,
    IconComponent,
    KbdComponent,
    StatusGlyphComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./git-bar.component.html",
  styleUrl: "./git-bar.component.css",
})
export class GitBarComponent {
  readonly files = input(0);
  readonly add = input(0);
  readonly del = input(0);
  readonly ahead = input(0);
  readonly busy = input<"commit" | "push" | "merge">();
  readonly mergeInto = input<string>();
  readonly job = input<GitJob>();
  readonly compact = input(false);
  readonly action = output<GitAction>();
  readonly changesRequested = output<void>();
  readonly jobSessionRequested = output<string>();
  readonly jobCancelled = output<string>();
  protected readonly jobOpen = linkedSignal<
    { readonly id: string | undefined; readonly open: boolean },
    boolean
  >({
    source: () => ({ id: this.job()?.id, open: this.job()?.open ?? false }),
    computation: (value, previous) =>
      previous &&
      previous.source.id === value.id &&
      previous.source.open === value.open
        ? previous.value
        : value.open,
  });
  protected readonly menuRetained = signal(false);
  private readonly jobMenu = viewChild<
    GitJobMenuComponent,
    ElementRef<HTMLElement>
  >("jobMenu", { read: ElementRef });
  private jobTrigger?: HTMLElement;
  private focusedMenu?: HTMLElement;
  protected readonly parentName = computed(
    () => this.mergeInto()?.split("/").pop() ?? "",
  );
  protected readonly ready = signal(false);
  protected readonly step = computed(() =>
    this.job()
      ? "job"
      : (this.busy() ??
        (this.files()
          ? "commit"
          : this.ahead()
            ? this.mergeInto()
              ? "merge"
              : "push"
            : null)),
  );
  protected readonly actionContent = computed<ActionContent | null>(() => {
    const step = this.step();
    if (!step) return null;
    const busy = !!this.busy();
    const job = this.job();
    const current = job?.steps.find((step) => step.status !== "done");
    const done =
      job?.steps.filter((step) => step.status === "done").length ?? 0;
    const shortcut = !this.compact() && step === "commit" && !busy;
    const label = job
      ? job.waiting
        ? `${job.noun ?? "Merge"} waiting on you`
        : `${job.verb ?? "Merging"} · ${current?.short ?? `${Math.min(done + 1, job.steps.length)} of ${job.steps.length}`}`
      : busy
        ? step === "commit"
          ? "Committing…"
          : step === "merge"
            ? "Merging…"
            : "Pushing…"
        : step === "commit"
          ? "Commit"
          : step === "merge"
            ? `Merge into ${this.parentName()}`
            : "Push";
    return {
      key: `${label}:${shortcut}`,
      step,
      label,
      busy: busy || !!job,
      waiting: !!job?.waiting,
      count:
        busy || job || step === "merge"
          ? 0
          : step === "commit"
            ? this.files()
            : this.ahead(),
      shortcut,
    };
  });
  protected readonly statContent = computed<StatContent | null>(() =>
    this.job()
      ? null
      : this.files()
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
    this.step() === "merge"
      ? [
          { action: "merge", label: "Squash and merge (default)" },
          { action: "merge-commit", label: "Merge commit" },
          { action: "rebase-parent", label: `Rebase on ${this.parentName()}` },
          { action: "push", label: "Push this branch" },
        ]
      : this.step() === "commit"
        ? this.mergeInto()
          ? [
              {
                action: "commit-merge",
                label: `Commit and merge into ${this.parentName()}`,
              },
              { action: "sync", label: `Sync with ${this.parentName()}` },
            ]
          : [
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

  private readonly root =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly motion = new GitBarMotion(this.root);

  constructor() {
    afterRenderEffect(() => {
      if (this.jobOpen() && this.job()) this.menuRetained.set(true);
      if (!this.job() && this.jobOpen()) this.closeJob();
      const menu = this.jobMenu()?.nativeElement;
      if (menu && this.jobOpen() && menu !== this.focusedMenu) {
        this.focusedMenu = menu;
        this.jobTrigger ??=
          this.root.querySelector<HTMLElement>(".primary") ?? undefined;
        menu.focus();
      }
      if (!menu) this.focusedMenu = undefined;
    });
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
  protected leaveJob(event: AnimationCallbackEvent): void {
    if (event.target.contains(this.root.ownerDocument.activeElement))
      this.jobTrigger?.focus();
    this.motion.leaveMenu(event, () => {
      event.animationComplete();
      if (!this.jobOpen() || !this.job()) this.menuRetained.set(false);
    });
  }

  protected primary(): void {
    const step = this.step();
    if (this.busy()) return;
    if (step === "job") {
      const job = this.job();
      const session =
        job?.steps.find((step) => step.session && step.status === "attention")
          ?.session ??
        job?.steps.find((step) => step.session && step.status !== "done")
          ?.session;
      if (job?.waiting && session) this.jobSessionRequested.emit(session.id);
      else this.toggleJob();
    } else if (step) this.action.emit(step);
  }

  protected toggleJob(): void {
    if (this.jobOpen()) {
      this.closeJob();
      return;
    }
    const active = this.root.ownerDocument.activeElement;
    this.jobTrigger =
      active instanceof HTMLElement && this.root.contains(active)
        ? active
        : (this.root.querySelector<HTMLElement>(".primary") ?? undefined);
    this.jobOpen.set(true);
  }
  protected closeJob(restoreFocus = true): void {
    if (!this.jobOpen()) return;
    this.jobOpen.set(false);
    if (restoreFocus) this.jobTrigger?.focus();
  }
  protected outsideJob(event: MouseEvent): void {
    if (event.target instanceof Node && this.root.contains(event.target))
      return;
    this.closeJob(
      this.jobMenu()?.nativeElement.contains(
        this.root.ownerDocument.activeElement,
      ),
    );
  }
}
