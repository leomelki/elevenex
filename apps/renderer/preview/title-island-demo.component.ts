import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { IslandEventComponent, IslandNameComponent, Machine, MachinePanelComponent, TitleBarComponent, TitleIslandComponent } from '../src/app/machines';
import { ButtonComponent, IconComponent, StatusGlyphComponent } from '../src/app/ui';

type IslandState = 'name' | 'guest' | 'lost' | 'back' | 'update' | 'open';

/** Supplied machine events stay in the preview, outside the product entry. */
@Component({
  selector: 'ex-title-island-demo',
  imports: [ButtonComponent, IconComponent, StatusGlyphComponent, TitleBarComponent, TitleIslandComponent, IslandNameComponent, IslandEventComponent, MachinePanelComponent],
  templateUrl: './title-island-demo.component.html',
  styleUrl: './title-island-demo.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitleIslandDemoComponent {
  readonly state = signal<IslandState>('name');
  readonly playing = signal(false);
  readonly guests = signal(0);
  readonly progress = signal(.56);
  readonly machine: Machine = { id: 'local', name: 'This Mac', kind: 'local', address: 'MacBook Pro · 1.6.0', conn: 'live', color: 'pine' };
  readonly states: readonly { id: IslandState; label: string }[] = [
    { id: 'name', label: 'Resting' }, { id: 'guest', label: 'Someone connects' },
    { id: 'lost', label: 'Reconnecting' }, { id: 'back', label: 'Back online' },
    { id: 'update', label: 'Updating' }, { id: 'open', label: 'Open' },
  ];
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  select(state: IslandState): void {
    this.stop();
    this.state.set(state);
    if (state === 'guest') this.guests.set(1);
  }

  play(): void {
    if (this.playing()) { this.stop(); return; }
    this.playing.set(true);
    this.timer = setInterval(() => {
      const index = this.states.findIndex(state => state.id === this.state());
      const next = this.states[(index + 1) % this.states.length]!;
      this.state.set(next.id);
      if (next.id === 'guest') this.guests.set(1);
    }, 4000);
  }

  private stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.playing.set(false);
  }
}
