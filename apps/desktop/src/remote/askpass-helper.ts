/** Executed only by OpenSSH under Electron's Node mode; no credentials on disk/argv. */
import { request } from 'node:http';
const port = Number(process.env['ELEVENEX_ASKPASS_PORT']);
const token = process.env['ELEVENEX_ASKPASS_TOKEN'];
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(1);
const childRequest = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/', headers: {
  Authorization: `Bearer ${token}`, 'X-Elevenex-Askpass-Prompt': process.env['SSH_ASKPASS_PROMPT'] ?? '',
} }, response => {
  if (response.statusCode !== 200) { response.resume(); process.exitCode = 1; return; }
  let body = '';
  response.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body) > 8192) { response.destroy(); process.exitCode = 1; }
  });
  response.on('end', () => { if (!process.exitCode) process.stdout.write(`${body}\n`); });
  response.on('error', () => { process.exitCode = 1; });
});
childRequest.setTimeout(125_000, () => childRequest.destroy());
childRequest.on('error', () => { process.exitCode = 1; });
childRequest.end(process.argv.slice(2).join(' '));
