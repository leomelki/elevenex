import {
  openCodeModel,
  openCodePartItems,
  openCodePermissionRules,
  openCodeQuestion,
} from './opencode-transcript.js';
import { v2Message, v2Permissions } from './opencode-v2-mapping.js';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

describe('OpenCode protocol normalization', () => {
  it('preserves nested provider model ids and rejects ambiguous ids', () => {
    expect(openCodeModel('openrouter/anthropic/claude')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude',
    });
    expect(openCodeModel(null)).toBeUndefined();
    expect(() => openCodeModel('claude')).toThrow('provider/model');
  });
  it('uses stable text ids, preserves role, and exposes plan messages', () => {
    const info = {
      id: 'm',
      role: 'assistant',
      agent: 'plan',
      time: { created: 10 },
    } as Message;
    const part = {
      id: 'p',
      sessionID: 's',
      messageID: 'm',
      type: 'text',
      text: 'Plan',
    } as Part;
    expect(openCodePartItems(part, info)[0]).toMatchObject({
      id: 'p',
      kind: 'assistant',
      contentType: 'plan',
      sourceMessageId: 'm',
      content: 'Plan',
    });
    expect(
      openCodePartItems({ ...part, text: 'Plan updated' }, info)[0].id,
    ).toBe('p');
    expect(openCodePartItems({ ...part, ignored: true }, info)).toEqual([]);
  });
  it('normalizes OpenCode edit fields and returns exactly one call/result pair', () => {
    const part = {
      id: 'p',
      sessionID: 's',
      messageID: 'm',
      type: 'tool',
      tool: 'edit',
      callID: 'call',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', oldString: 'old', newString: 'new' },
        output: 'done',
        title: 'Edit',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    } as Part;
    const items = openCodePartItems(part);
    expect(items.map((item) => [item.id, item.kind])).toEqual([
      ['p', 'tool_use'],
      ['p:result', 'tool_result'],
    ]);
    expect(items[0].toolInput).toMatchObject({
      file_path: 'a.ts',
      old_string: 'old',
      new_string: 'new',
    });
  });
  it('preserves question identities and multiple selections', () => {
    const request = openCodeQuestion({
      id: 'q',
      sessionID: 's',
      questions: [
        {
          question: 'Choose',
          header: 'Choice',
          options: [{ label: 'A, B' }],
          multiple: true,
        },
      ],
    });
    expect(request.questions?.[0]).toMatchObject({
      id: '0',
      multiSelect: true,
      options: [{ label: 'A, B' }],
    });
  });
  it('preserves typed v2 forms including numeric and multiselect fields', () => {
    const request = openCodeQuestion({
      id: 'f',
      sessionID: 's',
      questions: [],
      title: 'Configure',
      fields: [
        { key: 'count', type: 'number', required: true },
        {
          key: 'tools',
          type: 'multiselect',
          options: [{ label: 'A, B', value: 'a,b' }],
        },
      ],
    });
    expect(request.requestedSchema).toMatchObject({
      type: 'object',
      required: ['count'],
      properties: {
        count: { type: 'number' },
        tools: { type: 'array', items: { enum: ['a,b'] } },
      },
    });
  });
  it('respects native defaults and translates explicit policies into v2 actions', () => {
    expect(openCodePermissionRules('default')).toBeUndefined();
    expect(
      v2Permissions([
        { permission: 'bash', pattern: 'git *', action: 'ask' },
        { permission: 'task', pattern: '*', action: 'deny' },
      ]),
    ).toEqual([
      { action: 'shell', resource: 'git *', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ]);
    expect(openCodePermissionRules('bypassPermissions')).toEqual([
      { permission: '*', pattern: '*', action: 'allow' },
    ]);
  });
  it('keeps live and persisted v2 assistant block identities consistent', () => {
    const mapped = v2Message('s', {
      id: 'm',
      type: 'assistant',
      agent: 'plan',
      model: { id: 'model', providerID: 'provider' },
      time: { created: 1 },
      content: [
        { type: 'reasoning', text: 'Think' },
        { type: 'text', text: 'Plan' },
      ],
    });
    expect(mapped?.parts.map((part) => part.id)).toEqual(['m:0', 'm:1']);
    expect(
      mapped?.parts
        .flatMap((part) => openCodePartItems(part, mapped.info))
        .map((item) => item.kind),
    ).toEqual(['thinking', 'assistant']);
  });
});
