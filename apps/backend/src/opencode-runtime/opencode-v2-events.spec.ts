/* eslint-disable @typescript-eslint/require-await */
import type {
  OpenCodeClient as NativeClient,
  SessionMessageInfo,
  V2Event,
} from '@opencode/client';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { OpenCodeV2Events } from './opencode-v2-events.js';
import { v2Message } from './opencode-v2-mapping.js';

const assistant: SessionMessageInfo = {
  type: 'assistant',
  id: 'm',
  agent: 'build',
  model: { providerID: 'test', id: 'model' },
  time: { created: 1 },
  content: [
    {
      type: 'tool',
      id: 't',
      name: 'read',
      time: { created: 1, ran: 2 },
      state: { status: 'running', input: { path: 'fixture' } },
    },
  ],
};
const success = {
  id: 'e',
  created: 3,
  type: 'session.tool.success',
  data: {
    sessionID: 's',
    assistantMessageID: 'm',
    id: 't',
    content: [{ type: 'text', text: 'result' }],
    executed: true,
  },
} as V2Event;
async function collect(
  adapter: OpenCodeV2Events,
  events: V2Event[],
): Promise<Event[]> {
  const result: Event[] = [];
  for await (const event of adapter.stream(
    (async function* () {
      yield* events;
    })(),
  ))
    result.push(event);
  return result;
}

describe('OpenCode native event recovery', () => {
  it('finishes tools seeded by restored history without another network request', async () => {
    const get = jest.fn();
    const adapter = new OpenCodeV2Events(
      { session: { message: { get } } } as unknown as NativeClient,
      '/repo',
    );
    adapter.hydrate([v2Message('s', assistant)!]);
    const events = await collect(adapter, [success]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 't',
          tool: 'read',
          state: {
            status: 'completed',
            input: { path: 'fixture' },
            output: 'result',
          },
        },
      },
    });
    expect(get).not.toHaveBeenCalled();
  });
  it('recovers a missed tool start with a single scoped message lookup', async () => {
    const get = jest.fn(async () => assistant);
    const adapter = new OpenCodeV2Events(
      { session: { message: { get } } } as unknown as NativeClient,
      '/repo',
    );
    const events = await collect(adapter, [success]);
    expect(get).toHaveBeenCalledWith({ sessionID: 's', messageID: 'm' });
    expect(events[0]).toMatchObject({
      type: 'message.part.updated',
      properties: { part: { id: 't', state: { status: 'completed' } } },
    });
  });
  it('recovers usage when the step start was missed and exposes failed steps', async () => {
    const get = jest.fn(async () => assistant);
    const adapter = new OpenCodeV2Events(
      { session: { message: { get } } } as unknown as NativeClient,
      '/repo',
    );
    const tokens = {
      input: 10,
      output: 2,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const events = await collect(adapter, [
      {
        id: 'end',
        created: 3,
        type: 'session.step.ended',
        data: { sessionID: 's', assistantMessageID: 'm', cost: 1, tokens },
      } as V2Event,
      {
        id: 'failure',
        created: 4,
        type: 'session.step.failed',
        data: {
          sessionID: 's',
          assistantMessageID: 'm',
          error: { message: 'Filtered response' },
        },
      } as V2Event,
    ]);
    expect(events[0]).toMatchObject({
      type: 'message.updated',
      properties: { info: { tokens, cost: 1, time: { completed: 3 } } },
    });
    expect(events[1]).toMatchObject({
      type: 'message.updated',
      properties: {
        info: { error: { data: { message: 'Filtered response' } } },
      },
    });
  });
});
