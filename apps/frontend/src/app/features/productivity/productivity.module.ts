import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ProductivityStateService } from './productivity-state.service';
import { ScratchpadService } from './scratchpad.service';
import { TodosService } from './todos.service';
import { ScratchpadPanelComponent } from './scratchpad-panel/scratchpad-panel';
import { TodoPanelComponent } from './todo-panel/todo-panel';

@NgModule({
  imports: [CommonModule, ScratchpadPanelComponent, TodoPanelComponent],
  exports: [ScratchpadPanelComponent, TodoPanelComponent],
  providers: [ProductivityStateService, ScratchpadService, TodosService],
})
export class ProductivityModule {}
