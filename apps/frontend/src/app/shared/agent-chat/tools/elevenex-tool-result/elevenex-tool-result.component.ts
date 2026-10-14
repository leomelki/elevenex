import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ClipboardModule } from '@angular/cdk/clipboard';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowUpRight,
  lucideCheck,
  lucideChevronRight,
  lucideCopy,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ToolOutputComponent } from '../tool-output.component';
import { type ElevenexToolView } from '@/shared/agent-tools/elevenex-tool-view';
import { PortForwardingResultComponent } from '../port-forwarding-result/port-forwarding-result.component';

@Component({
  selector: 'elevenex-tool-result',
  standalone: true,
  imports: [
    RouterLink,
    ClipboardModule,
    NgIcon,
    ZardButtonComponent,
    ToolOutputComponent,
    PortForwardingResultComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideArrowUpRight,
      lucideCheck,
      lucideChevronRight,
      lucideCopy,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './elevenex-tool-result.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0', 'data-elevenex-result': '' },
})
export class ElevenexToolResultComponent {
  private readonly router = inject(Router);
  linkUrl(link: string) {
    return this.router.parseUrl(link);
  }
  toggleDetails() {
    this.detailsOpen.update((open) => !open);
  }
  toggleContent() {
    this.contentExpanded.update((expanded) => !expanded);
  }
  readonly view = input.required<ElevenexToolView>();
  readonly toolInput = input<unknown>();
  readonly toolOutput = input<unknown>();
  readonly pending = input(false);
  readonly detailsOpen = signal(false);
  readonly contentExpanded = signal(false);
  readonly copied = signal(false);
  readonly content = computed(() =>
    this.contentExpanded() ? this.view().content : this.view().content.slice(0, 6000),
  );
  readonly raw = computed(() => {
    if (!this.detailsOpen()) return '';
    let result = this.toolOutput();
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result);
      } catch {
        // Preserve non-JSON provider output verbatim in the captured details.
      }
    }
    try {
      return JSON.stringify(
        { request: this.toolInput() ?? null, response: result ?? null },
        null,
        2,
      );
    } catch {
      return 'The complete response could not be formatted.';
    }
  });
  readonly rawPreview = computed(() => this.raw().slice(0, 50000));
}
