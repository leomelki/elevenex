import { describe, expect, it } from 'vitest';
import { parseTaskNotifications } from './task-notification';

describe('parseTaskNotifications', () => {
  it.each([
    '<task-notification><task-id>task-1</task-id></task-notification>',
    '<task-notification><summary>Missing task ID</summary></task-notification>',
    '<task-notification><task-id>task-1</task-id>',
  ])('preserves an invalid or unfinished notification: %s', (text) => {
    expect(parseTaskNotifications(text)).toEqual({ text, notifications: [] });
  });

  it('extracts valid notifications while preserving surrounding and invalid text', () => {
    const invalid = '<task-notification>Example</task-notification>';
    const valid =
      '<task-notification><task-id>task-1</task-id><status>failed</status><summary>Failed</summary></task-notification>';
    expect(parseTaskNotifications(`Please retry\n${valid}\n${invalid}`)).toMatchObject({
      text: `Please retry\n\n${invalid}`,
      notifications: [{ taskId: 'task-1', status: 'failed', summary: 'Failed' }],
    });
  });
});
