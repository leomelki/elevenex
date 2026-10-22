import {
  ApplicationConfig,
  provideZonelessChangeDetection,
} from "@angular/core";
import { provideRouter, withViewTransitions } from "@angular/router";
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(
      [
        {
          path: "",
          loadComponent: () =>
            import("./workbench/workbench.component").then(
              (module) => module.WorkbenchComponent,
            ),
        },
        { path: "**", redirectTo: "" },
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
};
