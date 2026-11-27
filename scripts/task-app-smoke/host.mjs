import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { backend, backendRequire, desktop, desktopRequire, exec, root, startProcess, testEnvironment, until, unusedPort } from './common.mjs';
import { startDelayRelay } from './relay.mjs';

async function stageBackend(remoteRoot) {
  const { readBackendRelease } = desktopRequire('./dist/backend/release');
  const { remoteClientSources } = desktopRequire('./dist/remote/runtime-sources');
  const release = await readBackendRelease(join(desktop, 'dist'));
  const installation = join(remoteRoot, 'runtimes', release.tag + '-' + release.target);
  const runtimeRoot = join(installation, 'backend');
  await mkdir(join(runtimeRoot, 'node/bin'), { recursive: true });
  const files = {
    'main.cjs': join(backend, 'bundle/main.cjs'),
    'node/bin/node': process.execPath,
    node_modules: join(backend, 'node_modules'),
    drizzle: join(backend, 'drizzle'),
    bin: join(backend, 'bundle/bin'),
    'proxy.conf.json': join(root, 'apps/frontend/proxy.conf.json'),
  };
  for (const [name, path] of Object.entries(files)) {
    await access(path);
    await symlink(path, join(runtimeRoot, name));
  }
  // The staging fixture is checkout-built. Distribution/download verification
  // has its own release tests. The real SSH bootstrap recognizes this cache.
  await writeFile(join(installation, 'installation.sha256'), 'checkout-built fixture');
  const { clientId, modules, sources } = await remoteClientSources();
  const client = join(remoteRoot, 'clients', clientId);
  for (const [i, name] of modules.entries()) {
    const destination = join(client, name + '.js');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, sources[i]);
  }
  return { release, installation, daemon: join(client, 'runtime.js') };
}

async function seedTask(home, remoteRoot, checkout, signal) {
  const git = { env: testEnvironment(home), signal };
  await mkdir(checkout);
  await exec('git', ['init', '-q', '--initial-branch=main', checkout], git);
  await exec('git', ['-C', checkout, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--allow-empty', '-qm', 'Initial'], git);
  await copyFile(new URL('electron-fixture.cjs', import.meta.url), join(checkout, 'main.cjs'));
  const token = 'evx_' + randomBytes(24).toString('base64url');
  const schema = backendRequire('./dist/database/schema/index.js');
  await mkdir(join(remoteRoot, 'data'), { recursive: true });
  const Database = backendRequire('better-sqlite3');
  const sqlite = new Database(join(remoteRoot, 'data/elevenex.db'));
  try {
    const db = backendRequire('drizzle-orm/better-sqlite3').drizzle(sqlite, { schema });
    backendRequire('drizzle-orm/better-sqlite3/migrator').migrate(db, { migrationsFolder: join(backend, 'drizzle') });
    const [project] = db.insert(schema.projects).values({ name: 'App smoke' }).returning().all();
    const [repository] = db.insert(schema.repos).values({ projectId: project.id, name: 'Fixture', path: checkout }).returning().all();
    const [task] = db.insert(schema.workspaces).values({ repoId: repository.id, name: 'App smoke', path: checkout, taskBranch: 'main' }).returning().all();
    const [session] = db.insert(schema.sessions).values({
      repoId: repository.id, workspaceId: task.id, name: 'Show app', branchName: 'main',
      worktreePath: checkout, mcpAgentToken: token, activeAgentProvider: 'codex', planMode: false,
    }).returning().all();
    return { projectId: project.id, taskId: task.id, sessionId: session.id, token };
  } finally { sqlite.close(); }
}

async function requestApp(socketPath, token, checkout, signal) {
  let sessionId;
  async function rpc(message) {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath, path: '/api/mcp', method: 'POST', signal,
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      }, res => {
        sessionId = res.headers['mcp-session-id'] ?? sessionId;
        let body = '';
        res.setEncoding('utf8').on('data', chunk => {
          body += chunk;
          if (body.length > 65536) req.destroy(new Error('Oversized MCP reply'));
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            assert.ok(res.statusCode < 300, 'MCP HTTP ' + res.statusCode);
            const data = body.split('\n').find(line => line.startsWith('data: '));
            resolve(data ? JSON.parse(data.slice(6)) : body ? JSON.parse(body) : {});
          } catch (error) { reject(error); }
        });
      });
      req.once('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', ...message }));
    });
  }
  await rpc({ id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'task-app-smoke', version: '1' },
  } });
  await rpc({ method: 'notifications/initialized' });
  const { result, error } = await rpc({ id: 2, method: 'tools/call', params: { name: 'start_app', arguments: {
    requestId: randomUUID(), name: 'Electron smoke', executable: desktopRequire('electron'), args: [join(checkout, 'main.cjs')],
  } } });
  assert.ok(result && !error && !result.isError, 'start_app failed: ' + JSON.stringify(error ?? result?.content ?? null).slice(0, 1024));
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  const run = value.data?.run ?? value.run;
  assert.equal(run?.status, 'requested', 'The restricted session must request launch approval');
  return run;
}

