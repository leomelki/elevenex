import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { DIFF_SELECTION_MENTION_TAG } from './diff-selection-mention';
import { SESSION_MENTION_TAG } from './session-mention';
import { parseTaskNotifications, type TaskNotification } from './task-notification';

export interface MessageLoadEvent {
  kind: 'skill' | 'image';
  label: string;
  detail: string;
}

export interface UserMessageDisplay {
  text: string;
  loads: readonly MessageLoadEvent[];
  notifications: readonly TaskNotification[];
  eventOnly: boolean;
}

// Transcript items are shared between grouping, rendering, and prompt navigation.
// Avoid repeatedly scanning injected skill bodies on each of those paths.
const displayCache = new WeakMap<
  AgentTranscriptItem,
  { content: string | undefined; display: UserMessageDisplay }
>();

// Consume outer blocks before examining their bodies. Skill instructions and
// attached snapshots can themselves contain examples of every event format.
const MESSAGE_PART_PATTERN = new RegExp(
  [
    '(?<fence>^ {0,3}(?<delimiter>`{3,}|~{3,})[^\\r\\n]*(?:\\r?\\n|$))',
    '(?<code>`+)',
    '(?<quoted>^[ \\t]*>[^\\r\\n]*|^(?: {4}|\\t)[^\\r\\n]*)',
    `(?<reference><(?<referenceTag>${SESSION_MENTION_TAG}|${DIFF_SELECTION_MENTION_TAG})>)`,
    '(?<block>^[ \\t]*<(?<blockTag>skill|task-notification)>)',
    '(?<image>^[ \\t]*\\[Image: original (?<original>\\d+x\\d+), displayed at \\d+x\\d+\\.(?: Multiply coordinates by \\d+(?:\\.\\d+)? to map to original image\\.)?\\][ \\t]*(?=\\r?$))',
  ].join('|'),
  'gm',
);

export function getUserMessageDisplay(item: AgentTranscriptItem): UserMessageDisplay {
  const cached = displayCache.get(item);
  if (cached && cached.content === item.content) return cached.display;
  const display = parseUserMessageContent(item.content);
  displayCache.set(item, { content: item.content, display });
  return display;
}

export function parseUserMessageContent(content: string | null | undefined): UserMessageDisplay {
  const source = content ?? '';
  const loads: MessageLoadEvent[] = [];
  const notifications: TaskNotification[] = [];

  // Claude injects the full skill instructions as a user text block.
  const skillDirectory = source.match(
    /^(?:[ \t]*\r?\n)*Base directory for this skill: ([^\r\n]+)(?:\r?\n|$)/,
  );
  if (skillDirectory?.[1].trim()) {
    const path = skillDirectory[1].trim();
    return { text: '', loads: [skillLoad(path)], notifications, eventOnly: true };
  }

  // Most human messages have no events. Leave their text (including whitespace
  // inside code) untouched and avoid allocating a scanner for them.
  if (
    !source.includes('<skill>') &&
    !source.includes('<task-notification>') &&
    !source.includes('[Image: original ')
  ) {
    return { text: source.trim(), loads, notifications, eventOnly: false };
  }

  const scanner = new RegExp(MESSAGE_PART_PATTERN);
  const parts: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = scanner.exec(source))) {
    const groups = match.groups!;
    parts.push(source.slice(cursor, match.index));
    let replacement = match[0];
    if (groups['fence']) {
      const delimiter = groups['delimiter'];
      const closing = new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*\\r?$`, 'gm');
      closing.lastIndex = scanner.lastIndex;
      const end = closing.exec(source);
      scanner.lastIndex = end ? closing.lastIndex : source.length;
      replacement = source.slice(match.index, scanner.lastIndex);
    } else if (groups['code']) {
      // Backtick spans close only with a run of the same length. Consume an
      // unfinished span conservatively so pasted examples cannot lose content.
      const closing = /`+/g;
      closing.lastIndex = scanner.lastIndex;
      let end: RegExpExecArray | null;
      while ((end = closing.exec(source)) && end[0].length !== match[0].length) {}
      scanner.lastIndex = end ? closing.lastIndex : source.length;
      replacement = source.slice(match.index, scanner.lastIndex);
    } else if (groups['reference'] || groups['block']) {
      const tag = groups['referenceTag'] || groups['blockTag'];
      const closingTag = `</${tag}>`;
      const closingIndex = source.indexOf(closingTag, scanner.lastIndex);
      const bodyStart = scanner.lastIndex;
      scanner.lastIndex = closingIndex < 0 ? source.length : closingIndex + closingTag.length;
      replacement = source.slice(match.index, scanner.lastIndex);
      // Provider blocks occupy their own lines; inline examples remain text.
      const standalone = /^[ \t]*(?:\r?\n|$)/.test(source.slice(scanner.lastIndex));
      if (groups['block'] && closingIndex >= 0 && standalone) {
        const body = source.slice(bodyStart, closingIndex);
        if (tag === 'skill') {
          const name = body.match(/<name>([^<]+)<\/name>/)?.[1].trim();
          const path = body.match(/<path>([^<]+)<\/path>/)?.[1].trim();
          if (name && path) {
            loads.push(skillLoad(path, name));
            replacement = '';
          }
        } else {
          const parsed = parseTaskNotifications(replacement);
          if (parsed.notifications.length) {
            notifications.push(...parsed.notifications);
            replacement = '';
          }
        }
      }
    } else if (groups['image']) {
      loads.push({ kind: 'image', label: 'Loaded image', detail: groups['original'] });
      replacement = '';
    }
    parts.push(replacement);
    cursor = scanner.lastIndex;
  }
  parts.push(source.slice(cursor));

  let text = parts.join('').trim();
  // Claude can append this retrieval hint to a completed background task.
  // Only consume it when it points at that notification's actual output file.
  if (
    notifications.some(
      (notification) =>
        notification.outputFile &&
        text === `Read the output file to retrieve the result: ${notification.outputFile}`,
    )
  ) {
    text = '';
  }
  return {
    text,
    loads,
    notifications,
    eventOnly: !text && (loads.length > 0 || notifications.length > 0),
  };
}

/** Provider-injected context and notifications never start a human work turn. */
export function isUserPrompt(item: AgentTranscriptItem): boolean {
  return (
    item.kind === 'user' &&
    !item.isSynthetic &&
    !item.parentToolUseId &&
    (Boolean(getUserMessageDisplay(item).text) || Boolean(item.images?.length))
  );
}

function skillLoad(path: string, name?: string): MessageLoadEvent {
  const parts = path.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  const inferredName = parts.at(-1) === 'SKILL.md' ? parts.at(-2) : parts.at(-1);
  return { kind: 'skill', label: `Loaded skill: ${name || inferredName || 'skill'}`, detail: path };
}
