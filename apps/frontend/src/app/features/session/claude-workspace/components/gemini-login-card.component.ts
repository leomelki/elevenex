import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronRight,
  lucideExternalLink,
  lucideKey,
  lucideLoaderCircle,
  lucideLogIn,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentAuthStatus } from '@/shared/models/agent-runtime.model';

type Mode = 'choose' | 'oauth-browser' | 'api-key-provider' | 'api-key-input';

interface ApiKeyProvider {
  /** Matches the ACP `authMethods` id the backend expects. */
  id: string;
  label: string;
  description: string;
  placeholder: string;
}

const API_KEY_PROVIDERS: ApiKeyProvider[] = [
  {
    id: 'gemini-api-key',
    label: 'Gemini API key',
    description: 'A key from Google AI Studio',
    placeholder: 'AIza…',
  },
  {
    id: 'vertex-ai',
    label: 'Vertex AI',
    description: 'A key for the Vertex AI GenAI API',
    placeholder: 'AIza…',
  },
];

/**
 * Sign-in surface for the Gemini CLI.
 *
 * Unlike Pi and Codex, the OAuth flow is not reimplemented here: the backend
 * asks the Gemini CLI to authenticate over ACP, and the CLI opens the browser
 * and stores the credential itself. There is therefore no device code or
 * redirect URL to paste back — the card just waits for the status poll to
 * report success.
 */
@Component({
  selector: 'cw-gemini-login-card',
  standalone: true,
  imports: [NgIcon, ZardButtonComponent, ZardInputDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './gemini-login-card.component.html',
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
  host: { class: 'flex w-full items-center justify-center py-8' },
})
export class GeminiLoginCardComponent {
  readonly status = input<AgentAuthStatus | null>(null);
  readonly authenticated = output<void>();

  private readonly api = inject(AgentRuntimeApiService);

  readonly apiKeyProviders = API_KEY_PROVIDERS;

  readonly mode = signal<Mode>('choose');
  readonly busy = signal(false);
  readonly localError = signal<string | null>(null);
  readonly selectedApiKeyProvider = signal<ApiKeyProvider | null>(null);
  readonly apiKeyDraft = signal('');

  /** Nothing can be done until the CLI exists on this machine. */
  readonly disabled = computed(
    () => this.busy() || this.status()?.installed === false,
  );
  readonly installHint = computed(() => {
    const status = this.status();
    return status?.installed === false ? (status.installHint ?? null) : null;
  });
  readonly statusError = computed(
    () =>
      this.localError() ??
      this.status()?.loginError ??
      this.status()?.error ??
      null,
  );

  startOAuth(): void {
    this.localError.set(null);
    this.busy.set(true);
    this.mode.set('oauth-browser');

    void firstValueFrom(
      this.api.startLogin({ mode: 'oauth', oauthProvider: 'oauth-personal' }, 'gemini'),
    )
      .catch((error: unknown) => {
        this.localError.set(extractError(error, 'Could not start Gemini login.'));
        this.mode.set('choose');
      })
      .finally(() => this.busy.set(false));
  }

  cancelOAuth(): void {
    void firstValueFrom(this.api.cancelLogin('gemini'))
      .catch(() => undefined)
      .finally(() => {
        this.mode.set('choose');
        this.busy.set(false);
      });
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
      this.api.startLogin(
        { mode: 'api_key', apiKeyProvider: provider.id, apiKey: key },
        'gemini',
      ),
    )
      .then(() => {
        this.apiKeyDraft.set('');
        toast.success(`Gemini API key saved for ${provider.label}.`);
        this.authenticated.emit();
      })
      .catch((error: unknown) => {
        this.localError.set(extractError(error, 'Could not save the API key.'));
      })
      .finally(() => this.busy.set(false));
  }
}

function extractError(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const payload = (error as { error?: unknown }).error;
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
