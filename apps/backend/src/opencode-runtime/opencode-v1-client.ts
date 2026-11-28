import { randomBytes } from 'node:crypto';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type {
  OpenCodeClient,
  OpenCodeTurnSelection,
} from './opencode-client.js';
import { openCodeModel } from './opencode-transcript.js';

/** Keeps legacy protocol extensions separate from the native server's process lifecycle. */
export function createOpenCodeV1Client(legacy: OpencodeClient): OpenCodeClient {
  let messageClock = 0n;
  return Object.assign(legacy, {
    steerPrompt: async (
      sessionID: string,
      text: string,
      selection?: OpenCodeTurnSelection,
      options?: { signal?: AbortSignal },
    ) => {
      // Legacy OpenCode sorts messages by ID. Reserve an ascending ID so
      // admission can be reconciled after the original prompt returns.
      const time = BigInt(Date.now()) * 0x1000n;
      messageClock = time > messageClock ? time : messageClock + 1n;
      const stamp = BigInt.asUintN(48, messageClock).toString(16).padStart(12, '0');
      const messageID = `msg_${stamp}${randomBytes(14).toString('hex')}`;
      await legacy.session.promptAsync(
        { sessionID, messageID, ...selection, parts: [{ type: 'text', text }] },
        options,
      );
      return async (signal: AbortSignal) => {
        const result = await legacy.session.message(
          { sessionID, messageID }, { signal, throwOnError: false },
        );
        if (!result.data && result.response.status !== 404)
          throw new Error('Could not confirm OpenCode steering admission.');
        return result.data?.info.id === messageID;
      };
    },
    resources: async () => {
      const [agents, skills, config] = await Promise.all([
        legacy.app.agents(),
        legacy.app.skills(),
        legacy.config.get(),
      ]);
      return {
        defaultAgent: config.data?.default_agent,
        agents: (agents.data ?? [])
          .filter((agent) => !agent.hidden)
          .map((agent) => ({
            id: agent.name,
            name: agent.name,
            description: agent.description,
            primary: agent.mode !== 'subagent',
          })),
        skills: (skills.data ?? []).map((skill) => ({
          id: skill.name,
          name: skill.name,
          description: skill.description,
        })),
      };
    },
    moveSession: async (sessionID: string, directory: string) => {
      await legacy.experimental.controlPlane.moveSession({
        sessionID,
        destination: { directory },
        moveChanges: false,
      });
    },
    compact: async (sessionID: string, selection?: OpenCodeTurnSelection) => {
      let model = selection?.model;
      if (!model && selection?.agent) {
        const agents = (await legacy.app.agents()).data;
        model = agents?.find((agent) => agent.name === selection.agent)?.model;
      }
      if (!model)
        model = openCodeModel((await legacy.config.get()).data?.model ?? null);
      if (!model) {
        const providers = (await legacy.provider.list()).data;
        const providerID = providers?.connected.find(
          (id) => providers.default[id],
        );
        if (providers && providerID)
          model = { providerID, modelID: providers.default[providerID] };
      }
      if (!model)
        throw new Error('Choose an OpenCode model before compacting.');
      // Unlike a normal prompt, the v1 summarize endpoint requires a concrete model in its body.
      await legacy.session.summarize({ sessionID, ...model });
    },
  });
}
