import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { OptionSelectComponent } from '@/shared/components/option-select';
import { AgentAuthStatus } from '@/shared/models/agent-runtime.model';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';

interface OpenCodeAuthMethod {
  type: 'oauth' | 'api';
  label: string;
  prompts?: unknown[];
}
interface OpenCodeAuthProvider {
  id: string;
  name: string;
  connected: boolean;
}

@Component({
  selector: 'cw-opencode-login-card',
  imports: [ZardButtonComponent, ZardInputDirective, OptionSelectComponent],
  templateUrl: './opencode-login-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full max-w-lg py-8' },
})
export class OpenCodeLoginCardComponent {
  readonly status = input<AgentAuthStatus | null>(null);
  readonly authenticated = output<void>();
  readonly dismissible = input(false);
  readonly closed = output<void>();
  private readonly api = inject(AgentRuntimeApiService);
  private observedLogin = false;
  readonly provider = signal('');
  readonly apiKey = signal('');
  readonly code = signal('');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly authorization = signal<{
    authUrl: string | null;
    message: string;
    supportsManualCode?: boolean;
  } | null>(null);
  readonly providers = computed(() =>
    ((this.status()?.['providers'] ?? []) as OpenCodeAuthProvider[]).map((provider) => ({
      value: provider.id,
      label: provider.name,
      badge: provider.connected ? 'Connected' : undefined,
    })),
  );
  readonly methods = computed(
    () =>
      ((this.status()?.['authMethods'] ?? {}) as Record<string, OpenCodeAuthMethod[]>)[
        this.provider()
      ] ?? [],
  );
  readonly supportsOAuth = computed(() =>
    this.methods().some((method) => method.type === 'oauth' && !method.prompts?.length),
  );
  readonly supportsApiKey = computed(
    () => !this.methods().length || this.methods().some((method) => method.type === 'api'),
  );
  readonly needsCliSetup = computed(() => this.methods().some((method) => method.prompts?.length));

  constructor() {
    effect(() => {
      const status = this.status();
      if (status?.isAuthenticating) {
        this.observedLogin = true;
        return;
      }
      if (!this.observedLogin) return;
      const authorization = this.authorization();
      if (!authorization) return;
      this.observedLogin = false;
      // Manual codes complete through continueLogin; browser OAuth completes through status events.
      if (
        !authorization.supportsManualCode &&
        !status?.error &&
        status?.providers?.some((provider) => provider.id === this.provider() && provider.connected)
      ) {
        this.authorization.set(null);
        this.authenticated.emit();
      }
    });
  }

  async login(mode: 'oauth' | 'api_key'): Promise<void> {
    this.observedLogin = false;
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await firstValueFrom(
        this.api.startLogin(
          {
            mode,
            apiKey: mode === 'api_key' ? this.apiKey() : undefined,
            apiKeyProvider: this.provider(),
            oauthProvider: this.provider(),
          },
          'opencode',
        ),
      );
      this.apiKey.set('');
      this.authorization.set(result);
      if (result.authUrl) {
        const external = getElectronExternalLinksApi();
        if (external) await external.open(result.authUrl);
        else window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      }
      if (mode === 'api_key') this.authenticated.emit();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'OpenCode login failed.');
    } finally {
      this.busy.set(false);
    }
  }
  async continueLogin(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.continueLogin({ code: this.code() }, 'opencode'));
      this.code.set('');
      this.authenticated.emit();
    } catch {
      this.error.set('OpenCode could not complete login. Check the authorization code.');
    } finally {
      this.busy.set(false);
    }
  }
  async cancel(): Promise<void> {
    this.observedLogin = false;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.cancelLogin('opencode'));
      this.authorization.set(null);
    } catch {
      this.error.set('OpenCode could not cancel login.');
    } finally {
      this.busy.set(false);
    }
  }
  async dismiss(): Promise<void> {
    if (this.authorization()) {
      await this.cancel();
      if (this.error()) return;
    }
    this.closed.emit();
  }
}
