import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RepositoryReviewComponent } from '../src/app/repository-review/repository-review.component';
import type { RepositoryReviewTarget } from '../src/app/repository-review/repository-review.store';
import { AppShellComponent } from '../src/app/shell/app-shell.component';
import { ButtonComponent } from '../src/app/ui';

/** Real bridge review; the native regression supplies an isolated task/backend lease. */
@Component({
  selector: 'ex-repository-review-demo',
  imports: [RepositoryReviewComponent, AppShellComponent, ButtonComponent],
  template: `<ex-app-shell [titleBar]="false" [panelOpen]="true" [wideReview]="wide()" (reviewExited)="wide.set(false)"><div shellMain class="intro"><h1>Repository review</h1><p>A real disposable repository, through the production bridge and backend reader.</p><button exButton (click)="wide.set(!wide())">{{ wide() ? 'Return to chat' : 'Expand review' }}</button></div><ex-repository-review shellPanel [target]="target()" [wide]="wide()" [unreachable]="offline() ? 'Test machine' : undefined" (wideChange)="wide.set($event)" (exitRequested)="wide.set(false)" (reconnectRequested)="offline.set(false)" /></ex-app-shell>`,
  styles: `:host { height: 100%; display: block; }.intro { padding: var(--space-6); color: var(--ink); }h1 { font: var(--text-title-weight) var(--text-title-size)/var(--text-title-line) var(--font-sans); }p { color: var(--ink-muted); }`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepositoryReviewDemoComponent {
  readonly target = signal<RepositoryReviewTarget | null>(null);
  readonly wide = signal(false);
  readonly offline = signal(false);
}
