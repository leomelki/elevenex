import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

/** A synthetic tool verification surface. Never imported by product code. */
@Component({
  selector: 'ex-capture-fixture',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './fixture.component.html',
  styleUrl: './fixture.component.css',
})
export class CaptureFixtureComponent {
  readonly count = signal(0);
  readonly open = signal(false);
  readonly status = signal('Ready');

  increment(): void { this.count.update(value => value + 1); }
}
