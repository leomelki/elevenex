import { Component, inject, input, output, signal, viewChild, viewChildren, ElementRef, OnInit, AfterViewInit, effect } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX, lucidePlus, lucideChevronDown, lucideChevronRight } from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { CommonModule } from '@angular/common';

import { ZardButtonComponent } from '@/shared/components/button';
import { ZardInputDirective } from '@/shared/components/input';
import { ScratchpadService, Section } from '../scratchpad.service';
import { TrackNativeModalDirective } from '@/shared/core/directives/track-native-modal.directive';

@Component({
  selector: 'app-scratchpad-panel',
  imports: [
    CommonModule,
    NgIcon,
    ZardButtonComponent,
    ZardInputDirective,
    TrackNativeModalDirective,
  ],
  templateUrl: './scratchpad-panel.html',
  viewProviders: [provideIcons({ lucideX, lucidePlus, lucideChevronDown, lucideChevronRight })],
})
export class ScratchpadPanelComponent implements OnInit, AfterViewInit {
  projectId = input.required<number>();
  isOpen = input<boolean>(false);
  close = output<void>();

  private scratchpadService = inject(ScratchpadService);

  sections = signal<Section[]>([]);
  loading = signal(true);
  expandedSectionId = signal<number | null>(null);
  editingTitleId = signal<number | null>(null);
  savingSectionId = signal<number | null>(null);

  showDeleteDialog = signal<number | null>(null);
  private deleteDialogRef = viewChild<TrackNativeModalDirective>('deleteDialog');
  private titleInputRef = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  
  // Track all content textareas
  contentTextareas = viewChildren<ElementRef<HTMLTextAreaElement>>('contentTextarea');

  constructor() {
    // Watch for projectId changes and reload
    effect(() => {
      const pid = this.projectId();
      if (pid) {
        this.loadSections();
      }
    });
  }

  ngOnInit() {
    this.loadSections();
  }

  ngAfterViewInit() {
    // Initial resize
    this.resizeVisibleTextareas();
  }

  // Called when expanded section changes
  onSectionExpanded() {
    // Use setTimeout to wait for DOM to update
    setTimeout(() => this.resizeVisibleTextareas(), 0);
  }

  private resizeVisibleTextareas() {
    const textareas = this.contentTextareas();
    if (!textareas || textareas.length === 0) return;
    
    textareas.forEach(ref => {
      const textarea = ref.nativeElement;
      if (textarea.offsetParent !== null) {
        this.autoResizeTextarea(textarea);
      }
    });
  }

  private autoResizeTextarea(textarea: HTMLTextAreaElement) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  loadSections() {
    this.loading.set(true);
    this.scratchpadService.getSections(this.projectId()).subscribe({
      next: (sections) => {
        this.sections.set(sections);
        if (sections.length > 0 && !this.expandedSectionId()) {
          this.expandedSectionId.set(sections[0].id);
        }
        this.loading.set(false);
        // Resize after sections load
        setTimeout(() => this.resizeVisibleTextareas(), 50);
      },
      error: () => {
        toast.error('Could not load scratchpad');
        this.loading.set(false);
      },
    });
  }

  toggleSection(sectionId: number) {
    if (this.editingTitleId() !== null) return;
    this.expandedSectionId.update(id => id === sectionId ? null : sectionId);
    // Resize after toggle
    this.onSectionExpanded();
  }

  startEditTitle(sectionId: number, currentName: string) {
    this.editingTitleId.set(sectionId);
    setTimeout(() => {
      const input = this.titleInputRef()?.nativeElement;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  saveTitle(sectionId: number, event: Event) {
    const input = event.target as HTMLInputElement;
    const name = input.value.trim();
    
    if (!name) {
      this.cancelEditTitle();
      return;
    }

    this.scratchpadService.updateSection(sectionId, { name }).subscribe({
      next: (updated) => {
        this.sections.update(list => 
          list.map(s => s.id === sectionId ? updated : s)
        );
        this.editingTitleId.set(null);
      },
      error: () => {
        toast.error('Could not update title');
        this.cancelEditTitle();
      },
    });
  }

  cancelEditTitle() {
    this.editingTitleId.set(null);
  }

  onContentInput(event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    this.autoResizeTextarea(textarea);
  }

  onContentChange(sectionId: number, event: Event) {
    const textarea = event.target as HTMLTextAreaElement;
    const content = textarea.value;
    
    this.savingSectionId.set(sectionId);

    this.scratchpadService.updateSection(sectionId, { content }).subscribe({
      next: (updated) => {
        this.sections.update(list => 
          list.map(s => s.id === sectionId ? updated : s)
        );
        this.savingSectionId.set(null);
      },
      error: () => {
        toast.error('Could not save');
        this.savingSectionId.set(null);
      },
    });
  }

  addSection() {
    const name = `Section ${this.sections().length + 1}`;
    this.scratchpadService.createSection(this.projectId(), name).subscribe({
      next: (section) => {
        this.sections.update(list => [...list, section]);
        this.expandedSectionId.set(section.id);
        // Resize after adding section
        this.onSectionExpanded();
        setTimeout(() => this.startEditTitle(section.id, section.name));
        toast.success('Section added');
      },
      error: () => {
        toast.error('Could not add section');
      },
    });
  }

  onDeleteSection(event: Event, sectionId: number) {
    event.stopPropagation();
    this.showDeleteDialog.set(sectionId);
    setTimeout(() => this.deleteDialogRef()?.open());
  }

  closeDeleteDialog() {
    this.deleteDialogRef()?.close();
    this.showDeleteDialog.set(null);
  }

  deleteSection() {
    const sectionId = this.showDeleteDialog();
    if (!sectionId) return;

    this.scratchpadService.deleteSection(sectionId).subscribe({
      next: () => {
        this.sections.update(list => list.filter(s => s.id !== sectionId));
        if (this.expandedSectionId() === sectionId) {
          const remaining = this.sections();
          this.expandedSectionId.set(remaining.length > 0 ? remaining[0].id : null);
          // Resize after deleting
          this.onSectionExpanded();
        }
        toast.success('Section deleted');
        this.closeDeleteDialog();
      },
      error: () => {
        toast.error('Could not delete section');
      },
    });
  }

  onClose() {
    this.close.emit();
  }
}
