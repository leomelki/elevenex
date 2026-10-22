import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter, withViewTransitions } from "@angular/router";
import { provideZonelessChangeDetection } from "@angular/core";
import { PreviewComponent } from "./preview.component";

void bootstrapApplication(PreviewComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(
      [
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
        onViewTransitionCreated: ({ transition }) => {
          if (matchMedia("(prefers-reduced-motion: reduce)").matches)
            transition.skipTransition();
        },
      }),
    ),
  ],
}).catch(console.error);
