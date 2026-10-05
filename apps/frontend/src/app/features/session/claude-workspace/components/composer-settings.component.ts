import { ZardButtonComponent } from '@/shared/components/button';
import type { ClaudePermissionMode } from '@/shared/models/claude-runtime.model';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideShield, lucideZap } from '@ng-icons/lucide';

@Component({
  selector: 'cw-composer-settings',
  imports: [NgIcon, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './composer-settings.component.html',
  viewProviders: [provideIcons({ lucideCheck, lucideShield, lucideZap })],
})
export class ComposerSettingsComponent {
  private static nextId = 0;
  private readonly instanceId = ComposerSettingsComponent.nextId++;
  readonly permissionGroup = `composer-permission-${this.instanceId}`;
  readonly supportsPermissions = input(false);
  readonly permissionOptions = input<{ id: ClaudePermissionMode; label: string; hint: string }[]>(
    [],
  );
  readonly permissionMode = input<ClaudePermissionMode>('default');
  readonly supportsFastMode = input(false);
  readonly fastMode = input(false);
  readonly permissionModeChange = output<ClaudePermissionMode>();
  readonly fastModeChange = output<boolean>();

  pickPermissionMode(event: Event, mode: ClaudePermissionMode): void {
    event.preventDefault();
    if (mode !== this.permissionMode()) {
      this.permissionModeChange.emit(mode);
    }
  }
}
