import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import type {
  OpenCodeClient,
  OpenCodeTurnSelection,
} from './opencode-client.js';
import { openCodeModel } from './opencode-transcript.js';

/** Keeps legacy protocol extensions separate from the native server's process lifecycle. */
export function createOpenCodeV1Client(legacy: OpencodeClient): OpenCodeClient {
  return Object.assign(legacy, {
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
