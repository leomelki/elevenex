import { ChangeDetectionStrategy, Component, computed, effect, input, signal } from '@angular/core';

@Component({
  selector: 'ex-chat-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './chat-loading.component.html',
  styleUrl: './chat-loading.component.css',
})
export class ChatLoadingComponent {
  readonly label = input('Loading messages');
  readonly pending = input(true);

  private readonly delayElapsed = signal(false);
  protected readonly visible = computed(() => this.pending() && this.delayElapsed());
  protected readonly exchanges = [
    { prompt: 39, reply: [68, 85, 46] },
    { prompt: 58, reply: [94, 81, 88, 56] },
  ] as const;

  constructor() {
    effect(cleanup => {
      this.delayElapsed.set(false);
      if (!this.pending()) return;
      const timer = setTimeout(() => this.delayElapsed.set(true), 150);
      cleanup(() => clearTimeout(timer));
    });
  }
}