async function sshHost(directory, home, { rttMs, kbps }, signal, cleanup) {
  const port = await unusedPort();
  const relay = rttMs || kbps ? await startDelayRelay(port, rttMs, kbps) : undefined;
  if (relay) cleanup.push(() => relay.close());
  const clientPort = relay?.port ?? port;
  for (const name of ['host-key', 'client-key']) {
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(directory, name)], { signal });
  }
  const hostKey = (await readFile(join(directory, 'host-key.pub'), 'utf8')).trim();
  const knownHosts = join(directory, 'known-hosts');
  await writeFile(knownHosts, '[127.0.0.1]:' + clientPort + ' ' + hostKey + '\n');
  const configFile = join(directory, 'ssh-config');
  const user = userInfo().username;
  await writeFile(configFile, [
    'Host app-smoke', ' HostName 127.0.0.1', ' Port ' + clientPort, ' User ' + user,
    ' IdentitiesOnly yes', ' IdentityAgent none', ' IdentityFile ' + join(directory, 'client-key'),
    ' UserKnownHostsFile ' + knownHosts, ' StrictHostKeyChecking yes', '',
  ].join('\n'));
  const daemonConfig = join(directory, 'sshd-config');
  await writeFile(daemonConfig, [
    'Port ' + port, 'ListenAddress 127.0.0.1', 'HostKey ' + join(directory, 'host-key'),
    'PidFile ' + join(directory, 'sshd.pid'), 'AuthorizedKeysFile ' + join(directory, 'client-key.pub'),
    'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'AllowUsers ' + user, 'SetEnv HOME=' + home, '',
  ].join('\n'));
  const daemon = startProcess(process.env.SSHD ?? '/usr/sbin/sshd', ['-D', '-e', '-f', daemonConfig], { env: testEnvironment(home) });
  cleanup.push(() => daemon.stop());
  await until('starting the disposable SSH server', () => {
    daemon.assertAlive();
    return daemon.diagnostics().includes('Server listening');
  }, signal);
  return { id: randomUUID(), name: 'App smoke', host: 'app-smoke', configFile };
}

export async function startTaskHost(directory, link, signal, cleanup) {
  const home = join(directory, 'server');
  const checkout = join(directory, 'checkout');
  const remoteRoot = join(home, '.elevenex/desktop-remote');
  const { release, installation, daemon } = await stageBackend(remoteRoot);
  const { projectId, taskId, sessionId, token } = await seedTask(home, remoteRoot, checkout, signal);
  const host = await sshHost(directory, home, link, signal, cleanup);
  // Start and own the real managed daemon ourselves. Its teardown stops the
  // backend and its entire task process tree even after an interrupted test.
  const child = startProcess(process.execPath, [daemon, 'daemon', remoteRoot, installation, release.version], { env: testEnvironment(home) });
  cleanup.push(() => child.stop());
  const { queryDaemon, backendSocketPath } = desktopRequire('./dist/remote/runtime-control');
  const readySignal = AbortSignal.any([signal, AbortSignal.timeout(35000)]);
  const health = await until('starting the matching checkout-built backend', async () => {
    child.assertAlive();
    try {
      const key = await readFile(join(remoteRoot, 'control-token'), 'utf8');
      const reply = await queryDaemon(remoteRoot, 1, key);
      return reply.ready && reply.version === release.version && reply;
    } catch { return false; }
  }, readySignal).catch(error => {
    throw new Error('The fixture backend did not become ready. ' + child.diagnostics(), { cause: error });
  });
  const run = await requestApp(backendSocketPath(remoteRoot, health), token, checkout, signal);
  assert.equal(run.taskId, taskId);
  console.log('Restricted MCP session requested launch approval');
  return { host, projectId, taskId, sessionId, runId: run.runId };
}
