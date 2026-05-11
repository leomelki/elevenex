import { Injectable } from '@nestjs/common';
import { execFile as execFileCallback } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { buildAugmentedEnv } from '../config/system-paths.js';
import type { PiAuthStatus } from './pi-runtime.types.js';

const execFile = promisify(execFileCallback);
const VERSION_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class PiAuthService {
  private readonly authPath = join(homedir(), '.pi', 'agent', 'auth.json');
  private readonly modelsPath = join(homedir(), '.pi', 'agent', 'models.json');
  private versionCache: { value: string | null; expiresAt: number } | null = null;

  async getStatus(): Promise<PiAuthStatus> {
    const version = await this.readVersion();
    const hasAuth = existsSync(this.authPath);
    const hasModels = existsSync(this.modelsPath);
    const authenticated = hasAuth || this.hasProviderEnv();
    const output = [
      version ? `pi ${version}` : 'Pi CLI not found',
      authenticated
        ? hasAuth
          ? `Pi auth configured at ${this.authPath}`
          : 'Provider API key available in environment'
        : 'No Pi credentials found',
      hasModels ? `Models configured at ${this.modelsPath}` : 'No Pi models.json found',
    ];

    return {
      isAuthenticating: false,
      output,
      installed: Boolean(version),
      version,
      authenticated,
      authMethod: authenticated ? 'api_key' : 'none',
      authPath: this.authPath,
      modelsPath: this.modelsPath,
    };
  }

  private async readVersion(): Promise<string | null> {
    const cached = this.versionCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    try {
      const { stdout } = await execFile('pi', ['--version'], {
        env: buildAugmentedEnv(),
        timeout: 5000,
      });
      const value = stdout.trim().split(/\s+/).pop() || stdout.trim() || null;
      this.versionCache = { value, expiresAt: Date.now() + VERSION_TTL_MS };
      return value;
    } catch {
      this.versionCache = { value: null, expiresAt: Date.now() + VERSION_TTL_MS };
      return null;
    }
  }

  private hasProviderEnv(): boolean {
    return [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'OPENROUTER_API_KEY',
    ].some((name) => Boolean(process.env[name]));
  }
}
