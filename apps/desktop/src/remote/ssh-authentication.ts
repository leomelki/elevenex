/**
 * Login progress reported by the OpenSSH client with `-v`.
 *
 * `key-accepted` means the server accepted a public key and the client is
 * finishing that login. A long wait here is usually a signature waiting on a
 * person or device (an agent that confirms each use such as 1Password, a
 * security-key touch, a smart-card PIN). Occasionally it is a slow server-side
 * account check, so callers must not present it as certain.
 */
export type SshAuthentication = 'connecting' | 'authenticating' | 'key-accepted' | 'authenticated';

// Client messages that are stable across OpenSSH 8.7+ and Win32-OpenSSH, which
// the app requires for its session options. They are not localized; unknown
// output only means that no progress is reported.
function progress(line: string): SshAuthentication | undefined {
  if (line.startsWith('Authenticated to ')) return 'authenticated';
  if (!line.startsWith('debug1: ')) return undefined;
  const message = line.slice(8);
  if (message.startsWith('Server accepts key: ')) return 'key-accepted';
  if (message.startsWith('Authentication succeeded ') || message.startsWith('mux_client_request_session: master session id')) return 'authenticated';
  if (/^(?:Authenticating to |Offering public key: |Trying private key: |Next authentication method: |Authentications that can continue: )/.test(message)) return 'authenticating';
  return undefined;
}
// Output added by `-v` itself. Removing it keeps error classification identical
// to a client without `-v`, including when ssh_config sets LogLevel QUIET.
const verbose = /^(?:debug[123]: |OpenSSH_\S+[, ]|Authenticated to |Transferred: sent |Bytes per second: sent )/;
// A line this long is not client progress; pass it through instead of buffering it.
const MAXIMUM_PARTIAL_LINE = 4096;

/** Splits SSH stderr into login progress and diagnostic text. */
export class SshStderr {
  private partial = '';
  private current: SshAuthentication = 'connecting';
  constructor(private readonly changed: (state: SshAuthentication) => void = () => undefined) {}
  get authentication(): SshAuthentication { return this.current; }

  /** Returns the diagnostic text in this chunk; a trailing partial line waits for its end. */
  write(text: string): string {
    const lines = (this.partial + text).split('\n');
    this.partial = lines.pop() ?? '';
    let kept = '';
    for (const line of lines) kept += this.line(line);
    if (this.partial.length > MAXIMUM_PARTIAL_LINE) { kept += this.partial; this.partial = ''; }
    return kept;
  }
  end(): string { const rest = this.partial; this.partial = ''; return rest ? this.line(rest).slice(0, -1) : ''; }

  private line(raw: string): string {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const next = progress(line);
    if (next && next !== this.current) { this.current = next; this.changed(next); }
    return verbose.test(line) ? '' : `${raw}\n`;
  }
}
