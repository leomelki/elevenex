import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSparkles, lucideServer } from '@ng-icons/lucide';
import { PlannotatorInstallPromptService } from './plannotator-install-prompt.service';

@Component({
  selector: 'app-plannotator-install-prompt',
  imports: [NgIcon],
  templateUrl: './plannotator-install-prompt.component.html',
  styleUrl: './plannotator-install-prompt.component.scss',
  viewProviders: [provideIcons({ lucideSparkles, lucideServer })],
})
export class PlannotatorInstallPromptComponent {
  readonly service = inject(PlannotatorInstallPromptService);
}
