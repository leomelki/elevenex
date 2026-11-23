import { describe, expect, it } from 'vitest';
import type { SessionChatItem, SessionChatState } from '@elevenex/shared';
import { ChatTranscriptProjection, chatExchanges } from './session-chat-transcript';
import { timelineRecord } from './session-chat-turn-timeline';

const state: SessionChatState = {
  provider: 'codex', phase: 'running', canInterrupt: true, error: null,
  model: null, models: [], reasoning: null, plan: false, permissionMode: null,
  permissionModes: [], context: null, queue: [], queuePaused: false,
  permission: null, question: null, activity: [],
};
const fresh = new Set<string>();
const item = (id: string, kind: SessionChatItem['kind'], text = '', extra: Partial<SessionChatItem> = {}): SessionChatItem => ({
  id, kind, text, timestamp: '2026-11-18T12:00:00Z', toolId: null,
  toolName: null, toolKind: null, input: '', error: false, truncated: false, ...extra,
});
const tool = (id: string) => item(id, 'tool_use', '', { toolId: id, toolKind: 'bash', input: '{"cmd":"pnpm test"}' });

describe('incremental transcript projection', () => {
  it('keeps one Claude section when refresh finds a saved prefix of the live reply', () => {
    const prompt = item('prompt', 'user', 'Check the work');
    const saved = item('msg_reply:assistant:0', 'assistant', 'Checking');
    const live = item('msg_reply:1', 'assistant', 'Checking the fixtures');
    const [reply, extra] = chatExchanges([prompt, saved, live], { ...state, provider: 'claude' }, fresh);
    expect(extra).toBeUndefined();
    expect(reply).toMatchObject({ answer: live.text, steps: [] });
  });

  it('shows compacted activity once when the raw saved span overlaps the latest page', () => {
    const reply = item('reply', 'assistant', 'Checks passed.');
    const followUp = item('next-detail', 'assistant', 'Starting the next check.');
    const compact = item('prompt', 'user', 'Check the work', { completedTurn: {
      revision: 'a'.repeat(64), endId: 'receipt', reply: [reply], beforeReply: 1,
      total: 3, counts: { run: 1 }, failures: 0,
    } });
    const exchanges = chatExchanges([compact, tool('test'), reply, item('receipt', 'tool_result'), followUp], state, fresh);
    expect(exchanges.map(exchange => [exchange.id, exchange.answer])).toEqual([
      ['prompt', reply.text], ['history-next-detail', followUp.text],
    ]);
  });

  it('keeps viewed images in the matching tool disclosure for live receipts, compact timelines and split pages', () => {
    const prompt = item('prompt', 'user');
    const commentary = item('commentary', 'assistant', 'Opening the screenshot.');
    const reply = item('answer', 'assistant', 'The toolbar is in the right place.');
    const media = [{ id: '0', path: '/capture.png', caption: 'Capture', inline: true }];
    const images = [{ itemId: 'result', mediaId: '0', path: '/capture.png', caption: 'Capture' }];
    const call = item('call', 'tool_use', '', { toolId: 'view', toolKind: 'image_view', input: '{"path":"/capture.png"}' });
    const result = item('result', 'tool_result', 'Image attachment', { toolId: 'view', media });
    const projection = new ChatTranscriptProjection();
    const [pending] = projection.project([prompt, call, commentary], state, fresh);
    expect(pending?.steps).toMatchObject([{ id: 'call', status: 'running' }]);
    expect(pending?.steps[0]?.images).toBeUndefined();
    const [received] = projection.project([prompt, call, commentary, result, reply], state, fresh);
    expect(received).toMatchObject({
      answer: reply.text,
      steps: [{ id: 'call', verb: 'Viewed image', status: 'done', images }, { id: 'commentary' }],
    });

    const revision = 'a'.repeat(64);
    const saved = timelineRecord({ kind: 'call', id: 'call', toolKind: 'image_view', label: '/capture.png', resultId: 'result' }, revision);
    const receipt = timelineRecord({ kind: 'media', id: 'result', callId: 'call', media }, revision);
    const [compact] = chatExchanges([prompt, saved, commentary, receipt, reply], state, fresh);
    expect(compact?.steps).toMatchObject([{ id: 'call', images }, { id: 'commentary' }]);
    const [split] = chatExchanges([{ ...result, invocation: {
      id: 'call', toolKind: 'image_view', toolDetails: { revision, summary: '/capture.png' },
    }, toolDetails: { revision } }], state, fresh);
    expect(split?.steps).toMatchObject([{ id: 'result', images, verb: 'Result' }]);
    expect(split?.steps[0]?.media).toBeUndefined();
    const [failed] = chatExchanges([prompt, call, { ...result, error: true }], state, fresh);
    expect(failed?.steps).toMatchObject([{ id: 'call', status: 'failed' }]);
    expect(failed?.steps[0]?.images).toBeUndefined();
  });
  it('keeps completed turns and unchanged tools stable as new calls, results and text arrive', () => {
    const projection = new ChatTranscriptProjection();
    const items = [item('first', 'user', 'Earlier request'), item('reply', 'assistant', 'Finished'),
      item('next', 'user', 'Next request'), tool('a')];
    const first = projection.project(items, state, fresh);
    const secondItems = [...items, tool('b')];
    const second = projection.project(secondItems, state, fresh);
    expect(second[0]).toBe(first[0]);
    expect(second[1]!.steps[0]).toBe(first[1]!.steps[0]);
    const completedItems = [...secondItems, item('result-a', 'tool_result', 'Passed', { toolId: 'a' })];
    const third = projection.project(completedItems, state, fresh);
    expect(third[0]).toBe(first[0]);
    expect(third[1]!.steps[0]).not.toBe(second[1]!.steps[0]);
    expect(third[1]!.steps[0]!.status).toBe('done');
    expect(third[1]!.steps[1]).toBe(second[1]!.steps[1]);
    const streamed = [...completedItems, item('answer', 'assistant', 'The result')];
    const fourth = projection.project(streamed, state, fresh);
    expect(fourth[1]!.steps).toBe(third[1]!.steps);
    expect(fourth).toEqual(chatExchanges(streamed, state, fresh));
  });

  it('preserves the visible message boundary when a paired result moves between reply blocks', () => {
    const projection = new ChatTranscriptProjection();
    const prompt = item('prompt', 'user');
    const first = tool('first');
    const slow = tool('slow');
    const firstReply = item('first-reply', 'assistant', 'The focused checks passed.');
    const nextReply = item('next-reply', 'assistant', 'I’ll run the full suite.');
    const next = tool('suite');
    const result = item('slow-result', 'tool_result', 'Finished', { toolId: 'slow' });
    const started = [prompt, first, slow,
      item('first-result', 'tool_result', 'Passed', { toolId: 'first' }), firstReply];
    const [before] = projection.project([...started, nextReply, next], state, fresh);
    const [received] = projection.project([...started, result, nextReply, next], state, fresh);
    const [replayed] = projection.project([...started, nextReply, next, result], state, fresh);
    for (const turn of [before, received, replayed]) {
      expect(turn).toMatchObject({
        answer: `${firstReply.text}\n\n${nextReply.text}`,
        answerId: firstReply.id,
        answerBeforeStepId: next.id,
      });
      expect(turn!.steps.map(step => step.id)).toEqual([first.id, slow.id, next.id]);
    }
    expect(received!.steps[0]).toBe(before!.steps[0]);
    expect(received!.steps[1]).toMatchObject({ status: 'done', output: expect.stringContaining('Finished') });
    expect(replayed!.steps).toBe(received!.steps);
    const [stillReplying] = projection.project([...started, nextReply, result], state, fresh);
    expect(stillReplying).toMatchObject({ answerId: firstReply.id, streaming: true });
  });

  it('settles a running thought on new activity and keeps it running through an older tool result', () => {
    const projection = new ChatTranscriptProjection();
    const items = [item('prompt', 'user'), tool('slow'), item('thought', 'thinking', 'Checking the remaining cases.')];
    const [before] = projection.project(items, state, fresh);
    const received = [...items, item('result', 'tool_result', 'Passed', { toolId: 'slow' })];
    const [after] = projection.project(received, state, fresh);
    expect(before!.steps[1]!.status).toBe('running');
    expect(after!.steps[0]!.status).toBe('done');
    expect(after!.steps[1]).toBe(before!.steps[1]);
    const [next] = projection.project([...received, tool('next')], state, fresh);
    expect(next!.steps[1]!.status).toBe('done');
  });

  it('updates a call in its original turn when its result follows a steered prompt', () => {
    const projection = new ChatTranscriptProjection();
    const call = tool('patch');
    const items = [item('prompt', 'user'), call, item('steer', 'user'), item('reply', 'assistant', 'Checking')];
    const running = { ...state, activePromptId: 'steer' };
    const before = projection.project(items, running, fresh);
    const receipt = item('receipt', 'tool_result', 'Finished', { toolId: call.id });
    const after = projection.project([...items, receipt], running, fresh);
    expect(before[0]?.steps[0]?.status).toBe('unknown');
    expect(after[0]?.steps).toMatchObject([{ id: 'patch', status: 'done', output: expect.stringContaining('Finished') }]);
    expect(after[1]).toMatchObject({ answerId: 'reply', answer: 'Checking', steps: [], streaming: true });
  });

  it('keeps commentary visible when a turn stops before posting its final reply', () => {
    const prompt = item('prompt', 'user');
    const progress = item('progress', 'assistant', 'The patch is ready.', { assistantPhase: 'commentary' });
    const [turn] = chatExchanges([prompt, tool('patch'), progress], { ...state, phase: 'idle' }, fresh);
    expect(turn).toMatchObject({ answer: progress.text, answerId: progress.id, steps: [{ id: 'patch' }] });
  });

  it('keeps the visible reply identity when an empty streamed message is reserved', () => {
    const prompt = item('prompt', 'user');
    const partial = item('partial', 'assistant');
    const reply = item('reply', 'assistant', 'The patch is ready.');
    const [turn] = chatExchanges([prompt, partial, reply], state, fresh);
    expect(turn).toMatchObject({ answer: reply.text, answerId: reply.id, steps: [] });
  });

  it('keeps the saved reply in order with work before and after it and retains the exiting steps', () => {
    const projection = new ChatTranscriptProjection();
    const revision = 'a'.repeat(64);
    const earlier = item('commentary', 'assistant', 'Earlier explanation', { truncated: true });
    const reply = item('final', 'assistant', 'Final answer', { truncated: true });
    const command = { ...tool('test'), receipt: { id: 'receipt', error: false } };
    const receipt = item('receipt', 'tool_result', '12 passed', { toolId: 'test', truncated: true });
    const prompt = item('prompt', 'user', 'Verify the change', { completedTurn: {
      revision, endId: 'receipt', reply: [reply], beforeReply: 1, total: 3,
      counts: { run: 1 }, failures: 0,
    } });
    const work = { revision, toolIds: [], items: [earlier, command, receipt] } as const;
    const [expanded] = projection.project([prompt], state, fresh, undefined, new Map([[prompt.id, work]]));
    expect(expanded).toMatchObject({
      answer: 'Final answer', answerId: 'final', answerBeforeStepId: 'test',
      steps: [{ id: 'commentary' }, { id: 'test', status: 'done', fullContent: { outputId: 'receipt' } }],
      overflow: [{ id: 'commentary' }, { id: 'final' }],
    });
    const [closing] = projection.project([prompt], state, fresh, undefined, new Map([[prompt.id, { ...work, closing: true }]]));
    expect(closing?.steps).toBe(expanded?.steps);
    expect(closing?.overflow).toEqual([{ id: 'final', label: 'message' }]);
  });

  it('keeps the same evidence pair accessible at either paging edge and suppresses a redundant on-page result', () => {
    const revision = 'a'.repeat(64), next = 'b'.repeat(64);
    const call = { ...tool('test'), input: '', toolDetails: { revision, summary: 'pnpm test' },
      receipt: { id: 'reply', error: true, toolDetails: { revision: next, meta: 'Exit 1' } } };
    const [exchange] = chatExchanges([item('prompt', 'user'), call], state, fresh);
    const step = exchange?.steps[0];
    expect(step).toMatchObject({
      id: 'test', status: 'failed', detail: 'pnpm test', meta: 'Exit 1',
      deferredTool: { item: { id: 'test', revision }, result: { id: 'reply', revision: next } },
    });
    expect(step?.presentation).toBeUndefined();
    expect(step?.output).toBeUndefined();
    const output = item('reply', 'tool_result', '', { toolId: 'test', error: true,
      toolDetails: { revision: next, meta: 'Exit 1' },
      invocation: { id: call.id, toolKind: 'bash', toolDetails: call.toolDetails } });
    const [resultOnly] = chatExchanges([item('prompt', 'user'), output], state, fresh);
    expect(resultOnly?.steps).toMatchObject([{
      id: 'reply', verb: 'Result', kind: 'run', detail: 'pnpm test', status: 'failed',
      deferredTool: step?.deferredTool,
    }]);
    const [joined] = chatExchanges([item('prompt', 'user'), call, output], state, fresh);
    expect(joined?.steps).toEqual([step]);
    const [orphan] = chatExchanges([item('reply', 'tool_result', '', { toolId: 'test', toolDetails: { revision: next } })], state, fresh);
    expect(orphan?.steps[0]?.deferredTool).toEqual({ item: { id: 'reply', revision: next } });
  });

  it('preserves shared change attribution in inline and compact turns', () => {
    const reply = item('reply', 'assistant', 'Explained the implementation.');
    const changes = { total: 1, shared: true, files: [{ path: 'capture.log', status: 'M', add: 2, del: 0 }] } as const;
    const prompt = item('prompt', 'user');
    const [inline] = chatExchanges([prompt, reply, item('capture', 'system', '', { changes })], state, fresh);
    const [compact] = chatExchanges([{ ...prompt, completedTurn: {
      revision: 'a'.repeat(64), endId: 'capture', beforeReply: 1, total: 1,
      reply: [reply], counts: { run: 1 }, failures: 0, changes,
    } }], state, fresh);
    for (const turn of [inline, compact])
      expect(turn).toMatchObject({ sharedChanges: true, files: changes.files, filesTotal: 1 });
  });

  it('prefers verified turn totals over per-tool and capture preview rows', () => {
    const changes = { total: 6, lineTotals: { add: 40, del: 15 },
      files: [{ path: 'src/retry.ts', status: 'M', add: 2, del: 1 }] } as const;
    const prompt = item('prompt', 'user'), reply = item('reply', 'assistant', 'Done.');
    const capture = item('capture', 'system', '', { changes: { ...changes, total: 220 } });
    const [raw] = chatExchanges([{ ...prompt, turnChanges: changes }, tool('call'), reply, capture], state, fresh);
    const [compact] = chatExchanges([{ ...prompt, completedTurn: {
      revision: 'a'.repeat(64), endId: capture.id, beforeReply: 1, total: 1,
      reply: [reply], counts: { run: 1 }, failures: 0, changes,
    } }], state, fresh);
    for (const turn of [raw, compact])
      expect(turn).toMatchObject({ filesTotal: 6, files: changes.files, filesDiff: changes.lineTotals, answer: 'Done.' });
  });

  it('ignores unrelated runtime updates and only changes the active turn for phase/decision updates', () => {
    const projection = new ChatTranscriptProjection();
    const items = [item('u1', 'user', 'Earlier'), item('a1', 'assistant', 'Done'),
      item('u2', 'user', 'Latest'), item('a2', 'assistant', 'Streaming')];
    const first = projection.project(items, state, fresh);
    const runtime = { ...state, context: { tokens: 20, limit: 100, percentage: 20 }, queue: [{ id: 'q', text: 'Next' }] };
    expect(projection.project(items, runtime, fresh)).toBe(first);
    const waiting = projection.project(items, { ...runtime, phase: 'waiting' }, fresh);
    expect(waiting[0]).toBe(first[0]);
    expect(waiting[1]!.streaming).toBe(false);
    const failed = projection.project(items, { ...state, phase: 'error', error: 'Disconnected' }, fresh);
    expect(failed[0]).toBe(first[0]);
    expect(failed[1]).toMatchObject({ status: 'failed', error: 'Disconnected' });
  });

  it('preserves Claude source identities and releases evicted turns and explicit replacements', () => {
    const projection = new ChatTranscriptProjection();
    const prompt = item('u', 'user', 'Inspect');
    const live = item('msg_wire:0', 'assistant', 'Reply');
    const saved = item('msg_wire:assistant:0', 'assistant', 'Reply');
    const first = projection.project([prompt, live], state, fresh);
    const reconciled = projection.project([prompt, live, saved], state, fresh);
    expect(reconciled).toEqual(chatExchanges([prompt, live, saved], state, fresh));
    expect(reconciled[0]!.answerId).toBe(first[0]!.answerId);
    projection.project([], state, fresh);
    expect(projection.project([prompt, live], state, fresh)[0]).not.toBe(first[0]);
    projection.clear();
    expect(projection.project([prompt, live, saved], state, fresh)[0]).not.toBe(reconciled[0]);
  });
});
