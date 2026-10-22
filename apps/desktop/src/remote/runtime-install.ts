import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import type { BackendRelease } from '../backend/release';
import { downloadBackend, type DownloadProgress } from '../backend/download';
import { extractBackend } from '../backend/archive';
import { failure } from './failure';
import { shellQuote } from './ssh';

export async function archiveFor(root: string, release: BackendRelease, signal: AbortSignal, progress: (value: DownloadProgress) => void): Promise<{ path: string; digest: string; bytes: number }> {
  const cache = join(root, 'remote-archives');
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const path = join(cache, `${release.tag}-${release.target}.tar.gz`);
  try {
    const digest = await readFile(`${path}.sha256`, 'utf8');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(path, { signal })) hash.update(bytes);
    if (/^[a-f0-9]{64}$/.test(digest) && hash.digest('hex') === digest) return { path, digest, bytes: (await stat(path)).size };
  } catch { signal.throwIfAborted(); }
  const staging = await mkdtemp(join(cache, '.download-'));
  try {
    const archive = join(staging, 'runtime.tar.gz');
    const digest = await downloadBackend(release, archive, signal, progress);
    // Reuse the local installer's path/type/size validation before remote tar
    // ever sees these bytes. The publisher's archives contain no symlinks.
    await extractBackend(archive, join(staging, 'verified'), signal);
    signal.throwIfAborted();
    await rename(archive, path);
    const marker = join(staging, 'sha256');
    await writeFile(marker, digest, { mode: 0o600 });
    await rename(marker, `${path}.sha256`);
    return { path, digest, bytes: (await stat(path)).size };
  } catch (error) {
    signal.throwIfAborted();
    const message = error instanceof Error ? error.message : '';
    if (/HTTP (404|403|401)/.test(message)) throw failure('download', 'compatibility', `The backend runtime for ${release.target} is not available for this desktop revision. Use a desktop release with a published matching runtime.`, 'edit');
    if (/checksum|archive|PAX|tar|expanded|unsafe|traversal/i.test(message)) throw failure('download', 'compatibility', 'The runtime archive failed validation. No remote installation was changed. Check the published release before retrying.', 'edit');
    throw error;
  } finally { await rm(staging, { recursive: true, force: true, maxRetries: 3 }); }
}

