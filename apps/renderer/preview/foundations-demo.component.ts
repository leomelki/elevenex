import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import {
  ButtonComponent,
  ContextMeterComponent,
  EaseSwapComponent,
  FoldComponent,
  IconButtonComponent,
  IconComponent,
  KbdComponent,
  NewMessagesPillComponent,
  PresenceComponent,
  ProgressLineComponent,
  SegmentedComponent,
  SkeletonComponent,
  Status,
  StatusBadgeComponent,
  StatusGlyphComponent,
  SwitchComponent,
  ToastComponent,
  ToastStackComponent,
  type ToastNotice,
  TooltipComponent,
  TooltipDirective,
} from "../src/app/ui";

@Component({
  selector: "ex-foundations-demo",
  imports: [
    ButtonComponent,
    ContextMeterComponent,
    EaseSwapComponent,
    FoldComponent,
    IconButtonComponent,
    IconComponent,
    KbdComponent,
    NewMessagesPillComponent,
    PresenceComponent,
    ProgressLineComponent,
    SegmentedComponent,
    SkeletonComponent,
    StatusBadgeComponent,
    StatusGlyphComponent,
    SwitchComponent,
    ToastComponent,
    ToastStackComponent,
    TooltipComponent,
    TooltipDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./foundations-demo.component.html",
  styleUrl: "./foundations-demo.component.css",
})
export class FoundationsDemoComponent {
  readonly statuses: readonly Status[] = [
    "attention",
    "running",
    "review",
    "done",
    "failed",
    "queued",
  ];
  readonly enabled = signal(true);
  readonly mode = signal("code");
  readonly open = signal(true);
  readonly visible = signal(true);
  readonly toast = signal(true);
  readonly notices = signal<readonly ToastNotice[]>([]);
  private nextNotice = 1;
  readonly label = signal("Commit 7");
  readonly progress = signal(0.48);
  readonly options = [
    { id: "plan", label: "Plan", icon: "plan" },
    { id: "code", label: "Code", icon: "code" },
  ];
  readonly icons = [
    "terminal",
    "code",
    "changes",
    "actions",
    "globe",
    "fork",
    "side-chat",
    "branch",
    "commit",
    "push",
    "workspace",
    "expand",
    "shrink",
    "folder",
    "shield",
    "plug",
  ];

  addNotice(): void {
    const number = this.nextNotice++;
    this.notices.update((notices) => [
      ...notices,
      {
        id: `preview-notice-${number}`,
        title: `Notification ${number}`,
        action: "Undo",
        duration: 0,
      },
    ]);
  }

  removeNotice(id: string): void {
    this.notices.update((notices) =>
      notices.filter((notice) => notice.id !== id),
    );
  }
}
