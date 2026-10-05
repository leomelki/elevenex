import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentAuthStatus } from '@/shared/models/agent-runtime.model';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideExternalLink,
  lucideKey,
  lucideLoaderCircle,
  lucideLogIn,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { firstValueFrom } from 'rxjs';

type Mode =
  | 'choose'
  | 'oauth-provider'
  | 'oauth-device'
  | 'oauth-browser'
  | 'api-key-provider'
  | 'api-key-input';

type OAuthProvider = { id: string; label: string; description: string };
type ApiKeyProvider = { id: string; label: string; placeholder: string };

const OAUTH_PROVIDERS: OAuthProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude Pro/Max)',
    description: 'Sign in with your Claude.ai subscription',
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    description: 'Sign in with your GitHub Copilot subscription',
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex (ChatGPT Plus/Pro)',
    description: 'Sign in with your ChatGPT subscription',
  },
];

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { id: 'google', label: 'Google / Gemini', placeholder: 'AIza…' },
  { id: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-…' },
];

@Component({
  selector: 'cw-pi-login-card',
  standalone: true,
  imports: [CommonModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideChevronRight,
      lucideExternalLink,
      lucideKey,
      lucideLoaderCircle,
      lucideLogIn,
      lucideTriangleAlert,
    }),
  ],
  templateUrl: './pi-login-card.component.html',
  host: { class: 'flex w-full items-center justify-center py-8' },
})
export class PiLoginCardComponent {
  readonly status = input<AgentAuthStatus | null>(null);
  readonly authenticated = output<void>();

  private readonly api = inject(AgentRuntimeApiService);

  readonly oauthProviders = OAUTH_PROVIDERS;
  readonly apiKeyProviders = API_KEY_PROVIDERS;

  readonly mode = signal<Mode>('choose');
  readonly busy = signal(false);
  readonly continueBusy = signal(false);
  readonly localError = signal<string | null>(null);
  readonly pendingOAuthProvider = signal<string | null>(null);
  readonly selectedApiKeyProvider = signal<ApiKeyProvider | null>(null);
  readonly apiKeyDraft = signal('');
  readonly redirectUrlDraft = signal('');

  readonly authUrl = computed(() => this.status()?.loginUrl ?? null);
  readonly userCode = computed(() => this.status()?.loginUserCode ?? null);
  readonly statusError = computed(
    () => this.localError() ?? this.status()?.loginError ?? this.status()?.error ?? null,
  );

  startOAuth(providerId: string): void {
    this.localError.set(null);
    this.pendingOAuthProvider.set(providerId);
    this.busy.set(true);

    void firstValueFrom(this.api.startLogin({ mode: 'oauth', oauthProvider: providerId }, 'pi'))
      .then(() => {
        const isDeviceFlow = providerId === 'github-copilot';
        this.mode.set(isDeviceFlow ? 'oauth-device' : 'oauth-browser');
      })
      .catch((error) => {
        this.localError.set(extractError(error, 'Could not start Pi login.'));
        this.mode.set('oauth-provider');
      })
      .finally(() => {
        this.busy.set(false);
        this.pendingOAuthProvider.set(null);
      });
  }

  cancelOAuth(): void {
    void firstValueFrom(this.api.cancelLogin('pi'))
      .catch(() => undefined)
      .finally(() => {
        this.mode.set('choose');
        this.busy.set(false);
        this.redirectUrlDraft.set('');
      });
  }

  copyAndOpen(): void {
    const url = this.authUrl();
    const code = this.userCode();
    if (!url || !code) return;
    void navigator.clipboard.writeText(code).catch(() => undefined);
    this.openBrowserUrl(url);
    toast.success('Code copied. Paste it on the page that just opened.');
  }

  openBrowserUrl(url: string): void {
    const electronApi = getElectronExternalLinksApi();
    if (electronApi) {
      void electronApi.open(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  submitRedirectUrl(): void {
    const value = this.redirectUrlDraft().trim();
    if (!value) return;
    this.localError.set(null);
    this.continueBusy.set(true);

    void firstValueFrom(this.api.continueLogin({ code: value }, 'pi'))
      .then(() => {
        this.redirectUrlDraft.set('');
        toast.success('Pi authorization submitted. Waiting for confirmation…');
      })
      .catch((error) => {
        this.localError.set(extractError(error, 'Could not submit authorization code.'));
      })
      .finally(() => this.continueBusy.set(false));
  }

  selectApiKeyProvider(provider: ApiKeyProvider): void {
    this.selectedApiKeyProvider.set(provider);
    this.apiKeyDraft.set('');
    this.mode.set('api-key-input');
  }

  submitApiKey(): void {
    const key = this.apiKeyDraft().trim();
    const provider = this.selectedApiKeyProvider();
    if (!key || !provider) return;
    this.localError.set(null);
    this.busy.set(true);

    void firstValueFrom(
      this.api.startLogin({ mode: 'api_key', apiKeyProvider: provider.id, apiKey: key }, 'pi'),
    )
      .then(() => {
        this.apiKeyDraft.set('');
        toast.success(`Pi API key saved for ${provider.label}.`);
        this.authenticated.emit();
      })
      .catch((error) => {
        this.localError.set(extractError(error, 'Could not save API key.'));
      })
      .finally(() => this.busy.set(false));
  }

  copyUrl(url: string): void {
    void navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied.'),
      () => toast.error('Could not copy the link.'),
    );
  }
}

function extractError(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const payload = (error as { error?: unknown }).error;
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
    if (typeof payload === 'string' && payload.trim()) return payload;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
