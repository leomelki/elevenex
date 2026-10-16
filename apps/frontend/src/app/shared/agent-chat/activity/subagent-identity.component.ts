import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'cw-subagent-identity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex min-w-0 max-w-full flex-col items-start text-left' },
  template: `
    <span class="max-w-full truncate font-semibold" [title]="label()">{{ label() }}</span>
    @if (secondaryName(); as name) {
      <span
        class="max-w-full truncate text-[10px] font-normal text-muted-foreground"
        [title]="name"
        >{{ name }}</span
      >
    }
  `,
})
export class SubagentIdentityComponent {
  readonly label = input.required<string>();
  readonly nickname = input<string>();
  readonly secondaryName = computed(() => {
    const name = this.nickname()?.trim();
    return name && name.toLowerCase() !== this.label().toLowerCase() ? name : undefined;
  });
}
