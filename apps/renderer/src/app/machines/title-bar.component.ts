import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Leaves native traffic lights and the platform title-bar overlay to Electron. */
@Component({
  selector: 'ex-title-bar',
  template: '<div class="island"><ng-content /></div>',
  styles: ':host { display: grid; grid-template-columns: minmax(100px, 1fr) auto minmax(100px, 1fr); height: 40px; align-items: center; -webkit-app-region: drag; } .island { grid-column: 2; min-width: 0; -webkit-app-region: no-drag; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitleBarComponent {}
