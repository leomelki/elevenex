import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { parseDiffSelectionMentions } from '@/shared/utils/diff-selection-mention';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { toast } from 'ngx-sonner';

export async function copyChatMessage(
  item: AgentTranscriptItem,
  selectedText?: string | null,
): Promise<void> {
  const content =
    selectedText?.trim() ||
    parseDiffSelectionMentions(parseSessionMentions(item.content).text).text;
  if (!content) return;
  if (!navigator.clipboard?.writeText) {
    toast.error('Clipboard is not available.');
    return;
  }
  try {
    await navigator.clipboard.writeText(content);
    toast.success('Message copied');
  } catch {
    toast.error('Could not copy message.');
  }
}
