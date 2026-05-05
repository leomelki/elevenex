import { buildAugmentedEnv } from '../config/system-paths.js';
import { getElevenexProxyPort } from '../config/ports.js';

export function buildManagedPlannotatorEnv(
  sessionId: number,
  wrapperScriptPath: string,
  base: NodeJS.ProcessEnv = buildAugmentedEnv(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ELEVENEX_SESSION_ID: String(sessionId),
    ELEVENEX_PORT: String(getElevenexProxyPort()),
    PLANNOTATOR_BROWSER: wrapperScriptPath,
    PLANNOTATOR_REMOTE: '0',
  };

  delete env.PLANNOTATOR_PORT;
  return env;
}
