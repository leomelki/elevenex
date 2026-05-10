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
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { toast } from 'ngx-sonner';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronRight,
  lucideKey,
  lucideLoaderCircle,
  lucideLogIn,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { AgentRuntimeApiService } from '@/shared/services/agent-runtime-api.service';
import { AgentAuthStatus } from '@/shared/models/agent-runtime.model';
import { getElectronExternalLinksApi } from '@/shared/runtime/electron-external-links';

type Mode = 'choose' | 'oauth' | 'api_key';

@Component({
  selector: 'cw-codex-login-card',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon, ZardButtonComponent, ZardInputDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronRight,
      lucideKey,
      lucideLoaderCircle,
      lucideLogIn,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  template: `
    <div class="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-sm">
      <header class="flex items-start gap-3">
        <span class="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10 text-warning">
          <ng-icon name="lucideLogIn" size="18" />
        </span>
        <div class="flex flex-col gap-1">
          <h2 class="text-base font-semibold leading-tight">Sign in to Codex</h2>
          <p class="text-sm text-muted-foreground">
            @if (status()?.installed === false) {
              Codex CLI is not installed on this machine. Install it with
              <code class="rounded bg-muted px-1 py-0.5 text-xs">npm install -g &#64;openai/codex</code>
              and try again.
            } @else {
              Codex needs OpenAI credentials before it can run. Sign in with ChatGPT or paste an API key.
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
              [disabled]="status()?.installed === false || busy()"
              (click)="signInWithBrowser()"
            >
              <span class="flex items-center gap-2">
                @if (busy()) {
                  <ng-icon name="lucideLoaderCircle" size="14" class="animate-spin" />
                } @else {
                  <ng-icon name="lucideLogIn" size="14" />
                }
                Sign in with ChatGPT
              </span>
              <ng-icon name="lucideChevronRight" size="14" />
            </button>
            <button
              type="button"
              z-button
              zType="outline"
              class="justify-between"
              [disabled]="status()?.installed === false"
              (click)="mode.set('api_key')"
            >
              <span class="flex items-center gap-2">
                <ng-icon name="lucideKey" size="14" />
                Use an OpenAI API key
              </span>
              <ng-icon name="lucideChevronRight" size="14" />
            </button>
          </div>
        }
        @case ('oauth') {
          <div class="flex flex-col gap-4">
            <ol class="flex flex-col gap-3 text-sm">
              <li class="flex flex-col gap-1.5">
                <span class="flex items-center gap-2">
                  <span class="flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs font-semibold">1</span>
                  Open the verification page
                </span>
                @if (authUrl(); as url) {
                  <div class="flex items-stretch gap-2 pl-7">
                    <input
                      z-input
                      class="flex-1 font-mono text-xs"
                      readonly
                      [value]="url"
                    />
                    <button
                      type="button"
                      z-button
                      zType="outline"
                      zSize="sm"
                      (click)="copyUrl(url)"
                    >Copy</button>
                    <button
                      type="button"
                      z-button
                      zType="default"
                      zSize="sm"
                      (click)="reopenUrl(url)"
                    >Open</button>
                  </div>
                } @else {
                  <span class="pl-7 text-xs text-muted-foreground">Waiting for Codex to provide a link…</span>
                }
              </li>
              <li class="flex flex-col gap-1.5">
                <span class="flex items-center gap-2">
                  <span class="flex h-5 w-5 items-center justify-center rounded-full border border-border text-xs font-semibold">2</span>
                  Enter the one-time code
                </span>
                @if (userCode(); as code) {
                  <div class="flex items-center gap-2 pl-7">
                    <code class="select-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-lg tracking-widest">{{ code }}</code>
                    <button
                      type="button"
                      z-button
                      zType="outline"
                      zSize="sm"
                      (click)="copyCode(code)"
                    >Copy code</button>
                  </div>
                  <span class="pl-7 text-xs text-muted-foreground">Codes expire in 15 minutes.</span>
                } @else {
                  <span class="pl-7 text-xs text-muted-foreground">Waiting for Codex to issue a code…</span>
                }
              </li>
            </ol>
            <div class="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <ng-icon name="lucideLoaderCircle" size="14" class="shrink-0 animate-spin text-muted-foreground" />
              <span class="text-muted-foreground">
                Waiting for sign-in to complete… this page updates automatically.
              </span>
            </div>
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                z-button
                zType="ghost"
                (click)="cancelLogin()"
              >Cancel</button>
            </div>
          </div>
        }
        @case ('api_key') {
          <form class="flex flex-col gap-3" (submit)="$event.preventDefault(); submitApiKey()">
            <div class="flex flex-col gap-1">
              <label class="text-xs font-medium uppercase tracking-wide text-muted-foreground" for="codex-api-key">
                OpenAI API key
              </label>
              <input
                id="codex-api-key"
                z-input
                type="password"
                autocomplete="off"
                placeholder="sk-…"
                spellcheck="false"
                [disabled]="busy()"
                [(ngModel)]="apiKeyDraft"
                [ngModelOptions]="{ standalone: true }"
              />
              <span class="text-xs text-muted-foreground">
                Saved locally to <code class="rounded bg-muted px-1 py-0.5 text-xs">~/.codex/auth.json</code>.
              </span>
            </div>
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                z-button
                zType="ghost"
                [disabled]="busy()"
                (click)="mode.set('choose')"
              >Back</button>
              <button
                type="submit"
                z-button
                zType="default"
                [disabled]="busy() || !apiKeyDraft.trim()"
              >
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
export class CodexLoginCardComponent {
  readonly status = input<AgentAuthStatus | null>(null);
  readonly authenticated = output<void>();

  private readonly api = inject(AgentRuntimeApiService);

  readonly mode = signal<Mode>('choose');
  readonly busy = signal(false);
  readonly localError = signal<string | null>(null);
  apiKeyDraft = '';

  readonly authUrl = computed(() => this.status()?.loginUrl ?? null);
  readonly userCode = computed(() => this.status()?.loginUserCode ?? null);
  readonly statusError = computed(
    () => this.localError() ?? this.status()?.loginError ?? this.status()?.error ?? null,
  );

  constructor() {
    // If the parent updates `status` while we're showing the OAuth wait state and the
    // user becomes authenticated, the parent itself will hide this card — we don't
    // need to react here.
  }

  signInWithBrowser(): void {
    this.localError.set(null);
    this.mode.set('oauth');
    this.busy.set(true);
    void firstValueFrom(this.api.startLogin({ mode: 'oauth' }, 'codex'))
      .then((result) => {
        if (result.authUrl) {
          this.openVerificationUrl(result.authUrl);
        }
      })
      .catch((error) => {
        this.localError.set(extractError(error, 'Could not start Codex login.'));
        this.mode.set('choose');
      })
      .finally(() => this.busy.set(false));
  }

  submitApiKey(): void {
    const key = this.apiKeyDraft.trim();
    if (!key) return;
    this.localError.set(null);
    this.busy.set(true);
    void firstValueFrom(this.api.startLogin({ mode: 'api_key', apiKey: key }, 'codex'))
      .then(() => {
        this.apiKeyDraft = '';
        toast.success('Codex API key saved.');
        this.authenticated.emit();
      })
      .catch((error) => {
        this.localError.set(extractError(error, 'Could not save API key.'));
      })
      .finally(() => this.busy.set(false));
  }

  cancelLogin(): void {
    void firstValueFrom(this.api.cancelLogin('codex'))
      .catch(() => undefined)
      .finally(() => {
        this.mode.set('choose');
        this.busy.set(false);
      });
  }

  copyUrl(url: string): void {
    void navigator.clipboard.writeText(url).then(
      () => toast.success('Link copied.'),
      () => toast.error('Could not copy the link.'),
    );
  }

  copyCode(code: string): void {
    void navigator.clipboard.writeText(code).then(
      () => toast.success('Code copied.'),
      () => toast.error('Could not copy the code.'),
    );
  }

  reopenUrl(url: string): void {
    this.openVerificationUrl(url);
  }

  private openVerificationUrl(url: string): void {
    // The codex device-auth flow doesn't need a controlled browser — there's
    // no localhost callback. Open in the user's real default browser so they
    // benefit from existing ChatGPT cookies / password manager.
    const electronApi = getElectronExternalLinksApi();
    if (electronApi) {
      void electronApi.open(url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
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
