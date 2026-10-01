import { ZardButtonComponent } from '@/shared/components/button';
import { AgentAutocompleteItem, AgentPendingPrompt } from '@/shared/models/agent-runtime.model';
import type { DiffSelectionMention } from '@/shared/models/diff-selection-mention.model';
import type {
  SessionMention,
  SessionMentionCandidate,
} from '@/shared/models/session-mention.model';
import { SESSION_MENTION_DRAG_TYPE } from '@/shared/models/session-mention.model';
import { DictateTargetDirective } from '@/shared/speech/dictate-target.directive';
import { DictationButtonComponent } from '@/shared/speech/dictation-button.component';
import {
  diffSelectionMentionLineLabel,
  diffSelectionMentionPreview,
  parseDiffSelectionMentions,
} from '@/shared/utils/diff-selection-mention';
import { splitFilePathForDisplay } from '@/shared/utils/file-path-display';
import { parseSessionMentions } from '@/shared/utils/session-mention';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideLoaderCircle,
  lucideMessageSquare,
  lucidePaperclip,
  lucidePlay,
  lucideSend,
  lucideSquare,
  lucideTrash2,
  lucideX,
} from '@ng-icons/lucide';
import { toast } from 'ngx-sonner';
import { ComposerMentionComponent } from './composer-mention.component';

interface Range {
  start: number;
  end: number;
}

export type ComposerImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ComposerImageAttachment {
  id: string;
  name: string;
  mediaType: ComposerImageMediaType;
  dataUrl: string;
  size: number;
}

export interface ComposerSendPayload {
  text: string;
  images: ComposerImageAttachment[];
  diffMentions?: DiffSelectionMention[];
  sessionMentions?: SessionMention[];
}

type ComposerAutocompleteOption =
  | { type: 'provider'; item: AgentAutocompleteItem }
  | { type: 'session'; item: SessionMentionCandidate };

const COMPOSER_IMAGE_ALLOWED_MIME: readonly ComposerImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];
const COMPOSER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const COMPOSER_IMAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

@Component({
  selector: 'cw-composer',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NgIcon,
    DictateTargetDirective,
    DictationButtonComponent,
    ZardButtonComponent,
    ComposerMentionComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block relative',
    '(document:mousedown)': 'onDocumentMousedown($event)',
  },
  viewProviders: [
    provideIcons({
      lucideLoaderCircle,
      lucideMessageSquare,
      lucidePaperclip,
      lucidePlay,
      lucideSend,
      lucideSquare,
      lucideTrash2,
      lucideX,
    }),
  ],
  templateUrl: './claude-composer.component.html',
})
export class ClaudeComposerComponent {
  @ViewChild('input', { static: true }) private ta!: ElementRef<HTMLTextAreaElement>;
  @ViewChild('fileInput', { static: true })
  private fileInput!: ElementRef<HTMLInputElement>;
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly value = input<string>('');
  readonly submitting = input<boolean>(false);
  readonly running = input<boolean>(false);
  readonly canInterrupt = input<boolean>(false);
  readonly blockedByPermission = input<boolean>(false);
  readonly sendDisabledReason = input<string>('');
  readonly attachedPanelOpen = input<boolean>(false);
  readonly allowImages = input<boolean>(true);
  readonly autocompleteItems = input<AgentAutocompleteItem[]>([]);
  readonly sessionMentionCandidates = input<SessionMentionCandidate[]>([]);
  readonly sessionMentions = input<SessionMention[]>([]);
  readonly loadingSessionMention = input<boolean>(false);
  readonly placeholderText = input<string>('Tell Claude what to do…');
  readonly pendingPrompts = input<AgentPendingPrompt[]>([]);
  readonly queuePaused = input<boolean>(false);
  readonly disconnected = input<boolean>(false);
  readonly diffMentions = input<DiffSelectionMention[]>([]);
  readonly imageAttachments = model<ComposerImageAttachment[]>([]);
  // Count of backgrounded subagents/tasks still executing for this session.
  // The main turn can be idle while these run, but a submitted message will
  // still be queued behind them, so the composer must reflect that.
  readonly backgroundAgentCount = input<number>(0);
  /** Dictation context: biases transcription towards this repo's vocabulary. */
  readonly sessionId = input<number | null>(null);
  readonly worktreePath = input<string | null>(null);

