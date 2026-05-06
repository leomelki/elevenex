import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { refreshLoginShellEnv } from './system-paths.js';

// Owns the lifecycle of the cached login-shell environment.
//
// - `OnApplicationBootstrap`: forces a refresh once the app is up, so the
//   cache is warm before any request can spawn a child process.
// - `refresh()`: throttled, fire-and-forget. Called from a global HTTP
//   middleware so the user can edit dotfiles, reconnect, and have elevenex
//   pick up the changes without a backend restart.
@Injectable()
export class ShellEnvService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ShellEnvService.name);

  async onApplicationBootstrap(): Promise<void> {
    const start = Date.now();
    await refreshLoginShellEnv(true);
    this.logger.log(`Login-shell env warmed in ${Date.now() - start}ms`);
  }

  refresh(): void {
    void refreshLoginShellEnv();
  }
}
