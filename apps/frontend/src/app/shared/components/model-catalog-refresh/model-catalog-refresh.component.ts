import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
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
  readonly refreshing = signal(false);
  readonly message = signal<string | null>(null);
  readonly failed = signal(false);

  constructor() {
    effect(() => {
      this.provider();
      this.message.set(null);
      this.failed.set(false);
    });
  }

  async refresh(event: Event): Promise<void> {
    event.stopPropagation();
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.message.set(null);
    this.failed.set(false);
    const provider = this.provider();
    try {
      const catalogs = await this.catalog.refresh(provider);
      if (this.provider() !== provider) return;
      const unavailable = catalogs.filter(
        (catalog) => (!provider || catalog.provider === provider) && catalog.unavailableReason,
      );
      if (unavailable.length) {
        this.failed.set(true);
        this.message.set(
          this.provider() && unavailable.length === 1
            ? unavailable[0].unavailableReason!
            : `Could not refresh ${unavailable.map((catalog) => catalog.displayName).join(', ')}. Check installation and sign-in, then retry.`,
        );
      } else {
        this.message.set('Models are up to date.');
      }
    } catch {
      if (this.provider() !== provider) return;
      this.failed.set(true);
      this.message.set('Could not refresh models. Try again.');
      toast.error('Could not refresh models. Your previous list is still available.');
    } finally {
      this.refreshing.set(false);
    }
  }
}