  readonly queueing = computed(
    () => this.running() || this.backgroundAgentCount() > 0 || this.pendingPrompts().length > 0,
  );

  readonly send = output<ComposerSendPayload>();
  readonly valueChange = output<string>();
  readonly interrupt = output<void>();
  readonly cancelPending = output<string>();
  readonly steerPending = output<string>();
  readonly resumePending = output<void>();
  readonly clearPending = output<void>();
  readonly removeDiffMention = output<string>();
  readonly requestSessionMention = output<number>();
  readonly removeSessionMention = output<number>();

  readonly attachedImages = this.imageAttachments;
  readonly isDropTarget = signal(false);
  readonly clearPendingArmed = signal(false);
  private dragDepth = 0;

  requestClearPending(): void {
    if (!this.clearPendingArmed()) {
      this.clearPendingArmed.set(true);
      return;
    }
    this.clearPendingArmed.set(false);
    this.clearPending.emit();
  }

  readonly activeTrigger = signal<'/' | '$' | '@' | null>(null);
  readonly activeQuery = signal('');
  readonly autocompleteOpen = signal(false);
  readonly selectedIndex = signal(0);
  private range: Range | null = null;

  readonly filtered = computed(() => {
    const trigger = this.activeTrigger();
    if (!trigger) return [];
    const q = this.activeQuery().toLowerCase();
    if (trigger === '@') {
      const attached = new Set(this.sessionMentions().map((mention) => mention.sessionId));
      return this.sessionMentionCandidates()
        .filter((item) => !attached.has(item.sessionId))
        .map((item) => ({ item, score: scoreSession(item, q) }))
        .filter((entry) => entry.score > Number.NEGATIVE_INFINITY)
        .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
        .map(({ item }): ComposerAutocompleteOption => ({ type: 'session', item }))
        .slice(0, 10);
    }
    return this.autocompleteItems()
      .filter((i) => i.trigger === trigger)
      .map((i) => ({ i, score: score(i, q) }))
      .filter((x) => x.score > Number.NEGATIVE_INFINITY)
      .sort((a, b) => b.score - a.score || a.i.label.localeCompare(b.i.label))
      .map(({ i }): ComposerAutocompleteOption => ({ type: 'provider', item: i }))
      .slice(0, 10);
  });

  readonly placeholder = computed(() => this.placeholderText());

  constructor() {
    effect(() => {
      const nextValue = this.value();
      queueMicrotask(() => {
        const ta = this.ta?.nativeElement;
        if (!ta) return;
        if (ta.value !== nextValue) ta.value = nextValue;
        this.autoGrow(ta);
      });
    });
    effect(() => {
      if (!this.allowImages() && (this.attachedImages().length || this.imageAttachments().length)) {
        this.setAttachedImages([]);
      }
    });
  }

  onInput(e: Event): void {
    const ta = e.target as HTMLTextAreaElement;
    this.valueChange.emit(ta.value);
    this.autoGrow(ta);
    this.refreshAc(ta);
  }

  onKeydown(e: KeyboardEvent): void {
    if (e.isComposing) return;

    const ac = this.autocompleteOpen() && this.filtered().length;
    if (ac) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.selectedIndex.update((i) => (i + 1) % this.filtered().length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const len = this.filtered().length;
        this.selectedIndex.update((i) => (i - 1 + len) % len);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.apply(this.filtered()[this.selectedIndex()]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.submit();
    }
  }

  refreshAc(ta: HTMLTextAreaElement): void {
    const caret = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, caret);
    const m = before.match(/(^|\s)([/$@])([^\s]*)$/);
    if (!m) {
      this.close();
      return;
    }
    const trigger = m[2] as '/' | '$' | '@';
    const query = m[3] ?? '';
    const tokenStart = caret - (query.length + 1);
    const trailing = ta.value.slice(caret).match(/^[^\s]*/)?.[0] ?? '';
    this.range = { start: tokenStart, end: caret + trailing.length };
    this.activeTrigger.set(trigger);
    this.activeQuery.set(query);
    this.autocompleteOpen.set(true);
    this.selectedIndex.set(0);
    if (!this.filtered().length) this.close();
  }

