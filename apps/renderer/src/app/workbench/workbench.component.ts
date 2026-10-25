import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
} from "@angular/core";
import { AppShellComponent } from "../shell/app-shell.component";
import { IconButtonComponent, IconComponent, ButtonComponent } from "../ui";
import { ProjectRailComponent } from "../tasks/projects/project-rail.component";
import { TaskListComponent } from "../tasks/outline/task-list.component";
import { PanelTabsComponent } from "../tasks/navigation/panel-tabs.component";
import { TitleIslandComponent } from "../machines/title-island.component";
import { IslandNameComponent } from "../machines/island-name.component";
import type { Machine } from "../machines/machine.models";
import type {
  PanelTab,
  Project,
  TaskOutline,
} from "../tasks/task.models";

/** Composes supplied view data and emits intent; repository and agent state stay outside. */
@Component({
  selector: "ex-workbench",
  imports: [
    AppShellComponent,
    ProjectRailComponent,
    TaskListComponent,
    PanelTabsComponent,
    TitleIslandComponent,
    IslandNameComponent,
    IconButtonComponent,
    IconComponent,
    ButtonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./workbench.component.html",
  styleUrl: "./workbench.component.css",
})
export class WorkbenchComponent {
  readonly projects = input<readonly Project[]>([]);
  readonly tasks = input<readonly TaskOutline[]>([]);
  readonly machine = input<Machine>();
  readonly activeProject = model("all");
  readonly selectedSession = model<{
    readonly taskId: string;
    readonly sessionId: string;
  } | null>(null);
  readonly panelOpen = model(false);
  readonly wideReview = model(false);
  readonly panel = model("changes");
  readonly hasConversation = input(false);
  readonly projectAdded = output<void>();
  readonly taskRequested = output<void>();
  readonly closedTasksRequested = output<void>();
  readonly sessionRequested = output<string>();
  readonly subtaskSessionRequested = output<{
    readonly taskId: string;
    readonly subtaskId: string;
  }>();
  readonly machineRequested = output<void>();
  protected readonly tabs: readonly PanelTab[] = [
    { id: "terminal", label: "Terminal", icon: "terminal" },
    { id: "code", label: "Code", icon: "code" },
    { id: "changes", label: "Changes", icon: "changes" },
    { id: "actions", label: "Actions", icon: "actions" },
    { id: "browser", label: "Browser", icon: "globe" },
  ];
  protected readonly projectLabel = computed(
    () =>
      this.projects().find((project) => project.id === this.activeProject())
        ?.name ?? "All projects",
  );
}
