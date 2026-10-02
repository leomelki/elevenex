import {
  AgentMentionCardComponent,
  type AgentMentionPresentation,
} from '../attachments/agent-mention-card.component';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type { SessionMention } from '@/shared/models/session-mention.model';
import {
  diffSelectionMentionLineLabel,
  diffSelectionMentionPreview,
} from '@/shared/utils/diff-selection-mention';
import { splitFilePathForDisplay } from '@/shared/utils/file-path-display';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'cw-message-mentions',
  imports: [AgentMentionCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'grid gap-1.5 w-[min(100%,34rem)] whitespace-normal' },
  templateUrl: './message-mentions.component.html',
})
export class MessageMentionsComponent {
  readonly sessions = input<readonly SessionMention[]>([]);
  readonly diffs = input<readonly DiffSelectionMention[]>([]);
  readonly sessionCards = computed(() =>
    this.sessions().map((mention) => ({
      id: mention.sessionId,
      card: {
        icon: 'lucideMessageSquare',
        title: mention.title,
        lineLabel: `#${mention.sessionId}`,
        preview: `${mention.provider} · ${mention.branch}`,
        detail: 'Session context attached · transcript export available',
      } satisfies AgentMentionPresentation,
    })),
  );
  readonly diffCards = computed(() =>
    this.diffs().map((mention) => {
      const { dirname, basename } = splitFilePathForDisplay(mention.filePath);
      return {
        id: mention.id,
        card: {
          icon: 'lucideFileCode',
          title: basename,
          dirname,
          lineLabel: diffSelectionMentionLineLabel(mention),
          preview: diffSelectionMentionPreview(mention),
          detail: `${mention.status} · ${mention.context.before.length + mention.context.after.length} context lines${mention.truncated ? ' · truncated' : ''}`,
        } satisfies AgentMentionPresentation,
      };
    }),
  );
}
