import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, input, output, viewChild } from '@angular/core';
import { IconComponent } from '../ui';
import { ChangeFile, CHANGE_STATUS_LABEL, fileName, folderName } from './view.models';

type ChangeRow = { readonly id: string; readonly label: string; readonly file?: ChangeFile };

@Component({
  selector: 'ex-change-list',
  imports: [IconComponent, ScrollingModule],
  templateUrl: './change-list.component.html',
  styleUrl: './change-list.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangeListComponent {
  private readonly prefix = `changes-${crypto.randomUUID()}`;
  readonly items = input<readonly ChangeFile[]>([]);
  readonly active = input<string>();
  readonly grouped = input(true);
  readonly label = input('Changed files');
  readonly selected = output<string>();
  protected readonly viewport = viewChild(CdkVirtualScrollViewport);
  protected readonly names = fileName;
  protected readonly folders = folderName;
  protected readonly statuses = CHANGE_STATUS_LABEL;
  protected readonly rows = computed<readonly ChangeRow[]>(() => {
    const rows: ChangeRow[] = [];
    let previous = '';
    for (const file of this.items()) {
      const group = [file.repository, this.grouped() ? folderName(file.path) : ''].filter(Boolean).join(' / ');
      if (this.grouped() && group && group !== previous) rows.push({ id: `folder:${file.id}`, label: group });
      previous = group;
      rows.push({ id: file.id, label: file.path, file });
    }
    return rows;
  });
  protected readonly trackRow = (_index: number, row: ChangeRow): string => row.id;
  protected rowId(fileId: string): string { return `${this.prefix}-${encodeURIComponent(fileId)}`; }

  constructor() {
    afterRenderEffect(() => {
      const active = this.active();
      const rows = this.rows();
      const viewport = this.viewport();
      const index = rows.findIndex(row => row.file?.id === active);
      if (viewport && index >= 0) {
        const range = viewport.getRenderedRange();
        if (index < range.start || index >= range.end) viewport.scrollToIndex(index);
      }
    });
  }
  protected keydown(event: KeyboardEvent): void {
    const items = this.items();
    if (!items.length) return;
    let index = items.findIndex(file => file.id === this.active());
    if (event.key === 'ArrowDown') index = Math.min(items.length - 1, index + 1);
    else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = items.length - 1;
    else return;
    event.preventDefault();
    const file = items[index];
    if (file) this.selected.emit(file.id);
  }
}
