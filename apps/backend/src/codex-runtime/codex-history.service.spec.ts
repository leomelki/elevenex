import { CodexHistoryService } from './codex-history.service.js';

describe('CodexHistoryService', () => {
  it('marks Codex history plan items with plan content metadata', () => {
    const service = new CodexHistoryService();
    const item = (service as unknown as {
      normalizeResponseItem: (item: Record<string, unknown>, timestamp: string, index: number) => unknown;
    }).normalizeResponseItem(
      { id: 'plan-1', type: 'plan', text: '# Plan\nDo it' },
      '2026-05-22T10:00:00.000Z',
      0,
    );

    expect(item).toMatchObject({
      id: 'plan-1',
      kind: 'assistant',
      contentType: 'plan',
      content: '# Plan\nDo it',
    });
  });
});
