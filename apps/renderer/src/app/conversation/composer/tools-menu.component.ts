import { OverlayModule } from "@angular/cdk/overlay";
import { A11yModule } from "@angular/cdk/a11y";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { IconComponent } from "../../ui";
import type { McpServer } from "../conversation.models";
@Component({
  selector: "ex-tools-menu",
  imports: [OverlayModule, A11yModule, IconComponent],
  templateUrl: "./tools-menu.component.html",
  styleUrl: "./picker.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolsMenuComponent {
  readonly servers = input<readonly McpServer[]>([]);
  readonly attach = output<void>();
  readonly mention = output<void>();
  readonly manage = output<void>();
  readonly serverChanged = output<{ id: string; on: boolean }>();
  readonly open = signal(false);
  readonly query = signal("");
  readonly filtered = computed(() =>
    this.servers().filter((server) =>
      server.name
        .toLocaleLowerCase()
        .includes(this.query().toLocaleLowerCase()),
    ),
  );
  private mentionAfterClose = false;
  requestMention(): void {
    this.mentionAfterClose = true;
    this.open.set(false);
  }
  detached(): void {
    this.open.set(false);
    if (this.mentionAfterClose) {
      this.mentionAfterClose = false;
      // CDK has destroyed the focus trap and restored focus before detach emits.
      this.mention.emit();
    }
  }
  search(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }
}
