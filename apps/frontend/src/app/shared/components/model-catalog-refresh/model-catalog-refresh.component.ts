import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRefreshCw } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { ZardButtonComponent } from '@/shared/components/button';
import { AgentModelCatalogService } from '@/shared/services/agent-model-catalog.service';

@Component({
  selector: 'app-model-catalog-refresh',
  imports: [ZardButtonComponent, NgIcon],
  templateUrl: './model-catalog-refresh.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideRefreshCw })],
})
export class ModelCatalogRefreshComponent {
  readonly catalog = inject(AgentModelCatalogService);
  readonly provider = input<string>();
  /** Projected dropdown content can remain mounted while its overlay is closed. */
  readonly active = input(true);
  readonly refreshing = signal(false);
  readonly message = signal<string | null>(null);
  readonly busy = computed(
    () =>
      this.refreshing() ||
      this.catalog.isRefreshing(this.provider()) ||
      this.catalog.isLoading(this.provider()),
  );
  readonly unavailableReason = computed(() => {
    const provider = this.provider();
    const unavailable = this.catalog
      .catalogs()
      .filter(
        (catalog) => (!provider || catalog.provider === provider) && catalog.unavailableReason,
      );
    return unavailable.map((catalog) => catalog.unavailableReason).join(' ') || null;
  });
  readonly status = computed(
    () =>
      this.unavailableReason() ??
      this.catalog.error() ??
      (this.busy() ? 'Checking installed agents and available models…' : this.message()),
  );

  constructor() {
    effect((onCleanup) => {
      const provider = this.provider();
      if (!this.active()) return;
      onCleanup(untracked(() => this.catalog.watch(provider)));
    });
    effect(() => {
      this.provider();
      this.message.set(null);
    });
  }

  async refresh(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.message.set(null);
    const provider = this.provider();
    try {
      const catalogs = await this.catalog.refresh(provider);
      if (this.provider() !== provider) return;
      const unavailable = catalogs.filter(
        (catalog) => (!provider || catalog.provider === provider) && catalog.unavailableReason,
      );
      this.message.set(unavailable.length ? null : 'Models are up to date.');
    } catch {
      if (this.provider() !== provider) return;
      this.message.set(null);
      toast.error('Could not refresh models. Your previous list is still available.');
    } finally {
      this.refreshing.set(false);
    }
  }
}
