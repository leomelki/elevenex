import type { MachineEditInput } from '@elevenex/shared';
import { machineHue, object, text, hostInput } from '../remote/validation';

export function editInput(value: unknown, remote: boolean): MachineEditInput {
  const input = object(value, remote ? ['name', 'hue', 'host', 'user', 'port', 'identityFile'] : ['name', 'hue']);
  const appearance = { name: text(input['name'], 160).trim(), hue: machineHue(input['hue']) };
  if (!remote) return appearance;
  const host = hostInput({ ...appearance, host: input['host'], user: input['user'], port: input['port'], identityFile: input['identityFile'] ?? undefined });
  return { ...host, ...appearance, ...(input['identityFile'] === null ? { identityFile: null } : {}) };
}
