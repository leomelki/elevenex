export const help = `Native Electron UI captures (no browser installation or new dependencies).

pnpm desktop:capture [scenario.mjs | -] [options]
pnpm desktop:capture:serve [--fixture] [--port 4310]

Scenarios are async generators: export default async function* (capture) { yield 'ready'; }
Omit the scenario to read JavaScript from stdin. Use a quoted heredoc.

--out <directory>       Empty output directory (default: unique artifacts/desktop-capture run)
--url <loopback URL>    Reuse an Angular dev server; never stop it
--built                Use the built app:// renderer, without a dev server
--fixture              Use the isolated Angular verification fixture, not the product shell
--width <pixels>       Content viewport (default 1440, range 320..4096)
--height <pixels>      Content viewport (default 960, range 240..4096)
--theme light|dark     Initial native theme (default light)
--reduced-motion      Emulate prefers-reduced-motion: reduce
--timeout <seconds>    Entire run deadline (default 120, max 600)
--port <port>          Owned Angular server port (default: available loopback port)
--serve               Keep only Angular running for fast subsequent --url captures
--help                 Show this help

Outputs: numbered PNGs, inspectable snapshots, index.html and report.json.
See scripts/desktop-capture/README.md for state access, input and motion.`;

export function parseOptions(args) {
  const options = { width: 1440, height: 960, theme: 'light', timeout: 120 };
  const flags = new Map([['--fixture', 'fixture'], ['--built', 'built'], ['--reduced-motion', 'reducedMotion'], ['--serve', 'serve']]);
  const values = new Set(['out', 'url', 'width', 'height', 'theme', 'timeout', 'port']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--') continue; // pnpm also accepts an optional separator.
    if (flags.has(arg)) { options[flags.get(arg)] = true; continue; }
    if (!arg.startsWith('-') || arg === '-') {
      if (options.scenario !== undefined) throw new Error('Choose one scenario module');
      options.scenario = arg;
      continue;
    }
    const key = arg.slice(2);
    if (!values.has(key) || args[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = args[++i];
    options[key] = ['width', 'height', 'timeout', 'port'].includes(key) ? Number(value) : value;
  }
  for (const [key, min, max] of [['width', 320, 4096], ['height', 240, 4096], ['timeout', 1, 600], ['port', 1024, 65535]]) {
    if (options[key] !== undefined && (!Number.isInteger(options[key]) || options[key] < min || options[key] > max)) throw new Error(`Invalid ${key}: ${min}..${max}`);
  }
  if (!['light', 'dark'].includes(options.theme)) throw new Error('Theme must be light or dark');
  if (options.url) {
    const url = new URL(options.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash) throw new Error('--url must be loopback HTTP at 127.0.0.1');
  }
  if (options.built && (options.url || options.fixture || options.serve)) throw new Error('--built cannot be combined with --url, --fixture or --serve');
  if (options.serve && (options.url || options.scenario)) throw new Error('--serve starts Angular only; omit --url and scenario');
  if (options.url && options.port) throw new Error('--port is only for an owned server');
  return options;
}

export function checkpoint(value, names) {
  const point = typeof value === 'string' ? { name: value } : value;
  if (!point || typeof point !== 'object' || Array.isArray(point)
    || Object.keys(point).some(key => !['name', 'selector', 'inspect', 'metadata'].includes(key))
    || typeof point.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(point.name)) {
    throw new Error('Yield a unique name or {name, selector?, inspect?: string[], metadata?}');
  }
  if (names.has(point.name)) throw new Error(`Duplicate checkpoint: ${point.name}`);
  if (point.selector !== undefined && (typeof point.selector !== 'string' || !point.selector)) throw new Error('selector must be nonempty CSS');
  if (point.inspect !== undefined && (!Array.isArray(point.inspect) || point.inspect.length > 100 || point.inspect.some(s => typeof s !== 'string' || !s))) throw new Error('inspect must contain up to 100 CSS selectors');
  if (JSON.stringify(point.metadata ?? null).length > 65536) throw new Error('Checkpoint metadata exceeds 64 KiB');
  names.add(point.name);
  return point;
}
