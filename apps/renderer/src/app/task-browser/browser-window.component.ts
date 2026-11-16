import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { TaskBrowserWindowInfo } from '@elevenex/shared';
import { ELEVENEX_BRIDGE } from '../backend/backend-client.service';
import { TitleIslandComponent } from '../machines';
import { ProjectMarkComponent, StageGlyphComponent } from '../tasks';
import { FoldComponent, IconButtonComponent, IconComponent, TooltipDirective } from '../ui';
import { TaskBrowserComponent } from './task-browser.component';

/** Dedicated route. Main binds this document to one existing tab; URLs carry no authority. */
@Component({
  selector: 'ex-browser-window',
  imports: [TaskBrowserComponent, TitleIslandComponent, ProjectMarkComponent, StageGlyphComponent, FoldComponent, IconButtonComponent, IconComponent, TooltipDirective],
  templateUrl: './browser-window.component.html',
  styleUrl: './browser-window.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.mac]': 'mac', '[class.returning]': 'returning()' },
})
export class BrowserWindowComponent {
  private readonly bridge = inject(ELEVENEX_BRIDGE);
  protected readonly browser = viewChild(TaskBrowserComponent);
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly mac = this.bridge.platform === 'darwin';
  readonly info = signal<TaskBrowserWindowInfo | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly returning = signal(false);
  private disposed = false;
  private revision = 0;
  private exit?: Animation;
  constructor() {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = () => { if (motion.matches) this.exit?.finish(); };
    motion.addEventListener('change', reduce);
    const stop = this.bridge.onTaskBrowserWindowChanged?.(info => { this.revision++; this.info.set(info); });
    const revision = this.revision;
    void this.bridge.taskBrowserWindow?.().then(info => {
      if (!this.disposed && this.revision === revision) this.info.set(info);
    }).catch(() => { if (!this.disposed) this.error.set('Could not open this tab.'); }).finally(() => { if (!this.disposed) this.loading.set(false); });
    inject(DestroyRef).onDestroy(() => { this.disposed = true; stop?.(); this.exit?.cancel(); motion.removeEventListener('change', reduce); });
  }
  async action(action: 'return' | 'reveal'): Promise<void> {
    if (!this.info()?.available || this.returning()) return;
    this.error.set('');
    try {
      if (action === 'return') {
        this.returning.set(true);
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
          const content = this.root.querySelector('main');
          const style = getComputedStyle(this.root);
          this.exit = content?.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(var(--space-2))' }], { duration: parseFloat(style.getPropertyValue('--dur-fast')), easing: style.getPropertyValue('--ease-in').trim(), fill: 'forwards' });
          await this.exit?.finished;
        }
      }
      if (!this.disposed) await this.bridge.taskBrowserWindowAction?.(action);
    } catch { if (!this.disposed) { this.exit?.cancel(); this.returning.set(false); this.error.set('Could not reach the task window. Try again.'); } }
  }
}
