import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** --linux selects the SSH backend target, never the local Electron platform. */
export function developmentLinuxArchitecture(args) {
  if (args.length === 0) return undefined;
  if (!args.includes('--linux') || args.some(arg => !['--linux', '--arm64', '--x64'].includes(arg))
    || new Set(args).size !== args.length || (args.includes('--arm64') && args.includes('--x64'))) {
    throw new Error('Use pnpm desktop:dev [--linux [--arm64 | --x64]]');
  }
  return args.includes('--x64') ? 'x64' : 'arm64';
}

/** Send only manifests and runtime inputs to Docker; never mount checkout dependencies. */
export async function buildLinuxDevelopmentRuntime(root, version, architecture, runCommand) {
  if (!['arm64', 'x64'].includes(architecture) || !/^[a-f0-9]{40}$/.test(version)) {
    throw new Error('Invalid Linux development build target or revision');
  }
  const staging = join(root, 'apps/desktop/.stage');
  await mkdir(staging, { recursive: true });
  const context = await mkdtemp(join(staging, 'linux-build-'));
  const copy = async (source, destination) => {
    await mkdir(dirname(join(context, destination)), { recursive: true });
    await cp(join(root, source), join(context, destination), { recursive: true, dereference: true });
  };
  try {
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await copy(file, `manifests/${file}`);
    await copy('apps/backend/package.json', 'manifests/apps/backend/package.json');
    // JS is already bundled on the Mac. Installing the entire backend again
    // would also download unused agent CLIs and image/ML dependencies.
    const backendManifest = JSON.parse(await readFile(join(root, 'apps/backend/package.json'), 'utf8'));
    const browserRuntime = typeof backendManifest.dependencies['playwright-core'] === 'string';
    const runtimeDependencies = ['better-sqlite3', 'node-pty', '@vscode/ripgrep', 'onnxruntime-node',
      ...(browserRuntime ? ['playwright-core', 'ffmpeg-static'] : [])];
    const dependencies = Object.fromEntries(runtimeDependencies.map(name => {
      const specifier = backendManifest.dependencies[name];
      if (typeof specifier !== 'string') throw new Error(`Missing backend runtime dependency: ${name}`);
      return [name, specifier];
    }));
    await writeFile(join(context, 'manifests/apps/backend/package.json'), `${JSON.stringify({ name: backendManifest.name, private: true, dependencies })}\n`);
    // pnpm 8's generated v6 lockfile has a fixed importer indentation. Retain
    // the original dependency entries and entire package graph verbatim: a new
    // resolution here could silently upgrade transitive runtime dependencies.
    const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
    const importer = /^ {2}apps\/backend:\n(?: {4,}.*\n|\n)*/m.exec(lockfile)?.[0];
    if (!/^lockfileVersion: '6\.0'$/m.test(lockfile) || !importer) throw new Error('Expected the pinned pnpm 8 lockfile format');
    const entries = runtimeDependencies.map(name => {
      const entry = new RegExp(`^      (?:${name}|'${name}'):\\n(?: {8,}.*\\n)+`, 'm').exec(importer)?.[0];
      if (!entry) throw new Error(`Missing locked runtime dependency: ${name}`);
      return entry;
    });
    await writeFile(join(context, 'manifests/pnpm-lock.yaml'), lockfile.replace(importer, `  apps/backend:\n    dependencies:\n${entries.join('')}\n`));
    const { packageManager } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) throw new Error('Expected an exact pnpm version in packageManager');
    for (const file of [
      'apps/backend/bundle', 'apps/backend/drizzle', 'apps/backend/bin', 'apps/frontend/proxy.conf.json',
      'scripts/desktop-backend-runtime.mjs',
      'scripts/stage-electron-backend.js', 'scripts/rebuild-electron-backend-natives.js',
      'scripts/archive-electron-backend.js',
      ...(browserRuntime ? ['scripts/prepare-vscode-web-runtime.js', 'config/vscode-web-runtime.json',
        'apps/backend/node_modules/vscode-web/dist'] : ['scripts/runtime-stage-utils.js']),
      'apps/backend/node_modules/@openai/codex-sdk/package.json', 'apps/backend/node_modules/@openai/codex-sdk/dist',
      'apps/backend/node_modules/@openai/codex-sdk/LICENSE', 'apps/backend/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ]) await copy(file, `runtime/${file}`);
    for (const family of browserRuntime ? ['vscode-filesystem-provider', 'vscode-scm-extension'] : []) {
      await copy(`${family}/package.json`, `runtime/${family}/package.json`);
      await copy(`${family}/dist`, `runtime/${family}/dist`);
      try { await copy(`${family}/package.nls.json`, `runtime/${family}/package.nls.json`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await copy('scripts/desktop-backend-linux.Dockerfile', 'Dockerfile');
    console.log(`Building the SSH Linux ${architecture} runtime with Docker (dependencies are cached)…`);
    try {
      await runCommand('docker', ['buildx', 'build', '--progress', 'plain', '--platform', `linux/${architecture === 'x64' ? 'amd64' : architecture}`,
        '--build-arg', `NODE_VERSION=${process.versions.node}`, '--build-arg', `PNPM_VERSION=${packageManager.slice(5)}`,
        '--build-arg', `DEVELOPMENT_VERSION=${version}`, '--output', 'type=local,dest=output', '.'], context);
    } catch (error) {
      throw new Error(`Linux development runtime build failed. Ensure Docker Desktop or OrbStack is running with Linux ${architecture} support; see Docker output above.`, { cause: error });
    }
    const archiveName = `elevenex-backend-linux-${architecture}.tar.gz`;
    const output = join(root, 'dist-runtime');
    await mkdir(output, { recursive: true });
    for (const file of [archiveName, `${archiveName}.sha256`]) await rename(join(context, 'output', file), join(output, file));
    return join(output, archiveName);
  } finally {
    await rm(context, { recursive: true, force: true, maxRetries: 3 });
  }
}
