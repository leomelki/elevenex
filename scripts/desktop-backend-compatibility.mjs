import { execFile } from 'node:child_process';
import { open, opendir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const baseline = { GLIBC: [2, 28], GLIBCXX: [3, 4, 25], CXXABI: [1, 3, 11] };
const newer = (version, limit) => {
  for (let index = 0; index < Math.max(version.length, limit.length); index++) {
    if ((version[index] ?? 0) !== (limit[index] ?? 0)) return (version[index] ?? 0) > (limit[index] ?? 0);
  }
  return false;
};

/** Inspect version requirements, not exported symbols or arbitrary strings. */
export async function verifyLinuxCompatibility(root, signal, inspect = async path => {
  const { stdout } = await execute('readelf', ['--version-info', '--', path], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, signal, env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout;
}) {
  async function visit(directory) {
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) continue;
      const file = await open(path, 'r');
      const magic = Buffer.alloc(4);
      try { await file.read(magic, 0, 4, 0); } finally { await file.close(); }
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
      const requirements = (await inspect(path)).split(/Version needs section/)[1] ?? '';
      for (const match of requirements.matchAll(/Name:\s+(GLIBCXX|GLIBC|CXXABI)_([\w.]+)/g)) {
        const [, library, version] = match;
        if (!/^\d+(?:\.\d+)*$/.test(version) || newer(version.split('.').map(Number), baseline[library])) {
          throw new Error(`Linux runtime ${relative(root, path)} requires ${library}_${version}; portable baseline is ${library}_${baseline[library].join('.')}. Rebuild native dependencies in the portable Linux builder.`);
        }
      }
    }
  }
  await visit(root);
}
