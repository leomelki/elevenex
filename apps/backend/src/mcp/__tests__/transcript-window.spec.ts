import {
  buildExportModel,
  renderMarkdown,
} from '../../agent-runtime/conversation-export.service.js';
import { transcriptWindow } from '../tools/observe/transcript-window.js';
import { DeltaCursorStore } from '../tool-registry/delta-cursor.store.js';

const options = {
  precision: 'small' as const,
  includeChanges: false,
  includeIds: true,
};
function model(contents: string[]) {
  return buildExportModel(
    contents.flatMap((content, index) => [
      { id: `u${index}`, kind: 'user' as const, content, isError: false },
      {
        id: `a${index}`,
        kind: 'assistant' as const,
        content: `Answer ${index}`,
        isError: false,
      },
    ]),
    {
      title: 'Test',
      sessionId: 7,
      provider: 'codex',
      branch: 'main',
      exportedAt: '',
    },
  );
}

describe('bounded transcript delivery', () => {
  it('pages every turn and catches up without skipping backlog', () => {
    const transcript = model(['one', 'two', 'three', 'four', 'five']);
    let cursor: string | undefined;
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const page = transcriptWindow(transcript, 10, 'codex:id', cursor, {
        ...options,
        maxTurns: 2,
      });
      pages.push(page);
      cursor = page.cursor;
    }
    expect(pages.map((page) => page.truncated)).toEqual([true, true, false]);
    expect(pages.map((page) => page.data.newTurns)).toEqual([2, 2, 1]);
    const text = pages.map((page) => page.data.markdown).join('');
    for (let turn = 1; turn <= 5; turn++)
      expect(text).toContain(`## Turn ${turn}`);
    expect(
      transcriptWindow(transcript, 10, 'codex:id', cursor, options).data,
    ).toMatchObject({ newTurns: 0 });
  });

  it('continues inside a large turn with no lost text, including the preamble', () => {
    const transcript = model(['x'.repeat(5500)]);
    transcript.preamble = [
      {
        id: 'init',
        kind: 'system',
        content: 'Session initialization',
        isError: false,
      },
    ];
    const fullOptions = {
      ...options,
      precision: 'full' as const,
      maxCharacters: 1000,
    };
    let cursor: string | undefined;
    let combined = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      const page = transcriptWindow(
        transcript,
        2,
        'codex:id',
        cursor,
        fullOptions,
      );
      expect(page.data.markdown!.length).toBeLessThanOrEqual(1000);
      combined += page.data.markdown;
      cursor = page.cursor;
      if (!page.truncated) break;
    }
    expect(combined).toBe(renderMarkdown(transcript, fullOptions));
    expect(JSON.parse(cursor!)).toMatchObject({ turns: 1 });
  });

  it('resets after a rewind, provider switch, and explicit refresh', () => {
    const initial = transcriptWindow(
      model(['one', 'two', 'three']),
      6,
      'codex:id',
      undefined,
      options,
    );
    const rewind = transcriptWindow(
      model(['one']),
      2,
      'codex:id',
      initial.cursor,
      options,
    );
    expect(rewind.data).toMatchObject({
      delta: false,
      cursorReset: true,
      newTurns: 1,
    });
    expect(rewind.data.markdown).toContain('## Turn 1');
    for (const [identity, refresh] of [
      ['claude:new-id', false],
      ['codex:id', true],
    ] as const) {
      expect(
        transcriptWindow(
          model(['one', 'two', 'three']),
          6,
          identity,
          initial.cursor,
          { ...options, refresh },
        ).data,
      ).toMatchObject({ delta: false, cursorReset: true, newTurns: 3 });
    }
  });

  it('redelivers a changed final response even with unchanged item counts and IDs', () => {
    const transcript = model(['one']);
    const initial = transcriptWindow(
      transcript,
      2,
      'codex:id',
      undefined,
      options,
    );
    transcript.turns[0].finalResponse!.content = 'A corrected response';
    const changed = transcriptWindow(
      transcript,
      2,
      'codex:id',
      initial.cursor,
      options,
    );
    expect(changed.data).toMatchObject({
      delta: true,
      newTurns: 0,
      lastTurnUpdated: true,
    });
    expect(changed.data.markdown).toContain('A corrected response');
  });

  it('does not share a delta cursor between clients without MCP session IDs', () => {
    const cursors = new DeltaCursorStore();
    cursors.set(undefined, '7', 'private-history');
    expect(cursors.get(undefined, '7')).toBeUndefined();
  });
});
