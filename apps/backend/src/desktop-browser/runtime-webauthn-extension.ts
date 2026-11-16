import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** No content scripts, host permissions, messaging or network access. Only Chromium
 * can supply ceremonies; page JS cannot impersonate another origin at this boundary. */
export async function prepareWebAuthnExtension(root: string): Promise<string> {
  const directory = join(root, 'webauthn-proxy-v1');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Elevenex WebAuthn relay',
      version: '1.0',
      permissions: ['webAuthenticationProxy'],
      content_security_policy: {
        extension_pages:
          "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'none'; object-src 'none'",
      },
      background: { service_worker: 'relay.js' },
    }),
    { mode: 0o600 },
  );
  await writeFile(join(directory, 'relay.js'), webAuthnRelay, { mode: 0o600 });
  return directory;
}

// Kept as a standalone source string so compiled and bundled backends ship the
// exact same extension without an external asset/install or extension store.
export const webAuthnRelay = `
const api = chrome.webAuthenticationProxy;
const pending = new Map();
let enabled = false;
let platform = false;
const denied = {name:'NotAllowedError', message:'Authentication was canceled or is unavailable.'};
async function complete(requestId, response) {
  const item = pending.get(requestId);
  if (!item) return;
  pending.delete(requestId);
  clearTimeout(item.timer);
  const method = item.operation === 'create' ? 'completeCreateRequest' : 'completeGetRequest';
  try { await api[method]({requestId, ...response}); }
  catch { if (!response.error) await api[method]({requestId, error:denied}).catch(() => {}); }
}
function receive(operation, request) {
  if (!enabled || pending.size >= 1 || request.requestDetailsJson.length > 65536) {
    void api[operation === 'create' ? 'completeCreateRequest' : 'completeGetRequest']({requestId:request.requestId, error:denied}).catch(() => {});
    return;
  }
  const timer = setTimeout(() => void complete(request.requestId, {error:denied}), 120000);
  pending.set(request.requestId, {operation, optionsJson:request.requestDetailsJson, timer});
}
api.onCreateRequest.addListener(request => receive('create', request));
api.onGetRequest.addListener(request => receive('get', request));
api.onIsUvpaaRequest.addListener(request => void api.completeIsUvpaaRequest({requestId:request.requestId, isUvpaa:enabled && platform}).catch(() => {}));
api.onRequestCanceled.addListener(requestId => { const item = pending.get(requestId); if (item) clearTimeout(item.timer); pending.delete(requestId); });
globalThis.elevenexWebAuthn = {
  ready: false,
  async configure(value) {
    enabled = value.enabled; platform = value.platform;
    if (!enabled) await Promise.all([...pending.keys()].map(id => complete(id, {error:denied})));
  },
  snapshot() { return [...pending].map(([requestId, item]) => ({requestId, operation:item.operation, optionsJson:item.optionsJson})); },
  complete,
};
api.attach().then(error => { globalThis.elevenexWebAuthn.ready = !error; }).catch(() => {});
`;
