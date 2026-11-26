/**
 * Login progress reported by the OpenSSH client with `-v`.
 *
 * `awaiting-approval` means the server accepted a public key and the client is
 * waiting for its signature. That is where agents which confirm each use
 * (1Password, Secretive, `ssh-add -c`, KeePassXC and others), security-key
 * touches and smart-card PINs block, often in a window the app cannot see.
 */
export type SshAuthentication = 'connecting' | 'authenticating' | 'awaiting-approval' | 'authenticated';

// These client messages have been stable across OpenSSH and Win32-OpenSSH
// releases. Unknown or localized output only means no progress is reported.
const progress: readonly (readonly [RegExp, SshAuthentication])[] = [
  [/^debug1: Server accepts key: /, 'awaiting-approval'],
  [/^(?:Authenticated to |debug1: Authentication succeeded |debug1: mux_client_request_session: master session id)/, 'authenticated'],
  [/^debug1: (?:Authenticating to |Offering public key: |Trying private key: |Next authentication method: |Authentications that can continue: )/, 'authenticating'],
];
// Output added by `-v` itself. Keeping it out of the diagnostics preserves the
// error classification of the output OpenSSH prints without `-v`.
const verbose = /^(?:debug[123]: |OpenSSH_\S+[, ]|Authenticated to |Transferred: sent |Bytes per second: sent )/;

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
    // A line without an end is never verbose client output; do not hold it unbounded.
    let kept = '';
    if (this.partial.length > 4096) { kept = this.partial; this.partial = ''; }
    return lines.map(line => this.line(line)).join('') + kept;
  }
  end(): string { const rest = this.partial; this.partial = ''; return rest ? this.line(rest).replace(/\n$/, '') : ''; }

  private line(raw: string): string {
    const line = raw.replace(/\r$/, '');
    const next = progress.find(([pattern]) => pattern.test(line))?.[1];
    if (next && next !== this.current) { this.current = next; this.changed(next); }
    return verbose.test(line) ? '' : `${raw}\n`;
  }
}
