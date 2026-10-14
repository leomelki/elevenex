import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClipboardModule } from '@angular/cdk/clipboard';
import { ZardButtonComponent } from '@/shared/components/button';
import type { PortForwardingReceipt } from '@/shared/agent-tools/port-forwarding-receipt';

@Component({
  selector: 'port-forwarding-result',
  imports: [RouterLink, ClipboardModule, ZardButtonComponent],
  templateUrl: './port-forwarding-result.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0', 'data-port-forwarding-result': '' },
})
export class PortForwardingResultComponent {
  readonly receipt = input.required<PortForwardingReceipt>();
  readonly copiedForward = signal<number | null>(null);
  readonly copiedDesktop = signal<string | null>(null);
}