  autocompleteOptionId(option: ComposerAutocompleteOption): string {
    return option.type === 'session'
      ? `session:${option.item.sessionId}`
      : `provider:${option.item.id}`;
  }

  apply(option: ComposerAutocompleteOption | undefined): void {
    const ta = this.ta.nativeElement;
    if (!ta || !option || !this.range) return;
    const { start, end } = this.range;
    const insertText = option.type === 'provider' ? option.item.insertText : '';
    const next = `${ta.value.slice(0, start)}${insertText}${ta.value.slice(end)}`;
    const caret = start + insertText.length;
    this.valueChange.emit(next);
    if (option.type === 'session') this.requestSessionMention.emit(option.item.sessionId);
    this.close();
    queueMicrotask(() => {
      ta.value = next;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      this.autoGrow(ta);
    });
  }

  submit(): void {
    const v = this.value().trim();
    const images = this.allowImages() ? this.attachedImages() : [];
    const diffMentions = this.diffMentions();
    const sessionMentions = this.sessionMentions();
    if (!v && !images.length && !diffMentions.length && !sessionMentions.length) return;
    if (this.disconnected() || this.blockedByPermission() || this.sendDisabledReason()) return;
    if (this.submitting() && !this.queueing()) return;
    this.send.emit({
      text: v,
      images,
      diffMentions,
      ...(sessionMentions.length ? { sessionMentions } : {}),
    });
    this.setAttachedImages([]);
  }

  mentionLineLabel(mention: DiffSelectionMention): string {
    return diffSelectionMentionLineLabel(mention);
  }

  mentionDirname(mention: DiffSelectionMention): string {
    return splitFilePathForDisplay(mention.filePath).dirname;
  }

  mentionBasename(mention: DiffSelectionMention): string {
    return splitFilePathForDisplay(mention.filePath).basename;
  }

  mentionPreview(mention: DiffSelectionMention): string {
    return diffSelectionMentionPreview(mention);
  }

  pendingPromptPreview(prompt: string): string {
    const sessions = parseSessionMentions(prompt);
    const parsed = parseDiffSelectionMentions(sessions.text);
    const text =
      parsed.text ||
      (sessions.mentions.length
        ? 'Use the mentioned session context.'
        : parsed.mentions.length
          ? 'Review the mentioned diff selection.'
          : prompt);
    const labels: string[] = [];
    if (sessions.mentions.length) {
      labels.push(
        `${sessions.mentions.length} session mention${sessions.mentions.length === 1 ? '' : 's'}`,
      );
    }
    if (parsed.mentions.length) {
      labels.push(
        `${parsed.mentions.length} diff mention${parsed.mentions.length === 1 ? '' : 's'}`,
      );
    }
    return labels.length ? `${text} · ${labels.join(' · ')}` : text;
  }

  removeImage(id: string): void {
    this.setAttachedImages(this.attachedImages().filter((i) => i.id !== id));
  }

