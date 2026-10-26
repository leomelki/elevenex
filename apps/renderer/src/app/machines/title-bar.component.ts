import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Leaves native traffic lights and the platform title-bar overlay to Electron. */
@Component({
  selector: 'ex-title-bar',
  template: '<div class="island"><ng-content /></div>',
  // Size containment creates a stacking context; keep its panel above the workspace.
  styles: ':host { display: block; position: relative; z-index: 10; container-type: inline-size; height: 34px; -webkit-app-region: drag; } .island { position: absolute; left: 50%; top: 5px; width: max-content; transform: translateX(-50%); -webkit-app-region: no-drag; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitleBarComponent {}
