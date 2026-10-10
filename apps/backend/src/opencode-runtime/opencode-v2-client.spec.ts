/* Async mocks intentionally implement the native promise API without I/O. */
/* eslint-disable @typescript-eslint/require-await */
import type {
  OpenCodeClient as NativeClient,
  SessionMessageInfo,
  FormInfo,
  V2Event,
} from '@opencode/client';
import { createOpenCodeV2Client } from './opencode-v2-client.js';

const assistant = (id: string): SessionMessageInfo => ({
  type: 'assistant',
  id,
  agent: 'build',
  model: { providerID: 'test', id: 'model' },
  time: { created: 1 },
  content: [{ type: 'text', text: 'hello' }],
});

describe('OpenCode v2 protocol adapter', () => {
  it.each(['compact', 'skill'])(
    'applies the current model, variant, agent and mission before %s',
    async (operation) => {
      const session = {
        get: async () => ({
          location: { directory: '/repo' },
          agent: 'build',
          model: { providerID: 'old', id: 'old' },
        }),
        switchAgent: jest.fn(),
        switchModel: jest.fn(),
        compact: jest.fn(),
        skill: jest.fn(),
        wait: jest.fn(),
        instructions: { entry: { put: jest.fn() } },
      };
      const client = createOpenCodeV2Client(
        { session } as unknown as NativeClient,
        '/repo',
      );
      const selection = {
        model: { providerID: 'test', modelID: 'model' },
        variant: 'high',
        agent: 'plan',
        system: 'Mission',
      };
      if (operation === 'compact') await client.compact!('s', selection);
      else await client.activateSkill!('s', 'review', selection);
      expect(session.switchAgent).toHaveBeenCalledWith({
        sessionID: 's',
        agent: 'plan',
      });
      expect(session.switchModel).toHaveBeenCalledWith({
        sessionID: 's',
        model: { providerID: 'test', id: 'model', variant: 'high' },
      });
      expect(session.instructions.entry.put).toHaveBeenCalledWith({
        sessionID: 's',
        key: 'elevenex-system',
        value: 'Mission',
      });
      expect(session.wait).toHaveBeenCalledWith({ sessionID: 's' });
    },
  );
  it.each([false, true])(
    'replaces a pinned model with the %s agent default and its variant',
    async (hasAgentModel) => {
      const session = {
        get: jest.fn(async () => ({
          location: { directory: '/repo' },
          agent: 'build',
          model: { providerID: 'old', id: 'pinned', variant: 'high' },
        })),
        switchModel: jest.fn(),
        prompt: jest.fn(),
        wait: jest.fn(),
      };
      const list = jest.fn(async () => ({
        data: [assistant('latest')],
        cursor: {},
      }));
      const defaultModel = jest.fn(async () => ({
        data: { providerID: 'project', id: 'default' },
      }));
      const client = createOpenCodeV2Client(
        {
          session,
          agent: {
            get: async () => ({
              data: {
                model: hasAgentModel
                  ? { providerID: 'agent', id: 'custom', variant: 'medium' }
                  : undefined,
              },
            }),
          },
          model: { default: defaultModel },
          message: { list },
        } as unknown as NativeClient,
        '/repo',
      );
      await client.session.prompt({
        sessionID: 's',
        parts: [{ type: 'text', text: 'Use default' }],
      });
      expect(session.switchModel).toHaveBeenCalledWith({
        sessionID: 's',
        model: hasAgentModel
          ? { providerID: 'agent', id: 'custom', variant: 'medium' }
          : { providerID: 'project', id: 'default', variant: undefined },
      });
      expect(defaultModel).toHaveBeenCalledTimes(hasAgentModel ? 0 : 1);
      expect(list.mock.calls).toEqual([
        [
          { sessionID: 's', type: 'assistant', order: 'desc', limit: 1 },
          { signal: undefined },
        ],
      ]);
    },
  );
  it('clears a pinned variant when the same model is selected without a variant', async () => {
    const session = {
      get: async () => ({
        location: { directory: '/repo' },
        agent: 'build',
        model: { providerID: 'test', id: 'model', variant: 'high' },
      }),
      switchModel: jest.fn(),
      prompt: jest.fn(),
      wait: jest.fn(),
    };
    const client = createOpenCodeV2Client(
      {
        session,
        message: { list: async () => ({ data: [], cursor: {} }) },
      } as unknown as NativeClient,
      '/repo',
    );
    await client.session.prompt({
      sessionID: 's',
      model: { providerID: 'test', modelID: 'model' },
      parts: [],
    });
    expect(session.switchModel).toHaveBeenCalledWith({
      sessionID: 's',
      model: { providerID: 'test', id: 'model', variant: undefined },
    });
  });
  it('retains native OAuth setup requirements for non-string form fields', async () => {
    const client = createOpenCodeV2Client(
      {
        integration: {
          list: async () => ({
            data: [
              {
                id: 'custom',
                methods: [
                  {
                    type: 'oauth',
                    label: 'Login',
                    form: [{ key: 'organization', type: 'boolean' }],
                  },
                ],
              },
            ],
          }),
        },
      } as unknown as NativeClient,
      '/repo',
    );
    expect((await client.provider.auth()).data?.custom[0].prompts).toHaveLength(
      1,
    );
  });
  it('follows native cursors without sending order again', async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        data: [assistant('a')],
        cursor: { next: 'cursor' },
      })
      .mockResolvedValueOnce({ data: [assistant('b')], cursor: {} });
    const client = createOpenCodeV2Client(
      { message: { list } } as unknown as NativeClient,
      '/repo',
    );
    expect(
      (await client.session.messages({ sessionID: 's' })).data?.map(
        (message) => message.info.id,
      ),
    ).toEqual(['a', 'b']);
    expect(list.mock.calls).toEqual([
      [{ sessionID: 's', limit: 200, order: 'asc' }],
      [{ sessionID: 's', limit: 200, cursor: 'cursor' }],
    ]);
  });
  it('moves to the current worktree, switches model and agent, and awaits queued prompts', async () => {
    const session = {
      get: jest.fn(async () => ({
        location: { directory: '/old' },
        agent: 'build',
      })),
      move: jest.fn(),
      switchAgent: jest.fn(),
      switchModel: jest.fn(),
      prompt: jest.fn(),
      wait: jest.fn(),
      instructions: { entry: { put: jest.fn() } },
    };
    const client = createOpenCodeV2Client(
      {
        session,
        message: { list: async () => ({ data: [assistant('a')], cursor: {} }) },
      } as unknown as NativeClient,
      '/repo',
    );
    const result = await client.session.prompt({
      sessionID: 's',
      agent: 'plan',
      model: { providerID: 'test', modelID: 'model' },
      variant: 'custom',
      system: 'Mission instructions',
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'file', mime: 'image/png', url: 'data:image/png;base64,abcd' },
      ],
    });
    expect(session.instructions.entry.put).toHaveBeenCalledWith({
      sessionID: 's',
      key: 'elevenex-system',
      value: 'Mission instructions',
    });
    expect(session.move).toHaveBeenCalledWith({
      sessionID: 's',
      directory: '/repo',
    });
    expect(session.switchAgent).toHaveBeenCalledWith({
      sessionID: 's',
      agent: 'plan',
    });
    expect(session.switchModel).toHaveBeenCalledWith({
      sessionID: 's',
      model: { providerID: 'test', id: 'model', variant: 'custom' },
    });
    expect(session.prompt).toHaveBeenCalledWith(
      {
        sessionID: 's',
        text: 'hello',
        files: [{ uri: 'data:image/png;base64,abcd', name: undefined }],
      },
      { signal: undefined },
    );
    expect(session.wait).toHaveBeenCalled();
    expect(result.data?.info.id).toBe('a');
  });
  it('answers typed forms and enforces pending request ownership', async () => {
    const form: FormInfo = {
      id: 'f',
      sessionID: 's',
      title: 'Choose',
      time: { created: 1 },
      state: { status: 'pending' },
      fields: [
        {
          key: 'values',
          type: 'multiselect',
          options: [{ value: 'a, b', label: 'A' }],
        },
      ],
    };
    const reply = jest.fn();
    const client = createOpenCodeV2Client(
      {
        form: { list: async () => ({ data: [form] }) },
        session: { form: { reply } },
      } as unknown as NativeClient,
      '/repo',
    );
    await expect(client.answerForm!('missing', {})).rejects.toThrow(
      'no longer pending',
    );
    await client.question.list();
    await client.answerForm!('f', {
      values: ['a, b'],
      count: 3,
      enabled: true,
    });
    expect(reply).toHaveBeenCalledWith({
      sessionID: 's',
      formID: 'f',
      answer: { values: ['a, b'], count: 3, enabled: true },
    });
    await expect(client.answerForm!('f', {})).rejects.toThrow(
      'no longer pending',
    );
  });
  it('uses identical text ids for streaming and persisted history', async () => {
    const native = {
      event: {
        subscribe: () =>
          (async function* () {
            yield {
              id: 'e',
              type: 'session.text.started',
              created: 1,
              data: { sessionID: 's', assistantMessageID: 'a', ordinal: 0 },
            } as V2Event;
            yield {
              id: 'e2',
              type: 'session.text.delta',
              created: 2,
              data: {
                sessionID: 's',
                assistantMessageID: 'a',
                ordinal: 0,
                delta: 'hello',
              },
            } as V2Event;
          })(),
      },
      message: { list: async () => ({ data: [assistant('a')], cursor: {} }) },
    };
    const client = createOpenCodeV2Client(
      native as unknown as NativeClient,
      '/repo',
    );
    const events = [];
    for await (const event of (await client.event.subscribe()).stream)
      events.push(event);
    expect(events[0]).toMatchObject({ properties: { part: { id: 'a:0' } } });
    expect(events[1]).toMatchObject({ properties: { partID: 'a:0' } });
    expect(
      (await client.session.messages({ sessionID: 's' })).data?.[0].parts[0].id,
    ).toBe('a:0');
  });
  it('retries a native catalog whose configured default has not materialized yet', async () => {
    const models = jest
      .fn()
      .mockResolvedValueOnce({ data: [], location: { directory: '/repo' } })
      .mockResolvedValue({
        data: [
          {
            id: 'model',
            modelID: 'model',
            providerID: 'local',
            name: 'Model',
            status: 'active',
            enabled: true,
            time: { released: 1 },
            variants: [],
            capabilities: { input: ['text'], output: ['text'], tools: true },
            limit: { context: 10000, output: 1000 },
          },
        ],
        location: { directory: '/repo' },
      });
    const client = createOpenCodeV2Client(
      {
        config: {
          get: async () => [
            {
              type: 'document',
              info: { model: { providerID: 'local', model: 'model' } },
            },
          ],
        },
        model: {
          default: async () => ({
            data: { providerID: 'opencode', id: 'free' },
          }),
          list: models,
        },
        provider: {
          list: async () => ({
            data: [{ id: 'local', name: 'Local', activation: 'enabled' }],
            location: { directory: '/repo' },
          }),
        },
        integration: { list: async () => ({ data: [] }) },
      } as unknown as NativeClient,
      '/repo',
    );
    const catalog = (await client.provider.list()).data!;
    expect(models).toHaveBeenCalledTimes(2);
    expect(catalog.connected).toContain('local');
    expect(catalog.all[0].models.model.id).toBe('model');
  });
});
