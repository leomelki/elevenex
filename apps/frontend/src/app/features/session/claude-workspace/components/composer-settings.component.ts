import { ZardButtonComponent } from '@/shared/components/button';
import type {
  AgentProviderId,
  AgentRuntimeProviderInfo,
} from '@/shared/models/agent-runtime.model';
import type { ClaudePermissionMode } from '@/shared/models/claude-runtime.model';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideLockKeyhole, lucideShield, lucideZap } from '@ng-icons/lucide';

@Component({
  selector: 'cw-composer-settings',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './composer-settings.component.html',
  viewProviders: [provideIcons({ lucideCheck, lucideLockKeyhole, lucideShield, lucideZap })],
})
export class ComposerSettingsComponent {
  private static nextId = 0;
  private readonly instanceId = ComposerSettingsComponent.nextId++;
  readonly providerGroup = `composer-provider-${this.instanceId}`;
  readonly permissionGroup = `composer-permission-${this.instanceId}`;
  readonly providers = input<AgentRuntimeProviderInfo[]>([]);
  readonly currentProvider = input<AgentProviderId>('claude');
  readonly providerLocked = input(false);
  readonly supportsPermissions = input(false);
  readonly permissionOptions = input<{ id: ClaudePermissionMode; label: string; hint: string }[]>(
    [],
  );
  readonly permissionMode = input<ClaudePermissionMode>('default');
  readonly supportsFastMode = input(false);
  readonly fastMode = input(false);
  readonly currentProviderLabel = computed(
    () =>
      this.providers().find((provider) => provider.id === this.currentProvider())?.displayName ??
      this.currentProvider(),
  );

  readonly providerChange = output<AgentProviderId>();
  readonly permissionModeChange = output<ClaudePermissionMode>();
  readonly fastModeChange = output<boolean>();

  pickProvider(event: Event, provider: AgentProviderId): void {
    // Keep the radio selection tied to the confirmed runtime state, including
    // when a settings request fails or takes a while to complete.
    event.preventDefault();
    if (!this.providerLocked() && provider !== this.currentProvider()) {
      this.providerChange.emit(provider);
    }
  }

  pickPermissionMode(event: Event, mode: ClaudePermissionMode): void {
    event.preventDefault();
    if (mode !== this.permissionMode()) {
      this.permissionModeChange.emit(mode);
    }
  }
}
