import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Locally bundled brand marks; the mask follows the surrounding theme color. */
@Component({
  selector: 'app-agent-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex shrink-0 items-center justify-center', 'aria-hidden': 'true' },
  template: `
    @if (source(); as source) {
      <span
        class="block size-full bg-current"
        [style.mask-image]="'url(' + source + ')'"
        style="mask-size: contain; mask-repeat: no-repeat; mask-position: center"
      ></span>
    } @else {
      <span class="text-xs font-semibold">{{ provider().slice(0, 2).toUpperCase() }}</span>
    }
  `,
})
export class AgentLogoComponent {
  readonly provider = input.required<string>();
  readonly source = computed(() =>
    ['claude', 'codex', 'opencode', 'pi'].includes(this.provider())
      ? `agent-logos/${this.provider()}.svg`
      : null,
  );
}
