import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  isLoginShellEnvRefreshEnabled,
  refreshLoginShellEnv,
  disposeShellEnvironment,
  warmShellEnvironment,
} from './system-paths.js';

// Owns the lifecycle of the cached login-shell environment.
//
// - `OnApplicationBootstrap`: starts a global capture with a bounded readiness
//   wait. Cold launchers wait through their own deadline if warming continues.
// - `refresh()`: throttled, fire-and-forget. Called from a global HTTP
//   middleware so the user can edit dotfiles, reconnect, and have elevenex
//   pick up the changes without a backend restart.
@Injectable()
export class ShellEnvService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ShellEnvService.name);

  async onApplicationBootstrap(): Promise<void> {
    if (!isLoginShellEnvRefreshEnabled()) return;

    const start = Date.now();
    const settled = await warmShellEnvironment();
    this.logger.log(
      settled
        ? `Login-shell env capture settled in ${Date.now() - start}ms`
        : 'Login-shell env warm-up continues in the background',
    );
  }

  refresh(): void {
    if (!isLoginShellEnvRefreshEnabled()) return;

    void refreshLoginShellEnv();
  }

  onModuleDestroy(): void {
    disposeShellEnvironment();
  }
}