/** All script substitutions are application-owned revisions, source and nonces. */
export async function bootstrapScript(release: BackendRelease, nonce: string): Promise<string> {
  const modules = ['wire', 'runtime', 'host', 'process-tree'];
  const sources = await Promise.all(modules.map(name => readFile(join(__dirname, name === 'host' || name === 'process-tree' ? `../backend/${name}.js` : `${name}.js`), 'utf8')));
  const clientId = createHash('sha256').update(sources.join('\n')).digest('hex');
  const script = `set -eu
umask 077
unset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE
fail() { printf 'EX11_%s: %s\\n' "$1" "$2" >&2; exit 1; }
for tool in uname git tar head mktemp; do command -v "$tool" >/dev/null 2>&1 || fail COMPATIBILITY "Install $tool on the remote PATH"; done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail COMPATIBILITY 'Install sha256sum or shasum'
case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) fail COMPATIBILITY 'This remote platform is unsupported; use Linux or macOS';; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) fail COMPATIBILITY 'Use an x64 or arm64 remote host';; esac
root="$HOME/.elevenex/desktop-remote"
mkdir -p "$root/runtimes" "$root/clients"
case "$os" in darwin) target=macos-$arch;; *) target=linux-$arch;; esac
cache="$root/runtimes/${release.tag}-$target"
printf '\\nEX11:${nonce}:platform:%s:%s\\n' "$os" "$arch"
stage=''
cleanup() { if [ -n "$stage" ]; then rm -rf "$stage"; fi; }
trap cleanup EXIT HUP INT TERM
if [ -x "$cache/backend/node/bin/node" ] && [ -s "$cache/backend/main.cjs" ] && [ -s "$cache/installation.sha256" ]; then
  printf 'EX11:${nonce}:cache:yes\\n'
else
  printf 'EX11:${nonce}:cache:no\\n'
  read -r size digest
  case "$size" in ''|*[!0-9]*) fail CONFIGURATION 'Invalid archive size';; esac
  [ "$size" -gt 0 ] && [ "$size" -le 1073741824 ] || fail CONFIGURATION 'Invalid archive size'
  [ "\${#digest}" -eq 64 ] || fail CONFIGURATION 'Invalid checksum'
  case "$digest" in *[!a-f0-9]*) fail CONFIGURATION 'Invalid checksum';; esac
  stage=$(mktemp -d "$root/runtimes/.install-XXXXXXXX")
  head -c "$size" > "$stage/archive.tar.gz"
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/archive.tar.gz");
  elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$stage/archive.tar.gz");
  else fail COMPATIBILITY 'Install sha256sum or shasum'; fi
  [ "\${actual%% *}" = "$digest" ] || fail CONFIGURATION 'Transferred runtime checksum mismatch'
  tar -xzf "$stage/archive.tar.gz" -C "$stage" || fail COMPATIBILITY 'Runtime extraction failed; check disk space and tar support'
  rm "$stage/archive.tar.gz"
  "$stage/backend/node/bin/node" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || fail COMPATIBILITY 'Bundled Node cannot run on this host; check OS and libc compatibility'
  printf '%s' "$digest" > "$stage/installation.sha256"
  "$stage/backend/node/bin/node" -e 'const fs=require("fs");try{fs.renameSync(process.argv[1],process.argv[2])}catch(e){if(!["EEXIST","ENOTEMPTY"].includes(e.code))throw e;if(!fs.existsSync(process.argv[2]+"/installation.sha256"))throw Error("Damaged runtime cache; move it aside before retrying")}' "$stage" "$cache" || fail CONFIGURATION 'Cannot publish runtime; check permissions or move the damaged version cache aside'
  cleanup
  stage=''
fi
client="$root/clients/${clientId}"
mkdir -p "$client"
${sources.map((source, index) => `cat > "$client/${modules[index]}.${nonce}.tmp" <<'EX11_SOURCE_${nonce}'\n${source}\nEX11_SOURCE_${nonce}\nmv "$client/${modules[index]}.${nonce}.tmp" "$client/${modules[index]}.js"`).join('\n')}
printf 'EX11:${nonce}:runtime:start\\n'
"$cache/backend/node/bin/node" --version >/dev/null 2>&1 || fail COMPATIBILITY 'The cached Node executable is incompatible or damaged; check OS and libc support'
exec "$cache/backend/node/bin/node" "$client/runtime.js" bridge "$root" "$cache" '${release.version}'
`;
  // Keep Windows CreateProcess and remote shell argv well below their limits.
  // The bootstrap reads its script from a file, leaving stdin entirely for the
  // archive transfer and subsequent wire protocol (sh -s would consume it).
  const packed = await new Promise<Buffer>((resolve, reject) => gzip(script, (error, bytes) => error ? reject(error) : resolve(bytes)));
  const loader = `set -eu
umask 077
for tool in base64 gzip mktemp; do command -v "$tool" >/dev/null 2>&1 || { printf 'EX11_COMPATIBILITY: Install %s\\n' "$tool" >&2; exit 1; }; done
packed=$(mktemp)
script=$(mktemp)
trap 'rm -f "$packed" "$script"' EXIT HUP INT TERM
if printf '%s' '${packed.toString('base64')}' | base64 -d > "$packed" 2>/dev/null; then :;
else printf '%s' '${packed.toString('base64')}' | base64 -D > "$packed"; fi
gzip -dc "$packed" > "$script"
rm -f "$packed"
sh "$script"
`;
  return `sh -c ${shellQuote(loader)}`;
}

