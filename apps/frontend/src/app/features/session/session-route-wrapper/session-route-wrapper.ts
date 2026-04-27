import { Component } from '@angular/core';

/**
 * Empty wrapper component for the session child route.
 * The SessionContainer (parent) handles all rendering.
 */
@Component({
  selector: 'app-session-route-wrapper',
  template: '', // Empty - parent container handles everything
  standalone: true,
})
export class SessionRouteWrapper {}