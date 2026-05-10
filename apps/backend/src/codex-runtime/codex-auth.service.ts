import { Injectable } from '@nestjs/common';
import { execFile as execFileCallback } from 'child_process';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { buildAugmentedEnv, findBinary } from '../config/system-paths.js';
import type { CodexAuthStatus } from './codex-runtime.types.js';

const execFile = promisify(execFileCallback);

@Injectable()
export class CodexAuthService {
  private readonly authPath = join(homedir(), '.codex', 'auth.json');

  async getStatus(): Promise<CodexAuthStatus> {
    const [version, authFile] = await Promise.all([
      this.readVersion(),
      this.readAuthFile(),
    ]);
    const tokens = asRecord(authFile?.tokens);
    const idToken = stringValue(tokens?.id_token);
    const accessToken = stringValue(tokens?.access_token);
    const apiKey = stringValue(authFile?.OPENAI_API_KEY);
    const email = idToken ? this.extractJwtEmail(idToken) : undefined;
    const authenticated = Boolean(idToken || accessToken || apiKey);
    const authMethod = idToken || accessToken ? 'oauth' : apiKey ? 'api_key' : 'none';
    const output = [
      version ? `codex ${version}` : 'Codex CLI not found',
      authenticated
        ? authMethod === 'oauth'
          ? `Signed in${email ? ` as ${email}` : ''}`
          : 'OPENAI_API_KEY configured'
        : 'No Codex credentials found',
    ];

    return {
      isAuthenticating: false,
      output,
      installed: Boolean(version),
      version,
      authenticated,
      authMethod,
      email,
      authPath: this.authPath,
    };
  }

  private async readVersion(): Promise<string | null> {
    const codexBin = findBinary('codex') ?? 'codex';
    try {
      const { stdout } = await execFile(codexBin, ['--version'], {
        encoding: 'utf-8',
        env: buildAugmentedEnv(),
        timeout: 5000,
      });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async readAuthFile(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await fs.readFile(this.authPath, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
  }

  private extractJwtEmail(token: string): string | undefined {
    const payload = token.split('.')[1];
    if (!payload) {
      return undefined;
    }
    try {
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const parsed = JSON.parse(
        Buffer.from(normalized, 'base64').toString('utf-8'),
      ) as Record<string, unknown>;
      return stringValue(parsed.email) ?? stringValue(parsed.user);
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
