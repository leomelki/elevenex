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
        { path: 'code-window', loadComponent: () => import('./code/code-window.component').then(module => module.CodeWindowComponent) },
        { path: 'browser-window', loadComponent: () => import('./task-browser/browser-window.component').then(module => module.BrowserWindowComponent) },
        {
          path: "",
          loadComponent: () =>
            import("./machines/application/machine-app.component").then(
              (module) => module.MachineAppComponent,
            ),
        },
        { path: "**", redirectTo: "" },
      ],
      withViewTransitions({
        skipInitialTransition: true,
        // styles.css disables the transition pseudo-element animations for
        // reduced motion. skipTransition() rejects ready, which this Angular
        // version reports as a renderer error even for intentional skips.
      }),
    ),
  ],
};
