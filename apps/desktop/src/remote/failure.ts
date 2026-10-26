import type { RemoteFailure, RemoteStage } from '@elevenex/shared';

export class RemoteError extends Error {
  constructor(readonly failure: RemoteFailure) { super(failure.message); }
}
export function failure(stage: RemoteStage, code: RemoteFailure['code'], message: string, action: RemoteFailure['action'], transient = false): RemoteError {
  return new RemoteError({ stage, code, message, action, transient });
}
/** Raw SSH/remote output is classified in memory and never returned or persisted. */
export function sshFailure(stderr: string, stage: RemoteStage): RemoteError {
  if (/Could not resolve hostname.*(?:Temporary failure|Try again)/i.test(stderr)) return failure(stage, 'unavailable', 'Name resolution is temporarily unavailable. Check network access; recovery will retry automatically.', 'retry', true);
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|REVOKED HOST KEY|Host key verification failed/i.test(stderr)) {
    return failure('authentication', 'host-trust', 'SSH could not verify this host. Verify its fingerprint with the administrator and repair known_hosts before retrying.', 'verify-host');
  }
  if (/no matching (?:key exchange method|host key type|cipher|MAC) found|Bad server host key: Invalid key length|no mutual signature algorithm/i.test(stderr)) {
    return failure('authentication', 'compatibility', 'The SSH client and server do not support compatible secure algorithms. Update OpenSSH or the server configuration before retrying.', 'edit');
  }
  if (/account (?:has )?(?:expired|is locked)|password (?:has )?expired|required to change your password|password change required|This account is currently not available/i.test(stderr)) {
    return failure('authentication', 'authentication', 'The SSH account requires attention. Connect in a terminal to resolve account or password restrictions, then retry.', 'authenticate');
  }
  if (/bind .*?(?:Address already in use|Permission denied)|Could not request (?:local |remote |tunnel )?forwarding|remote port forwarding failed|cannot listen to port|Bad (?:local|remote|dynamic) forwarding specification/i.test(stderr)) {
    return failure(stage, 'configuration', 'A forwarding requested by SSH config could not start. Check configured listener ports, permissions and server forwarding policy, then retry.', 'edit');
  }
  if (/Permission denied|authentication failed|Too many authentication failures|sign_and_send_pubkey|askpass/i.test(stderr)) {
    return failure('authentication', 'authentication', 'SSH authentication requires attention. Check the user, identity and agent, then choose Retry now.', 'authenticate');
  }
  if (/(?:shell|exec) request failed on channel|This service allows sftp connections only/i.test(stderr)) {
    return failure(stage, 'configuration', 'The SSH server does not permit the remote commands required for setup. Enable shell command execution for this account before retrying.', 'edit');
  }
  if (/Invalid IdentityAgent environment variable|env var .* has no value/i.test(stderr)) {
    return failure(stage, 'configuration', 'An SSH configuration environment variable is invalid or unavailable to the desktop app. Check IdentityAgent and environment references in SSH config.', 'edit');
  }
  if (/Bad configuration|Bad owner or permissions|bad permissions|no such identity|Could not resolve hostname|unknown option|Bad .*option|command not found|ENOENT|EACCES|EPERM|ENOSPC|Load key|Is a directory|can't open user config file|invalid format/i.test(stderr)) {
    return failure(stage, 'configuration', 'SSH configuration or a required local executable is unavailable. Check the host, SSH config and identity paths.', 'edit');
  }
  return failure(stage, 'unavailable', 'The SSH connection was lost or could not be established. Check network access and the remote SSH service.', 'retry', true);
}
export function asFailure(error: unknown, stage: RemoteStage): RemoteFailure {
  if (error instanceof RemoteError) return error.failure;
  // Do not expose unexpected errors: they can contain credentials, config commands or URLs.
  return failure(stage, 'unavailable', 'The remote operation did not complete. Check the connection and retry.', 'retry', true).failure;
}
