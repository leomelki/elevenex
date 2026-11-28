import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from "@angular/core";
import { GitBarComponent } from "../src/app/tasks/navigation/git-bar.component";
import { ButtonComponent, SwitchComponent } from "../src/app/ui";

interface GitMoment {
  readonly id: string;
  readonly label: string;
  readonly files: number;
  readonly add: number;
  readonly del: number;
  readonly ahead: number;
  readonly busy?: "commit" | "push";
}

@Component({
  selector: "ex-git-motion-demo",
  imports: [GitBarComponent, ButtonComponent, SwitchComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./git-motion-demo.component.html",
  styleUrl: "./git-motion-demo.component.css",
})
export class GitMotionDemoComponent {
  readonly moments: readonly GitMoment[] = [
    { id: "edits", label: "Edits", files: 7, add: 214, del: 38, ahead: 0 },
    {
      id: "committing",
      label: "Committing",
      files: 7,
      add: 214,
      del: 38,
      ahead: 0,
      busy: "commit",
    },
    {
      id: "push-one",
      label: "One to push",
      files: 0,
      add: 0,
      del: 0,
      ahead: 1,
    },
    {
      id: "pushing",
      label: "Pushing",
      files: 0,
      add: 0,
      del: 0,
      ahead: 1,
      busy: "push",
    },
    { id: "current", label: "Up to date", files: 0, add: 0, del: 0, ahead: 0 },
    {
      id: "new-edits",
      label: "New edits",
      files: 3,
      add: 42,
      del: 7,
      ahead: 0,
    },
    {
      id: "committing-again",
      label: "Committing again",
      files: 3,
      add: 42,
      del: 7,
      ahead: 0,
      busy: "commit",
    },
    {
      id: "push-three",
      label: "Three to push",
      files: 0,
      add: 0,
      del: 0,
      ahead: 3,
    },
    {
      id: "many-edits",
      label: "Larger counts",
      files: 128,
      add: 12214,
      del: 1038,
      ahead: 3,
    },
  ];
  readonly selected = signal(0);
  readonly moment = computed(
    () => this.moments[this.selected()] ?? this.moments[0]!,
  );
  readonly compact = signal(false);
  readonly running = signal(false);
  readonly lastAction = signal("");
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  select(index: number): void {
    this.stop();
    this.selected.set(index);
  }

  run(rapid: boolean): void {
    this.stop();
    this.running.set(true);
    let remaining = rapid ? 27 : 9;
    this.timer = setInterval(
      () => {
        this.selected.update((index) => (index + 1) % this.moments.length);
        if (--remaining === 0) this.stop();
      },
      rapid ? 80 : 900,
    );
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.running.set(false);
  }
}
