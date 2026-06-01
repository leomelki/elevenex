import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheckCircle2, lucideCircle } from '@ng-icons/lucide';
import { MarkdownPipe } from '../session/claude-workspace/pipes/markdown.pipe';
import {
  PlanMarkdownBlock,
  groupPlanMarkdownBlocks,
  parsePlanMarkdownBlocks,
} from './plan-markdown-blocks';

@Component({
  selector: 'app-plan-markdown-blocks',
  standalone: true,
  imports: [CommonModule, MarkdownPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheckCircle2,
      lucideCircle,
    }),
  ],
  templateUrl: './plan-markdown-blocks.component.html',
  styleUrls: ['./plan-markdown-blocks.component.scss'],
})
export class PlanMarkdownBlocksComponent {
  readonly markdown = input('');
  readonly query = input('');

  readonly blocks = computed(() => parsePlanMarkdownBlocks(this.markdown()));
  readonly groups = computed(() => groupPlanMarkdownBlocks(this.blocks()));

  blockMatches(block: PlanMarkdownBlock): boolean {
    const query = this.query().trim().toLowerCase();
    if (!query) return false;
    return `${block.raw}\n${block.content}`.toLowerCase().includes(query);
  }

  groupIsList(group: PlanMarkdownBlock[]): boolean {
    return group.length > 0 && group.every((block) => block.type === 'list-item');
  }

  orderedMarker(block: PlanMarkdownBlock): string {
    return `${block.orderedStart ?? 1}.`;
  }

  headingTag(level: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
    if (level <= 1) return 'h1';
    if (level === 2) return 'h2';
    if (level === 3) return 'h3';
    if (level === 4) return 'h4';
    if (level === 5) return 'h5';
    return 'h6';
  }

  languageLabel(block: PlanMarkdownBlock): string {
    return block.language?.trim() || 'code';
  }
}