  openFilePicker(): void {
    if (!this.allowImages()) return;
    this.fileInput?.nativeElement?.click();
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!this.allowImages()) {
      input.value = '';
      return;
    }
    const files = input.files;
    if (files && files.length) {
      void this.ingestFiles(Array.from(files));
    }
    input.value = '';
  }

  onPaste(event: ClipboardEvent): void {
    if (!this.allowImages()) return;
    const items = event.clipboardData?.items;
    if (!items || !items.length) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    void this.ingestFiles(files);
  }

  onDragEnter(event: DragEvent): void {
    if (!this.hasSupportedDropData(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.isDropTarget.set(true);
  }

  onDragOver(event: DragEvent): void {
    if (!this.hasSupportedDropData(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  onDragLeave(event: DragEvent): void {
    if (!this.isDropTarget()) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.isDropTarget.set(false);
  }

  onDrop(event: DragEvent): void {
    if (!this.hasSupportedDropData(event)) return;
    event.preventDefault();
    this.dragDepth = 0;
    this.isDropTarget.set(false);
    const sessionId = Number(event.dataTransfer?.getData(SESSION_MENTION_DRAG_TYPE));
    if (Number.isInteger(sessionId) && sessionId > 0) {
      this.requestSessionMention.emit(sessionId);
      return;
    }
    if (!this.allowImages()) return;
    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    void this.ingestFiles(imageFiles);
  }

  private hasSupportedDropData(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === SESSION_MENTION_DRAG_TYPE) return true;
    }
    return this.allowImages() && this.hasImageData(event);
  }

  private hasImageData(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  private async ingestFiles(files: File[]): Promise<void> {
    if (!this.allowImages()) return;
    const existingTotal = this.attachedImages().reduce((sum, i) => sum + i.size, 0);
    let runningTotal = existingTotal;
    const accepted: ComposerImageAttachment[] = [];
    for (const file of files) {
      const mediaType = file.type as ComposerImageMediaType;
      if (!COMPOSER_IMAGE_ALLOWED_MIME.includes(mediaType)) {
        toast.error(`Unsupported image type: ${file.type || 'unknown'}.`);
        continue;
      }
      if (file.size > COMPOSER_IMAGE_MAX_BYTES) {
        toast.error(`${file.name || 'Image'} is larger than 5 MB.`);
        continue;
      }
      if (runningTotal + file.size > COMPOSER_IMAGE_MAX_TOTAL_BYTES) {
        toast.error('Attached images would exceed the 20 MB total limit.');
        break;
      }
      try {
        const dataUrl = await this.readFileAsDataUrl(file);
        accepted.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || 'pasted-image',
          mediaType,
          dataUrl,
          size: file.size,
        });
        runningTotal += file.size;
      } catch {
        toast.error(`Could not read ${file.name || 'image'}.`);
      }
    }
    if (accepted.length) {
      this.setAttachedImages([...this.attachedImages(), ...accepted]);
    }
  }

  private setAttachedImages(images: ComposerImageAttachment[]): void {
    this.attachedImages.set(images);
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
      reader.onload = () => {
        const result = reader.result;
        if (typeof result === 'string') resolve(result);
        else reject(new Error('Unexpected FileReader result'));
      };
      reader.readAsDataURL(file);
    });
  }

  focus(): void {
    this.ta.nativeElement?.focus();
  }

  focusAtEnd(): void {
    queueMicrotask(() => {
      const textarea = this.ta.nativeElement;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      this.autoGrow(textarea);
    });
  }

  private autoGrow(ta: HTMLTextAreaElement): void {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 256) + 'px';
  }

  private close(): void {
    this.range = null;
    this.autocompleteOpen.set(false);
    this.activeTrigger.set(null);
    this.activeQuery.set('');
    this.selectedIndex.set(0);
  }

  onDocumentMousedown(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (
      this.clearPendingArmed() &&
      (!(target instanceof Element) || !target.closest('.cw-comp__pending-action--confirm'))
    ) {
      this.clearPendingArmed.set(false);
    }
    if (!this.autocompleteOpen()) return;
    if (target && this.host.nativeElement.contains(target)) return;
    this.close();
  }
}

function score(item: AgentAutocompleteItem, query: string): number {
  if (!query) return item.source === 'builtin' ? 200 : 100;
  const label = item.label.toLowerCase();
  if (label === `${item.trigger}${query}`) return 500;
  if (label.startsWith(`${item.trigger}${query}`)) return 400;
  if (label.includes(query)) return 300;
  if ((item.description || '').toLowerCase().includes(query)) return 200;
  return Number.NEGATIVE_INFINITY;
}

function scoreSession(item: SessionMentionCandidate, query: string): number {
  if (!query) return item.status === 'active' ? 250 : 150;
  const title = item.title.toLowerCase();
  const branch = item.branch.toLowerCase();
  if (`${item.sessionId}` === query) return 600;
  if (title === query) return 500;
  if (title.startsWith(query)) return 400;
  if (title.includes(query)) return 300;
  if (branch.includes(query)) return 200;
  return Number.NEGATIVE_INFINITY;
}
