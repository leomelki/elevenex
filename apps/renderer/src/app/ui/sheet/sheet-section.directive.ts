import { Directive, TemplateRef, inject, input } from '@angular/core';

@Directive({ selector: 'ng-template[exSheetSection]' })
export class SheetSectionDirective {
  readonly id = input.required<string>({ alias: 'exSheetSection' });
  readonly label = input.required<string>();
  readonly icon = input<string>();
  readonly count = input<number>();
  readonly content = inject<TemplateRef<unknown>>(TemplateRef);
}

export interface SheetSection {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly count?: number;
  readonly content: TemplateRef<unknown>;
}
