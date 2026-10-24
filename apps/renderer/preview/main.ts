import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withViewTransitions } from "@angular/router";
import { provideZonelessChangeDetection } from "@angular/core";
import { PreviewComponent } from "./preview.component";

void bootstrapApplication(PreviewComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(
      [
        { path: 'task-update', loadComponent: () => import('./task-update-demo.component').then(module => module.TaskUpdateDemoComponent) },
        { path: 'project-settings', loadComponent: () => import('./settings-demo.component').then(module => module.SettingsDemoComponent) },
        { path: 'projects', loadComponent: () => import('./project-creation-demo.component').then(module => module.ProjectCreationDemoComponent) },
        { path: 'git-jobs', loadComponent: () => import('./git-jobs-demo.component').then(module => module.GitJobsDemoComponent) },
        { path: 'sidebar-motion', loadComponent: () => import('./sidebar-motion-demo.component').then(module => module.SidebarMotionDemoComponent) },
        { path: 'git-motion', loadComponent: () => import('./git-motion-demo.component').then(module => module.GitMotionDemoComponent) },
        {
          path: "",
          loadComponent: () =>
            import("./workspace-demo.component").then(
              (module) => module.WorkspaceDemoComponent,
            ),
        },
        {
          path: "foundations",
          loadComponent: () =>
            import("./foundations-demo.component").then(
              (module) => module.FoundationsDemoComponent,
            ),
        },
        {
          path: "tasks",
          loadComponent: () =>
            import("./tasks-demo.component").then(
              (module) => module.TasksDemoComponent,
            ),
        },
        {
          path: "conversation",
          loadComponent: () =>
            import("./conversation-demo.component").then(
              (module) => module.ConversationDemoComponent,
            ),
        },
        {
          path: "machines",
          loadComponent: () =>
            import("./machines-views-demo.component").then(
              (module) => module.MachinesViewsDemoComponent,
            ),
        },
      ],
      withViewTransitions({
        skipInitialTransition: true,
        // Match production: reduced motion is handled by the global CSS.
      }),
    ),
  ],
}).catch(console.error);
