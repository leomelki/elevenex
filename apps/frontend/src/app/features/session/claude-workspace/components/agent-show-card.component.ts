import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUpRight, lucideChevronDown, lucideX, lucidePresentation } from '@ng-icons/lucide';
import type { AgentShow } from '@/shared/models/agent-channel.model';

const BODY_PREVIEW_LINES = 3;

@Component({
  selector: 'cw-agent-show-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideArrowUpRight, lucideChevronDown, lucideX, lucidePresentation })],
  template: `
    <div class="show-card">
      <div class="show-card__header">
        <span class="show-card__icon" aria-hidden="true">
          <ng-icon name="lucidePresentation" size="13" />
        </span>
        <strong class="show-card__title">{{ show().title }}</strong>
        <div class="show-card__header-actions">
          @if (show().deepLink) {
            <button type="button" class="show-card__open" (click)="onOpen()">
              <ng-icon name="lucideArrowUpRight" size="13" />
              Open
            </button>
          }
          <button
            type="button"
            class="show-card__dismiss"
            aria-label="Dismiss"
            (click)="dismiss.emit(show().id)"
          >
            <ng-icon name="lucideX" size="12" />
          </button>
        </div>
      </div>

      @if (show().body) {
        <div class="show-card__body" [class.show-card__body--expanded]="expanded()">
          <p class="show-card__body-text">{{ show().body }}</p>
        </div>
        @if (isBodyTruncated()) {
          <button type="button" class="show-card__expand" (click)="toggleExpand()">
            <ng-icon
              name="lucideChevronDown"
              size="11"
              [style.transform]="expanded() ? 'rotate(180deg)' : ''"
            />
            {{ expanded() ? 'Show less' : 'Show more' }}
          </button>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .show-card {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      border: 1px solid color-mix(in oklch, var(--primary) 28%, var(--border));
      border-radius: 0.65rem;
      background: color-mix(in oklch, var(--primary) 5%, var(--card));
      padding: 0.6rem 0.75rem;
      font-size: 0.8125rem;
    }

    .show-card__header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }

    .show-card__icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      flex-shrink: 0;
      border-radius: 0.4rem;
      border: 1px solid color-mix(in oklch, var(--primary) 35%, var(--border));
      background: color-mix(in oklch, var(--primary) 14%, var(--background));
      color: color-mix(in oklch, var(--primary) 80%, var(--foreground));
    }

    .show-card__title {
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.3;
      color: var(--foreground);
      min-width: 0;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .show-card__header-actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      flex-shrink: 0;
      margin-left: auto;
    }

    .show-card__open {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      border: 1px solid color-mix(in oklch, var(--primary) 38%, var(--border));
      background: color-mix(in oklch, var(--primary) 10%, transparent);
      color: color-mix(in oklch, var(--primary) 80%, var(--foreground));
      font: inherit;
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;
    }

    .show-card__open:hover {
      background: color-mix(in oklch, var(--primary) 18%, transparent);
      border-color: color-mix(in oklch, var(--primary) 55%, var(--border));
    }

    .show-card__dismiss {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: 0.35rem;
      border: none;
      background: transparent;
      color: var(--muted-foreground);
      cursor: pointer;
      transition: background 100ms ease, color 100ms ease;
    }

    .show-card__dismiss:hover {
      background: color-mix(in oklch, var(--foreground) 8%, transparent);
      color: var(--foreground);
    }

    .show-card__body {
      overflow: hidden;
      max-height: calc(${BODY_PREVIEW_LINES} * 1.5rem);
      transition: max-height 160ms ease;
    }

    .show-card__body--expanded {
      max-height: 20rem;
      overflow-y: auto;
    }

    .show-card__body-text {
      margin: 0;
      font-size: 0.78rem;
      line-height: 1.5;
      color: var(--muted-foreground);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .show-card__expand {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--muted-foreground);
      font: inherit;
      font-size: 0.72rem;
      cursor: pointer;
      align-self: flex-start;
    }

    .show-card__expand:hover { color: var(--foreground); }
  `],
})
export class AgentShowCardComponent {
  readonly show = input.required<AgentShow>();
  readonly dismiss = output<string>();
  readonly open = output<string>();

  private readonly expandedState = signal(false);
  readonly expanded = this.expandedState.asReadonly();

  readonly isBodyTruncated = computed(() => {
    const body = this.show().body ?? '';
    const lineCount = body.split('\n').length;
    return lineCount > BODY_PREVIEW_LINES || body.length > 200;
  });

  toggleExpand(): void {
    this.expandedState.update((v) => !v);
  }

  onOpen(): void {
    const link = this.show().deepLink;
    if (link) this.open.emit(link);
  }
}
