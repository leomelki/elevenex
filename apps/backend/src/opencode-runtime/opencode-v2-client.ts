import type { OpenCodeClient as V2Client, ConfigEntry } from '@opencode/client';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Message,
  Part,
  Provider,
  ProviderAuthMethod,
  Config,
} from '@opencode-ai/sdk/v2/client';
import type { OpenCodeClient } from './opencode-client.js';
import { OpenCodeV2Events } from './opencode-v2-events.js';
import {
  v2Form,
  v2Message,
  v2Model,
  v2Permission,
  v2Permissions,
  v2Session,
} from './opencode-v2-mapping.js';

function configuredModel(entries: ConfigEntry[]): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'document' || !entry.info.model) continue;
    const model = entry.info.model;
    return typeof model === 'string'
      ? model
      : `${model.providerID}/${model.model}`;
  }
  return undefined;
}

/** Typed compatibility adapter. Native V2 remains responsible for tools, plugins, and execution. */
export function createOpenCodeV2Client(
  native: V2Client,
  directory: string,
): OpenCodeClient {
  const location = { directory };
  const oauth = new Map<string, { methodID: string; attemptID: string }>();
  const events = new OpenCodeV2Events(native, directory);
  const { forms, permissionOwners } = events;
  const wrap = <T>(data: T) => ({ data });
  const messages = async (sessionID: string) => {
    const results: { info: Message; parts: Part[] }[] = [];
    let cursor: string | undefined;
    do {
      const page = await native.message.list({
        sessionID,
        limit: 200,
        ...(cursor ? { cursor } : { order: 'asc' }),
      });
      for (const message of page.data) {
        const mapped = v2Message(sessionID, message);
        if (mapped) results.push(mapped);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    events.hydrate(results);
    return results;
  };
  const configurePrompt = async (
    input: Parameters<OpenCodeClient['session']['prompt']>[0],
  ) => {
    const session = await native.session.get({ sessionID: input.sessionID });
    if (session.location.directory !== directory)
      await native.session.move({ sessionID: input.sessionID, directory });
    const agent = input.agent ?? session.agent;
    const agentChanged = !!input.agent && input.agent !== session.agent;
    if (agentChanged)
      await native.session.switchAgent({
        sessionID: input.sessionID,
        agent: input.agent!,
      });
    let selected = input.model
      ? {
          id: input.model.modelID,
          providerID: input.model.providerID,
          variant: input.variant,
        }
      : undefined;
    if (!selected) {
      const agentModel = agent
        ? (await native.agent.get({ agentID: agent, location })).data.model
        : undefined;
      const fallback =
        agentModel ?? (await native.model.default({ location })).data;
      if (!fallback) throw new Error('No default OpenCode model is available.');
      selected = {
        id: fallback.id,
        providerID: fallback.providerID,
        variant: input.variant ?? agentModel?.variant,
      };
    }
    if (
      agentChanged ||
      session.model?.id !== selected.id ||
      session.model.providerID !== selected.providerID ||
      session.model.variant !== selected.variant
    )
      await native.session.switchModel({
        sessionID: input.sessionID,
        model: selected,
      });
    if (input.system)
      await native.session.instructions.entry.put({
        sessionID: input.sessionID,
        key: 'elevenex-system',
        value: input.system,
      });
  };
  const wait = async (
    sessionID: string,
    options?: { signal?: AbortSignal },
  ) => {
    await native.session.wait(
      { sessionID },
      { signal: options?.signal ?? undefined },
    );
    // The final response is enough here. The provider performs one authoritative history reconciliation.
    const page = await native.message.list(
      { sessionID, type: 'assistant', order: 'desc', limit: 1 },
      options,
    );
    const result = page.data[0] ? v2Message(sessionID, page.data[0]) : null;
    return wrap(
      result?.info.role === 'assistant'
        ? { info: result.info, parts: result.parts }
        : undefined,
    );
  };
  const integrationMethods = async () => {
    const result: Record<string, ProviderAuthMethod[]> = {};
    for (const integration of (await native.integration.list({ location }))
      .data) {
      result[integration.id] = integration.methods.flatMap<ProviderAuthMethod>(
        (method) => {
          if (method.type === 'key')
            return [{ type: 'api' as const, label: method.label ?? 'API key' }];
          if (method.type === 'oauth')
            return [
              {
                type: 'oauth' as const,
                label: method.label,
                ...(method.form?.length
                  ? {
                      prompts: method.form.map((field) => ({
                        type: 'text' as const,
                        key: field.key,
                        message: field.title ?? field.key,
                      })),
                    }
                  : {}),
              },
            ];
          return [];
        },
      );
    }
    return result;
  };
  const client: OpenCodeClient = {
    global: {
      health: async () => {
        const info = await native.server.info();
        return wrap({ healthy: true, version: info.version });
      },
    },
    config: {
      get: async () => {
        const [entries, model] = await Promise.all([
          native.config.get({ location }),
          native.model.default({ location }),
        ]);
        const mcp: NonNullable<Config['mcp']> = {};
        for (const entry of entries)
          if (entry.type === 'document') {
            for (const [name, server] of Object.entries(
              entry.info.mcp?.servers ?? {},
            )) {
              mcp[name] =
                server.type === 'local'
                  ? {
                      type: 'local',
                      command: server.command,
                      enabled: !server.disabled,
                    }
                  : {
                      type: 'remote',
                      url: server.url,
                      enabled: !server.disabled,
                    };
            }
          }
        return wrap({
          model:
            configuredModel(entries) ??
            (model.data
              ? `${model.data.providerID}/${model.data.id}`
              : undefined),
          mcp,
        });
      },
    },
    provider: {
      list: async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = await native.config.get({ location });
          const defaultModel = (await native.model.default({ location })).data;
          const expected =
            configuredModel(before) ??
            (defaultModel
              ? `${defaultModel.providerID}/${defaultModel.id}`
              : undefined);
          // Listing configured models registers their custom providers lazily.
          const models = await native.model.list({ location });
          const [providers, integrations, after] = await Promise.all([
            native.provider.list({ location }),
            native.integration.list({ location }),
            native.config.get({ location }),
          ]);
          // Config/plugins load asynchronously. Retry snapshots taken across a configuration change.
          if (
            attempt < 2 &&
            (JSON.stringify(before) !== JSON.stringify(after) ||
              (expected &&
                !models.data.some(
                  (model) =>
                    `${model.providerID}/${model.id}` === expected &&
                    model.enabled,
                )))
          ) {
            // Model discovery and activation finish in a background task after config becomes visible.
            await delay(100 * (attempt + 1));
            continue;
          }
          const connectedIntegrations = new Set(
            integrations.data
              .filter((integration) => integration.connections.length > 0)
              .map((integration) => integration.id),
          );
          const all: Provider[] = providers.data.map((provider) => ({
            id: provider.id,
            name: provider.name,
            source: 'config',
            env: [],
            options: {},
            models: Object.fromEntries(
              models.data
                .filter(
                  (model) => model.providerID === provider.id && model.enabled,
                )
                .map((model) => [model.id, v2Model(model)]),
            ),
          }));
          // Authentication UI uses integration ids; models use provider ids (often, but not always, equal).
          for (const integration of integrations.data)
            if (!all.some((provider) => provider.id === integration.id))
              all.push({
                id: integration.id,
                name: integration.name,
                source: 'config',
                env: [],
                options: {},
                models: {},
              });
          const connected = [
            ...connectedIntegrations,
            ...providers.data
              .filter(
                (provider) =>
                  provider.activation !== 'disabled' &&
                  (connectedIntegrations.has(
                    provider.integrationID ?? provider.id,
                  ) ||
                    !provider.integrationID ||
                    models.data.some(
                      (model) =>
                        model.providerID === provider.id && model.enabled,
                    )),
              )
              .map((provider) => provider.id),
          ];
          return wrap({ all, connected, default: {} });
        }
        throw new Error('OpenCode model catalog did not settle.');
      },
      auth: async () => wrap(await integrationMethods()),
      oauth: {
        authorize: async ({ providerID, method }) => {
          const integration = (
            await native.integration.get({
              integrationID: providerID,
              location,
            })
          ).data;
          const methods = integration.methods.filter(
            (entry) => entry.type === 'key' || entry.type === 'oauth',
          );
          const selected = methods[method ?? 0];
          if (selected?.type !== 'oauth')
            throw new Error('Choose an OAuth method.');
          const attempt = (
            await native.integration.oauth.connect({
              integrationID: providerID,
              methodID: selected.id,
              location,
            })
          ).data;
          oauth.set(providerID, {
            methodID: selected.id,
            attemptID: attempt.attemptID,
          });
          return wrap({
            url: attempt.url,
            instructions: attempt.instructions,
            method: attempt.mode,
          });
        },
        callback: async ({ providerID, code }, options) => {
          const attempt = oauth.get(providerID);
          if (!attempt) throw new Error('No pending OpenCode OAuth attempt.');
          if (code)
            await native.integration.oauth.complete(
              {
                integrationID: providerID,
                attemptID: attempt.attemptID,
                code,
                location,
              },
              { signal: options?.signal ?? undefined },
            );
          while (!options?.signal?.aborted) {
            const status = (
              await native.integration.oauth.status(
                {
                  integrationID: providerID,
                  attemptID: attempt.attemptID,
                  location,
                },
                { signal: options?.signal ?? undefined },
              )
            ).data;
            if (status.status === 'complete') {
              oauth.delete(providerID);
              return wrap(true);
            }
            if (status.status === 'failed' || status.status === 'expired')
              throw new Error(
                status.status === 'failed'
                  ? status.message
                  : 'OpenCode login expired.',
              );
            await new Promise<void>((resolve, reject) => {
              const signal = options?.signal;
              const timer = setTimeout(() => {
                signal?.removeEventListener('abort', cancel);
                resolve();
              }, 1000);
              const cancel = () => {
                clearTimeout(timer);
                reject(new Error('OpenCode login cancelled.'));
              };
              signal?.addEventListener('abort', cancel, { once: true });
            });
          }
          throw new Error('OpenCode login cancelled.');
        },
      },
    },
    auth: {
      set: async ({ providerID, auth }) => {
        if (auth?.type !== 'api')
          throw new Error(
            'Use the OpenCode OAuth flow for subscription login.',
          );
        await native.integration.connect.key({
          integrationID: providerID,
          key: auth.key,
          location,
        });
        return wrap(true);
      },
    },
    instance: {
      dispose: async () => {
        await native.location.reload();
        return wrap(true);
      },
    },
    session: {
      create: async (input) =>
        wrap(
          v2Session(
            await native.session.create({
              location,
              title: input?.title,
              parentID: input?.parentID,
              permissions: v2Permissions(input?.permission),
            }),
          ),
        ),
      get: async ({ sessionID }) =>
        wrap(v2Session(await native.session.get({ sessionID }))),
      update: async ({ sessionID, title, permission }) => {
        await native.session.update({
          sessionID,
          title,
          permissions: v2Permissions(permission),
        });
        return wrap(v2Session(await native.session.get({ sessionID })));
      },
      delete: async ({ sessionID }) => {
        await native.session.remove({ sessionID });
        return wrap(true);
      },
      messages: async ({ sessionID }) => wrap(await messages(sessionID)),
      status: async () =>
        wrap(
          Object.fromEntries(
            Object.keys(await native.session.active()).map((sessionID) => [
              sessionID,
              { type: 'busy' as const },
            ]),
          ),
        ),
      children: async ({ sessionID }) => {
        const children: ReturnType<typeof v2Session>[] = [];
        let cursor: string | undefined;
        do {
          const page = await native.session.list(
            cursor
              ? { cursor, limit: 200 }
              : { parentID: sessionID, limit: 200 },
          );
          children.push(...page.data.map(v2Session));
          cursor = page.cursor.next ?? undefined;
        } while (cursor);
        return wrap(children);
      },
      prompt: async (input, options) => {
        await configurePrompt(input);
        if (input.noReply) {
          await native.session.synthetic({
            sessionID: input.sessionID,
            text: (input.parts ?? [])
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
          });
          return { data: undefined };
        }
        await native.session.prompt(
          {
            sessionID: input.sessionID,
            text: (input.parts ?? [])
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
            files: (input.parts ?? [])
              .filter((part) => part.type === 'file')
              .map((part) => ({ uri: part.url, name: part.filename })),
          },
          { signal: options?.signal ?? undefined },
        );
        return wait(input.sessionID, { signal: options?.signal ?? undefined });
      },
      command: async (input, options) => {
        await configurePrompt({
          sessionID: input.sessionID,
          agent: input.agent,
          variant: input.variant,
          ...(input.model
            ? {
                model: {
                  providerID: input.model.slice(0, input.model.indexOf('/')),
                  modelID: input.model.slice(input.model.indexOf('/') + 1),
                },
              }
            : {}),
        });
        await native.session.command(
          {
            sessionID: input.sessionID,
            name: input.command ?? '',
            text: input.arguments ?? '',
            files: input.parts?.map((part) => ({
              uri: part.url,
              name: part.filename,
            })),
          },
          { signal: options?.signal ?? undefined },
        );
        return wait(input.sessionID, { signal: options?.signal ?? undefined });
      },
      abort: async ({ sessionID }) => {
        await native.session.interrupt({ sessionID });
        return wrap(true);
      },
      fork: async ({ sessionID, messageID }) =>
        wrap(
          v2Session(
            await native.session.fork({ sessionID, before: messageID }),
          ),
        ),
      deleteMessage: () =>
        Promise.reject(new Error('V2 uses native history rewind.')),
    },
    command: {
      list: async () =>
        wrap(
          (await native.command.list({ location })).data.map((command) => ({
            ...command,
            template: '',
            hints: [],
          })),
        ),
    },
    permission: {
      list: async () => {
        const requests = (await native.permission.request.list({ location }))
          .data;
        for (const request of requests)
          permissionOwners.set(request.id, request.sessionID);
        return wrap(requests.map(v2Permission));
      },
      reply: async ({ requestID, reply, message }) => {
        const sessionID = permissionOwners.get(requestID);
        if (!sessionID)
          throw new Error('OpenCode permission is no longer pending.');
        await native.permission.reply({
          sessionID,
          requestID,
          decision: reply ?? 'once',
          message,
        });
        permissionOwners.delete(requestID);
        return wrap(true);
      },
    },
    question: {
      list: async () => {
        const pending = (await native.form.list({ location })).data;
        for (const form of pending) forms.set(form.id, form);
        return wrap(pending.map(v2Form));
      },
      reply: async ({ requestID, answers }) => {
        const form = forms.get(requestID);
        if (!form) throw new Error('OpenCode form is no longer pending.');
        const answer = Object.fromEntries(
          form.fields.map((field, index) => [
            field.key,
            (answers?.[index] ?? [])[0] ?? '',
          ]),
        );
        await native.session.form.reply({
          sessionID: form.sessionID,
          formID: requestID,
          answer,
        });
        forms.delete(requestID);
        return wrap(true);
      },
      reject: async ({ requestID }) => {
        const form = forms.get(requestID);
        if (!form) throw new Error('OpenCode form is no longer pending.');
        await native.session.form.cancel({
          sessionID: form.sessionID,
          formID: requestID,
        });
        forms.delete(requestID);
        return wrap(true);
      },
    },
    mcp: {
      status: async () =>
        wrap(
          Object.fromEntries(
            (await native.mcp.list({ location })).data.map((server) => [
              server.name,
              server.status.status === 'pending'
                ? {
                    status: 'failed' as const,
                    error: 'MCP server is connecting.',
                  }
                : server.status,
            ]),
          ),
        ),
      connect: async ({ name }) => {
        await native.mcp.connect({ server: name, location });
        return wrap(true);
      },
      disconnect: async ({ name }) => {
        await native.mcp.disconnect({ server: name, location });
        return wrap(true);
      },
      auth: {
        start: async ({ name }) => {
          const server = (await native.mcp.list({ location })).data.find(
            (entry) => entry.name === name,
          );
          if (!server?.integrationID)
            throw new Error('This MCP server does not offer OAuth.');
          const authorization = (
            await client.provider.oauth.authorize({
              providerID: server.integrationID,
            })
          ).data!;
          void client.provider.oauth
            .callback({ providerID: server.integrationID })
            .catch(() => undefined);
          return wrap({ authorizationUrl: authorization.url, oauthState: '' });
        },
      },
    },
    event: {
      subscribe: (_input, options) =>
        Promise.resolve({
          stream: events.stream(
            native.event.subscribe({ signal: options?.signal ?? undefined }),
          ),
        }),
    },
    moveSession: async (sessionID, destination) => {
      await native.session.move({ sessionID, directory: destination });
    },
    rewindHistory: async (sessionID, messageID) => {
      await native.session.revert.stage({ sessionID, messageID, files: false });
      await native.session.revert.commit({ sessionID });
    },
    steerPrompt: async (sessionID, text) => {
      await native.session.prompt({ sessionID, text, delivery: 'steer' });
    },
    answerForm: async (requestID, answer) => {
      const form = forms.get(requestID);
      if (!form) throw new Error('OpenCode form is no longer pending.');
      await native.session.form.reply({
        sessionID: form.sessionID,
        formID: requestID,
        answer,
      });
      forms.delete(requestID);
    },
    cancelOAuth: async () => {
      for (const [integrationID, attempt] of oauth)
        await native.integration.oauth
          .cancel({ integrationID, attemptID: attempt.attemptID, location })
          .catch(() => undefined);
      oauth.clear();
    },
    resources: async () => {
      const [agents, skills, config] = await Promise.all([
        native.agent.list({ location }),
        native.skill.list({ location }),
        native.config.get({ location }),
      ]);
      return {
        defaultAgent: config
          .filter((entry) => entry.type === 'document')
          .map((entry) => entry.info.default_agent)
          .filter(Boolean)
          .at(-1),
        agents: agents.data
          .filter((agent) => !agent.hidden)
          .map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            primary: agent.mode !== 'subagent',
          })),
        skills: skills.data.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
        })),
      };
    },
    selection: async (sessionID) => {
      const session = await native.session.get({ sessionID });
      return {
        model: session.model
          ? `${session.model.providerID}/${session.model.id}`
          : null,
        variant: session.model?.variant ?? null,
        agent: session.agent,
      };
    },
    compact: async (sessionID, selection) => {
      await configurePrompt({ sessionID, ...selection });
      await native.session.compact({ sessionID });
      await native.session.wait({ sessionID });
    },
    activateSkill: async (sessionID, id, selection) => {
      await configurePrompt({ sessionID, ...selection });
      await native.session.skill({ sessionID, id });
      await native.session.wait({ sessionID });
    },
    selectAgent: async (sessionID, agent) => {
      await native.session.switchAgent({ sessionID, agent });
    },
  };

  return client;
}
