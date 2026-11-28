import { InjectionToken, Signal } from '@angular/core';

/** A launch holds Home's placement and motion through the return to Home. */
export const MACHINE_LAUNCH_OPEN = new InjectionToken<Signal<boolean>>('Machine launch open');
