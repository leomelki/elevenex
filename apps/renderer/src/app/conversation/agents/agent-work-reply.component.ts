import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { ButtonComponent, FoldComponent, IconComponent } from '../../ui';
import { AgentMarkComponent } from '../composer/agent-mark.component';
import { MarkdownComponent } from '../markdown/markdown.component';
import { FileChipComponent } from '../turns/file-chip.component';
import { agentControl, agentIdentity, sessionAgentTitle, type AgentWorkIntent, type AgentWorkReply } from './agent-work.models';

@Component({
  selector: 'ex-agent-work-reply',
  imports: [AgentMarkComponent, ButtonComponent, FileChipComponent, FoldComponent, IconComponent, MarkdownComponent],
  templateUrl: './agent-work-reply.component.html',
  styleUrl: './agent-work-reply.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentWorkReplyComponent {
  readonly reply = input.required<AgentWorkReply>();
  readonly handoff = input(false);
  readonly active = input(true);
  readonly controlsDisabled = input(false);
  readonly copiedCode = input<string | null>(null);
  readonly requested = output<AgentWorkIntent>();
  readonly layoutChanging = output<HTMLElement>();
  readonly copyCode = output<string>();
  readonly openLink = output<string>();
  readonly openFile = output<string>();
  protected readonly expanded = signal(false);
  protected readonly initialized = signal(false);
  protected readonly long = computed(() => this.reply().text.length > 280 || this.reply().text.split('\n', 7).length > 6);
  protected readonly preview = computed(() => (this.reply().text.trim().split(/\r?\n\s*\r?\n/, 1)[0] ?? '').slice(0, 420));
  protected readonly title = computed(() => sessionAgentTitle(this.reply().session));
  protected readonly identity = computed(() => agentIdentity(this.reply().session.selection));
  protected readonly contentId = 'agent-reply-' + crypto.randomUUID();
  private readonly mark = viewChild<ElementRef<HTMLElement>>('mark');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    let flight: Animation | undefined;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => flight?.cancel();
    motion.addEventListener('change', stop);
    afterNextRender({
      earlyRead: () => {
        if (!this.handoff() || motion.matches) return;
        const viewport = this.host.closest('ex-work-timeline');
        const row = viewport?.querySelector<HTMLElement>('[data-agent-source="' + this.reply().session.sessionId + '"] [data-agent-mark]');
        const mark = this.mark()?.nativeElement;
        if (!mark || !row?.checkVisibility()) return;
        const visible = row.closest('ex-chat-scroll')?.getBoundingClientRect();
        const from = row.getBoundingClientRect(), to = mark.getBoundingClientRect();
        if (!from.width || !to.width || !visible || from.bottom < visible.top || from.top > visible.bottom) return;
        const move = { x: from.left - to.left, y: from.top - to.top };
        if (Math.abs(move.y) > visible.height) return;
        return { mark, ...move };
      },
      write: movement => {
        if (!movement) return;
        const { mark, x, y } = movement;
        const style = getComputedStyle(mark);
        flight = mark.animate([
          { transform: 'translate(' + x + 'px,' + y + 'px)', opacity: .65 },
          { transform: 'none', opacity: 1 },
        ], { duration: parseFloat(style.getPropertyValue('--dur-glide')) || 360, easing: style.getPropertyValue('--ease-glide').trim() || 'ease-out' });
      },
    });
    inject(DestroyRef).onDestroy(() => {
      motion.removeEventListener('change', stop);
      stop();
    });
  }

  protected toggle(event: Event): void {
    const control = agentControl(event);
    if (control) this.layoutChanging.emit(control);
    this.initialized.set(true);
    this.expanded.update(open => !open);
  }

  protected open(event: Event): void {
    this.requested.emit({ target: { kind: 'session', session: this.reply().session }, action: 'open',
      itemId: this.reply().replyId, origin: agentControl(event) });
  }
}
