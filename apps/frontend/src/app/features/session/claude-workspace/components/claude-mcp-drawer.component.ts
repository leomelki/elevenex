import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewContainerRef,
  effect,
  inject,
  input,
  untracked,
  type ComponentRef,
} from '@angular/core';
import { Overlay } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { McpManagerStore } from '../mcp-manager.store';
import { McpManagerPanelComponent } from './mcp-manager-panel.component';

/** Portal boundary keeps the manager above embedded editors and attached to Angular. */
@Component({
  selector: 'cw-mcp-drawer',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ClaudeMcpDrawerComponent {
  readonly store = input.required<McpManagerStore>();
  readonly provider = input('claude');

  constructor() {
    const overlayService = inject(Overlay);
    const viewContainer = inject(ViewContainerRef);
    const destroyRef = inject(DestroyRef);
    const overlay = overlayService.create({
      hasBackdrop: true,
      backdropClass: 'bg-[color-mix(in_oklab,var(--surface-shade)_30%,transparent)]',
      positionStrategy: overlayService.position().global().right('0').top('0'),
      scrollStrategy: overlayService.scrollStrategies.block(),
      width: '920px',
      maxWidth: '100vw',
      height: '100dvh',
    });
    let panel: ComponentRef<McpManagerPanelComponent> | null = null;
    overlay
      .backdropClick()
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.store().close());
    effect(() => {
      const store = this.store();
      const open = store.open();
      const provider = this.provider();
      untracked(() => {
        if (open) {
          panel ??= overlay.attach(new ComponentPortal(McpManagerPanelComponent, viewContainer));
          panel.setInput('store', store);
          panel.setInput('provider', provider);
        } else {
          overlay.detach();
          panel = null;
        }
      });
    });
    destroyRef.onDestroy(() => overlay.dispose());
  }
}
