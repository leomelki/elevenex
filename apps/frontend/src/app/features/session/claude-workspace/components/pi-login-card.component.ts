import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
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
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';

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
  { id: 'anthropic', label: 'Anthropic (Claude Pro/Max)', description: 'Sign in with your Claude.ai subscription' },
  { id: 'github-copilot', label: 'GitHub Copilot', description: 'Sign in with your GitHub Copilot subscription' },
  { id: 'openai-codex', label: 'OpenAI Codex (ChatGPT Plus/Pro)', description: 'Sign in with your ChatGPT subscription' },
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
  template: `
    <div class="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-sm">
      <header class="flex items-start gap-3">
        <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10 text-warning">
          <ng-icon name="lucideLogIn" size="18" />
        </span>
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold leading-tight">Sign in to Pi</h2>
          <p class="text-sm text-muted-foreground">
            @if (status()?.installed === false) {
              Pi CLI is not installed on this machine.
            } @else {
              Pi needs credentials before it can run. Choose a sign-in method below.
            }
          </p>
        </div>
      </header>

      @if (statusError(); as error) {
        <div class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <ng-icon name="lucideTriangleAlert" size="14" class="mt-0.5 shrink-0" />
          <span class="leading-relaxed">{{ error }}</span>
        </div>
      }

      @switch (mode()) {
        @case ('choose') {
          <div class="flex flex-col gap-2">
            <button
              type="button"
              z-button
              zType="default"
              class="justify-between"
              [disabled]="status()?.installed === false"
              (click)="mode.set('oauth-provider')"
            >
              <span class="flex items-center gap-2">
                <ng-icon name="lucideLogIn" size="14" />
                Use a subscription (OAuth)
              </span>
              <ng-icon name="lucideChevronRight" size="14" />
            </button>
            <button
              type="button"
              z-button
              zType="outline"
              class="justify-between"
              [disabled]="status()?.installed === false"
              (click)="mode.set('api-key-provider')"
            >
              <span class="flex items-center gap-2">
                <ng-icon name="lucideKey" size="14" />
                Use an API key
              </span>
              <ng-icon name="lucideChevronRight" size="14" />
            </button>
          </div>
        }

        @case ('oauth-provider') {
          <div class="flex flex-col gap-2">
            @for (provider of oauthProviders; track provider.id) {
              <button
                type="button"
                z-button
                zType="outline"
                class="h-auto flex-col items-start gap-0.5 py-3"
                [disabled]="busy()"
                (click)="startOAuth(provider.id)"
              >
                <span class="flex w-full items-center justify-between">
                  <span class="flex items-center gap-2">
                    @if (busy() && pendingOAuthProvider() === provider.id) {
                      <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
                    } @else {
                      <ng-icon name="lucideLogIn" size="14" />
                    }
                    {{ provider.label }}
                  </span>
                  <ng-icon name="lucideChevronRight" size="14" />
                </span>
                <span class="pl-5 text-xs font-normal text-muted-foreground">{{ provider.description }}</span>
              </button>
            }
          </div>
          <div class="flex items-center justify-end">
            <button type="button" z-button zType="ghost" (click)="mode.set('choose')">Back</button>
          </div>
        }

        @case ('oauth-device') {
          <div class="flex flex-col gap-4">
            <div class="flex flex-col gap-2">
              <span class="text-xs font-medium uppercase tracking-wide text-muted-foreground">One-time code</span>
              @if (userCode(); as code) {
                <code class="self-start select-all rounded-md border border-border bg-muted px-4 py-2.5 font-mono text-2xl tracking-[0.35em]">{{ code }}</code>
                <span class="text-xs text-muted-foreground">Expires in 15 minutes. Don't share it.</span>
              } @else {
                <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                  <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
                  Preparing your one-time code…
                </div>
              }
            </div>
            <button
              type="button"
              z-button
              zType="default"
              class="justify-between"
              [disabled]="!authUrl() || !userCode()"
              (click)="copyAndOpen()"
            >
              <span class="flex items-center gap-2">
                <ng-icon name="lucideExternalLink" size="14" />
                Copy code &amp; open verification page
              </span>
              <ng-icon name="lucideChevronRight" size="14" />
            </button>
            @if (authUrl(); as url) {
              <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">Trouble opening? Copy the link manually</summary>
                <div class="mt-2 flex items-stretch gap-2">
                  <input z-input class="flex-1 font-mono text-xs" readonly [value]="url" />
                  <button type="button" z-button zType="outline" zSize="sm" (click)="copyUrl(url)">Copy</button>
                </div>
              </details>
            }
            <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <ng-icon name="lucideLoaderCircle" size="14" class="shrink-0 animate-spin text-muted-foreground" />
              <span class="text-muted-foreground">Waiting for sign-in to complete — this page updates automatically.</span>
            </div>
            <div class="flex items-center justify-end gap-2">
              <button type="button" z-button zType="ghost" (click)="cancelOAuth()">Cancel</button>
            </div>
          </div>
        }

        @case ('oauth-browser') {
          <div class="flex flex-col gap-4">
            <p class="text-sm text-muted-foreground">
              Click the button below to open the authorization page in your browser. After approving access, you'll be redirected — the app completes sign-in automatically if the backend is local. If you're using remote SSH, paste the redirect URL below instead.
            </p>

            @if (authUrl(); as url) {
              <button
                type="button"
                z-button
                zType="default"
                class="justify-between"
                (click)="openBrowserUrl(url)"
              >
                <span class="flex items-center gap-2">
                  <ng-icon name="lucideExternalLink" size="14" />
                  Open authorization page
                </span>
                <ng-icon name="lucideChevronRight" size="14" />
              </button>

              <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">Trouble? Copy the link manually</summary>
                <div class="mt-2 flex items-stretch gap-2">
                  <input z-input class="flex-1 font-mono text-xs" readonly [value]="url" />
                  <button type="button" z-button zType="outline" zSize="sm" (click)="copyUrl(url)">Copy</button>
                </div>
              </details>
            } @else {
              <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
                Preparing authorization URL…
              </div>
            }

            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground" for="pi-redirect-url">
                Paste redirect URL (remote SSH)
              </label>
              <div class="flex items-stretch gap-2">
                <input
                  id="pi-redirect-url"
                  z-input
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="http://localhost:PORT/callback?code=…"
                  [disabled]="continueBusy()"
                  [value]="redirectUrlDraft()"
                  (input)="redirectUrlDraft.set($any($event.target).value)"
                />
                <button
                  type="button"
                  z-button
                  zType="default"
                  zSize="sm"
                  [disabled]="continueBusy() || !redirectUrlDraft().trim()"
                  (click)="submitRedirectUrl()"
                >
                  @if (continueBusy()) {
                    <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
                  }
                  Submit
                </button>
              </div>
              <span class="text-xs text-muted-foreground">
                After authorizing, your browser shows a failed redirect URL. Paste it here to complete sign-in remotely.
              </span>
            </div>

            <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <ng-icon name="lucideLoaderCircle" size="14" class="shrink-0 animate-spin text-muted-foreground" />
              <span class="text-muted-foreground">Waiting for authorization — this page updates automatically.</span>
            </div>

            <div class="flex items-center justify-end gap-2">
              <button type="button" z-button zType="ghost" (click)="cancelOAuth()">Cancel</button>
            </div>
          </div>
        }

        @case ('api-key-provider') {
          <div class="flex flex-col gap-2">
            @for (provider of apiKeyProviders; track provider.id) {
              <button
                type="button"
                z-button
                zType="outline"
                class="justify-between"
                (click)="selectApiKeyProvider(provider)"
              >
                <span class="flex items-center gap-2">
                  <ng-icon name="lucideKey" size="14" />
                  {{ provider.label }}
                </span>
                <ng-icon name="lucideChevronRight" size="14" />
              </button>
            }
          </div>
          <div class="flex items-center justify-end">
            <button type="button" z-button zType="ghost" (click)="mode.set('choose')">Back</button>
          </div>
        }

        @case ('api-key-input') {
          <form class="flex flex-col gap-3" (submit)="$event.preventDefault(); submitApiKey()">
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground" for="pi-api-key">
                {{ selectedApiKeyProvider()?.label }} API key
              </label>
              <input
                id="pi-api-key"
                z-input
                type="password"
                autocomplete="off"
                [placeholder]="selectedApiKeyProvider()?.placeholder ?? ''"
                spellcheck="false"
                [disabled]="busy()"
                [value]="apiKeyDraft()"
                (input)="apiKeyDraft.set($any($event.target).value)"
              />
              <span class="text-xs text-muted-foreground">
                Saved to <code class="rounded bg-muted px-1 py-0.5 text-xs">~/.pi/agent/auth.json</code>.
              </span>
            </div>
            <div class="flex items-center justify-end gap-2">
              <button type="button" z-button zType="ghost" [disabled]="busy()" (click)="mode.set('api-key-provider')">Back</button>
              <button type="submit" z-button zType="default" [disabled]="busy() || !apiKeyDraft().trim()">
                @if (busy()) {
                  <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
                }
                Save API key
              </button>
            </div>
          </form>
        }
      }
    </div>
  `,
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

    void firstValueFrom(this.api.startLogin({ mode: 'api_key', apiKeyProvider: provider.id, apiKey: key }, 'pi'))
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
