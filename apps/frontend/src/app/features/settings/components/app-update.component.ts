import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideCircleCheck,
  lucideDownload,
  lucideRefreshCw,
  lucideRotateCcw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardProgressBarComponent } from '@/shared/components/progress-bar';
import { getElectronAppApi } from '@/shared/runtime/electron-window-controls';
import {
  AppUpdateInstallKind,
  AppUpdateState,
  getElectronUpdatesApi,
} from '@/shared/runtime/electron-updates';

/** What actually happens to the running app once the artifact is downloaded. */
const HANDOFF_NOTES: Record<AppUpdateInstallKind, string> = {
  nsis: 'Elevenex closes and the installer takes over. It reopens when the install finishes.',
  dmg: 'Elevenex closes, swaps itself for the new build, and reopens automatically.',
  appimage: 'Elevenex closes, replaces its AppImage in place, and reopens automatically.',
  deb: 'Your system package manager asks for a password, then Elevenex restarts when you are ready.',
};

const BUSY_STATUSES = new Set<AppUpdateState['status']>([
  'checking',
  'downloading',
  'verifying',
  'installing',
]);

@Component({
  selector: 'app-update',
  imports: [NgIcon, ZardButtonComponent, ZardProgressBarComponent],
  templateUrl: './app-update.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `contents` keeps the hidden (browser build) case from adding a stray gap to
  // the settings column.
  host: { class: 'contents' },
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideCircleCheck,
      lucideDownload,
      lucideRefreshCw,
      lucideRotateCcw,
      lucideTriangleAlert,
    }),
  ],
})
export class AppUpdateComponent {
  private readonly updates = getElectronUpdatesApi();
  private readonly appApi = getElectronAppApi();

  readonly state = signal<AppUpdateState | null>(null);

  readonly busy = computed(() => {
    const status = this.state()?.status;
    return status ? BUSY_STATUSES.has(status) : false;
  });

  readonly handoffNote = computed(() => {
    const kind = this.state()?.installKind;
    return kind ? HANDOFF_NOTES[kind] : '';
  });

  readonly progress = computed(() => (this.state()?.percent ?? 0) / 100);

  constructor() {
    if (!this.updates) {
      return;
    }

    const unsubscribe = this.updates.onStateChanged((next) => this.state.set(next));
    inject(DestroyRef).onDestroy(unsubscribe);

    // Cached on the main process side, so opening Settings repeatedly is cheap.
    void this.updates
      .check()
      .then((next) => this.state.set(next))
      .catch(() => undefined);
  }

  check(): void {
    void this.updates
      ?.check({ force: true })
      .then((next) => this.state.set(next))
      .catch(() => undefined);
  }

  install(): void {
    void this.updates
      ?.install()
      .then((next) => this.state.set(next))
      .catch(() => undefined);
  }

  restart(): void {
    void this.appApi?.restart().catch(() => undefined);
  }

  openReleasePage(event: MouseEvent): void {
    event.preventDefault();
    void this.updates?.openReleasePage().catch(() => undefined);
  }

  formatPublishedAt(value: string | null): string {
    if (!value) {
      return '';
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? ''
      : parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
}
