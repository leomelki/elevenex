import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VSCodeWebPanelComponent } from './vscode-web-panel/vscode-web-panel.component';
import { VSCodeWebStateService } from './vscode-web-state.service';

@NgModule({
  imports: [CommonModule, VSCodeWebPanelComponent],
  exports: [VSCodeWebPanelComponent],
  providers: [VSCodeWebStateService],
})
export class VSCodeWebModule {}