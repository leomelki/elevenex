import { spawn } from 'node:child_process';

/** Only signal groups created by our supervisor; never trust a PID from disk. */
export async function signalBackendTree(pid: number, force: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
    return;
  }
  // taskkill without /F gives console processes a chance to shut down first.
  await new Promise<void>((resolve, reject) => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}
