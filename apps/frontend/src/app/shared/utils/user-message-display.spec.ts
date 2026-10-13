import type { AgentTranscriptItem } from '@/shared/models/agent-runtime.model';
import { DIFF_SELECTION_MENTION_TAG } from './diff-selection-mention';
import { SESSION_MENTION_TAG } from './session-mention';
import {
  getUserMessageDisplay,
  isUserPrompt,
  parseUserMessageContent,
} from './user-message-display';
import { describe, expect, it } from 'vitest';

const notification =
  '<task-notification><task-id>task-1</task-id><status>completed</status><output-file>/tmp/task.output</output-file><summary>Done</summary></task-notification>';
const image =
  '[Image: original 1100x3000, displayed at 733x2000. Multiply coordinates by 1.50 to map to original image.]';
const skill =
  '<skill>\n<name>write-tests</name>\n<path>/repo/write-tests/SKILL.md</path>\nInstructions\n</skill>';

describe('user message display', () => {
  it.each([
    ['/repo/.claude/skills/write-tests', 'write-tests'],
    ['C:\\repo\\.claude\\skills\\write-tests', 'write-tests'],
  ])('summarizes a Claude skill loaded from %s', (path, name) => {
    expect(
      parseUserMessageContent(`Base directory for this skill: ${path}\n\n# Guidelines\nLong body`),
    ).toMatchObject({
      text: '',
      eventOnly: true,
      loads: [{ kind: 'skill', label: `Loaded skill: ${name}`, detail: path }],
    });
  });

  it('summarizes named Codex skill blocks and preserves surrounding text', () => {
    expect(parseUserMessageContent(skill)).toMatchObject({
      text: '',
      eventOnly: true,
      loads: [{ label: 'Loaded skill: write-tests' }],
    });
    expect(parseUserMessageContent(`Please use this\n${skill}`)).toMatchObject({
      text: 'Please use this',
      eventOnly: false,
    });
  });

  it.each([
    ['backtick fence', `Review this XML:\n\`\`\`xml\n${skill}\n${image}\n${notification}\n\`\`\``],
    ['tilde fence', `~~~text\n${skill}\n${image}\n${notification}\n~~~`],
    ['long fence', `\`\`\`\`text\n\`\`\`\n${image}\n\`\`\`\`\``],
    ['unfinished fence', `\`\`\`xml\n${skill}\n${notification}`],
    ['CRLF fence', `\`\`\`text\r\n${image}\r\n\`\`\``],
    ['inline code', `Explain \`${image}\` and \`${notification}\``],
    ['multiline code span', `Explain \`\`example\n${skill}\n${image}\n\`\` here`],
    ['unfinished code span', `Explain \`example\n${image}`],
    ['block quote', `> ${image}\n> ${notification}`],
    ['indented code', `Example:\n\n    ${image}\n\t${notification}`],
    ['leading indented code', `    ${image}`],
    ['inline image example', `Explain "${image}" please`],
    ['inline skill example', `Explain <skill><name>test</name><path>/repo/test</path>Body</skill>`],
    ['inline task example', `Explain ${notification}`],
    ['trailing prose', `${skill} is an example`],
  ])('preserves events quoted as %s', (_label, text) => {
    expect(parseUserMessageContent(text)).toEqual({
      text: text.trim(),
      loads: [],
      notifications: [],
      eventOnly: false,
    });
  });

  it('resumes event parsing after quoted examples and preserves internal whitespace', () => {
    const example = `Review this:\r\n\`\`\`text\r\n${image}\r\n\r\n\r\n${notification}\r\n\`\`\``;
    expect(parseUserMessageContent(`${example}\r\n${image}\r\n${notification}`)).toMatchObject({
      text: example,
      loads: [{ kind: 'image' }],
      notifications: [{ taskId: 'task-1' }],
      eventOnly: false,
    });
  });

  it.each([SESSION_MENTION_TAG, DIFF_SELECTION_MENTION_TAG])(
    'preserves event examples inside an attached %s',
    (tag) => {
      const text = `<${tag}>\nSnapshot\n${skill}\n${image}\n${notification}\n</${tag}>`;
      expect(parseUserMessageContent(text)).toEqual({
        text,
        loads: [],
        notifications: [],
        eventOnly: false,
      });
    },
  );

  it.each([
    `Base directory for this skill: /repo/write-tests\n\n${notification}\n${image}`,
    `<skill>\n<name>write-tests</name>\n<path>/repo/write-tests/SKILL.md</path>\n\`\`\`xml\n${notification}\n\`\`\`\n${image}\n</skill>`,
  ])('does not interpret examples in loaded skill instructions', (content) => {
    expect(parseUserMessageContent(content)).toMatchObject({
      text: '',
      notifications: [],
      eventOnly: true,
      loads: [{ kind: 'skill' }],
    });
    expect(parseUserMessageContent(content).loads).toHaveLength(1);
  });

  it.each([
    '<task-notification><task-id>task-1</task-id></task-notification>',
    '<task-notification><summary>Missing ID</summary></task-notification>',
    '<task-notification><task-id>task-1</task-id>',
    '<skill><name>write-tests</name></skill>',
    '<skill><name>write-tests</name>',
  ])('preserves malformed blocks without losing text: %s', (text) => {
    expect(parseUserMessageContent(text)).toEqual({
      text,
      loads: [],
      notifications: [],
      eventOnly: false,
    });
  });

  it.each([undefined, '', '   ', '\r\n\t'])(
    'does not navigate to an empty prompt: %s',
    (content) => {
      expect(isUserPrompt({ id: 'empty', kind: 'user', content, timestamp: '' })).toBe(false);
    },
  );

  it('recognizes attachment-only prompts and excludes nested and synthetic messages', () => {
    const item: AgentTranscriptItem = {
      id: 'attachment',
      kind: 'user',
      timestamp: '',
      images: [{ mediaType: 'image/png', data: 'image-data' }],
    };
    expect(isUserPrompt(item)).toBe(true);
    expect(isUserPrompt({ ...item, isSynthetic: true })).toBe(false);
    expect(isUserPrompt({ ...item, parentToolUseId: 'parent' })).toBe(false);
    expect(isUserPrompt({ ...item, images: [] })).toBe(false);
  });

  it('summarizes multiple image notices without exposing coordinate instructions', () => {
    expect(parseUserMessageContent(`${image}\n${image}`)).toMatchObject({
      text: '',
      eventOnly: true,
      loads: [
        { kind: 'image', label: 'Loaded image', detail: '1100x3000' },
        { kind: 'image', label: 'Loaded image', detail: '1100x3000' },
      ],
    });
    expect(parseUserMessageContent(`Inspect this image\n${image}`)).toMatchObject({
      text: 'Inspect this image',
      eventOnly: false,
    });
  });

  it('recognizes task completions including the provider output retrieval hint', () => {
    expect(parseUserMessageContent(notification)).toMatchObject({
      text: '',
      eventOnly: true,
      notifications: [{ taskId: 'task-1' }],
    });
    expect(
      parseUserMessageContent(
        `${notification}\nRead the output file to retrieve the result: /tmp/task.output`,
      ),
    ).toMatchObject({ text: '', eventOnly: true });
    expect(parseUserMessageContent(`${notification}\nPlease retry it`)).toMatchObject({
      text: 'Please retry it',
      eventOnly: false,
    });
  });

  it.each([
    'How do I load a skill?',
    'Here is an example:\nBase directory for this skill: /repo/skill\nBody',
    '<skill>Incomplete example</skill>',
    '[Image: a normal caption]',
  ])('preserves ordinary user text: %s', (text) => {
    expect(parseUserMessageContent(text)).toEqual({
      text,
      loads: [],
      notifications: [],
      eventOnly: false,
    });
  });

  it('starts turns only for human prompts and refreshes cached content when changed', () => {
    const item: AgentTranscriptItem = { id: 'user', kind: 'user', content: image, timestamp: '' };
    expect(isUserPrompt(item)).toBe(false);
    item.content = 'Continue';
    expect(getUserMessageDisplay(item).text).toBe('Continue');
    expect(isUserPrompt(item)).toBe(true);
    expect(isUserPrompt({ ...item, isSynthetic: true })).toBe(false);
    expect(isUserPrompt({ ...item, kind: 'assistant' })).toBe(false);
  });
});
