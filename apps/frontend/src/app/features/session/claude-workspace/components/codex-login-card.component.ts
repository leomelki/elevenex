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
import { FormsModule } from '@angular/forms';
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

type Mode = 'choose' | 'oauth' | 'api_key';

@Component({
  selector: 'cw-codex-login-card',
  standalone: true,
  imports: [CommonModule, FormsModule, NgIcon, ZardButtonComponent, ZardInputDirective],
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
  templateUrl: './codex-login-card.component.html',
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
    // We deliberately do NOT auto-open the verification page here — the
    // user needs to see the one-time code on this card before navigating
    // away. They confirm with the primary CTA below.
    void firstValueFrom(this.api.startLogin({ mode: 'oauth' }, 'codex'))
      .catch((error) => {
        this.localError.set(extractError(error, 'Could not start Codex login.'));
        this.mode.set('choose');
      })
      .finally(() => this.busy.set(false));
  }

  copyAndOpen(): void {
    const url = this.authUrl();
    const code = this.userCode();
    if (!url || !code) return;
    void navigator.clipboard.writeText(code).catch(() => undefined);
    this.openVerificationUrl(url);
    toast.success('Code copied. Paste it on the page that just opened.');
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
