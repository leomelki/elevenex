import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { signalBackendTree } from '../backend/process-tree';
import { failure } from './failure';

// Win32 OpenSSH executes an .exe for SSH_ASKPASS. A .cmd wrapper both depends on
// undocumented shell handling and can interpret metacharacters in a prompt.
// Compile this fixed, credential-free launcher with Windows' built-in .NET
// compiler instead. Credentials go directly between the broker and stdout.
const source = `param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -OutputAssembly $OutputPath -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Text;
public static class ElevenexAskpass {
  public static int Main(string[] args) {
    try {
      int port;
      if (!Int32.TryParse(Environment.GetEnvironmentVariable("ELEVENEX_ASKPASS_PORT"), out port) || port < 1 || port > 65535) return 1;
      string token = Environment.GetEnvironmentVariable("ELEVENEX_ASKPASS_TOKEN");
      if (String.IsNullOrEmpty(token)) return 1;
      byte[] prompt = Encoding.UTF8.GetBytes(String.Join(" ", args));
      if (prompt.Length > 4096) return 1;
      HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/");
      request.Proxy = null;
      request.Method = "POST";
      request.AllowAutoRedirect = false;
      request.Timeout = 125000;
      request.ReadWriteTimeout = 125000;
      request.Headers["Authorization"] = "Bearer " + token;
      request.ContentLength = prompt.Length;
      using (Stream output = request.GetRequestStream()) output.Write(prompt, 0, prompt.Length);
      using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) {
        if (response.StatusCode != HttpStatusCode.OK) return 1;
        using (StreamReader input = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
          StringBuilder answer = new StringBuilder();
          for (int c; (c = input.Read()) != -1;) { if (answer.Length >= 8192) return 1; answer.Append((char)c); }
          Console.OutputEncoding = new UTF8Encoding(false);
          Console.WriteLine(answer.ToString());
        }
      }
      return 0;
    } catch { return 1; }
  }
}
'@
`;

export async function windowsAskpass(directory: string, signal: AbortSignal): Promise<string> {
  const script = join(directory, 'build-askpass.ps1');
  const executable = join(directory, 'askpass.exe');
  await writeFile(script, source, { mode: 0o600 });
  const compiler = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, executable], {
    cwd: directory, windowsHide: true, stdio: 'ignore',
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const stopped = () => { if (compiler.pid) void signalBackendTree(compiler.pid, true); };
  deadline.addEventListener('abort', stopped, { once: true });
  if (deadline.aborted) stopped();
  try {
    const code = await new Promise<number | null>(resolve => { compiler.once('error', () => resolve(null)); compiler.once('exit', resolve); });
    signal.throwIfAborted();
    if (code !== 0) throw failure('authentication', 'configuration', 'Windows could not prepare the secure SSH prompt helper. Allow the built-in PowerShell Add-Type compiler or use an unlocked SSH agent.', 'edit');
    return executable;
  } finally { deadline.removeEventListener('abort', stopped); }
}
