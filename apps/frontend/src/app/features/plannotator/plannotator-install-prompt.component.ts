import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSparkles, lucideServer } from '@ng-icons/lucide';
import { ZardButtonComponent } from '@/shared/components/button';
import { PlannotatorInstallPromptService } from './plannotator-install-prompt.service';

@Component({
  selector: 'app-plannotator-install-prompt',
  imports: [NgIcon, ZardButtonComponent],
  templateUrl: './plannotator-install-prompt.component.html',
  viewProviders: [provideIcons({ lucideSparkles, lucideServer })],
})
export class PlannotatorInstallPromptComponent {
  readonly service = inject(PlannotatorInstallPromptService);
}
