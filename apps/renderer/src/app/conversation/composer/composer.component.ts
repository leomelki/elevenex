import { OverlayModule } from "@angular/cdk/overlay";
import { elementMarker, elementMarkersIn, MAX_BROWSER_ELEMENTS } from "@elevenex/shared";
import { SESSION_DRAG_TYPE, readSessionDrag } from '../../tasks';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  model,
  output,
  signal,
  viewChild,
  ElementRef,
  type OnChanges,
} from "@angular/core";
import {
  AutoHeightDirective,
  ButtonComponent,
  IconButtonComponent,
  IconComponent,
  PresenceComponent,
} from "../../ui";
import type {
  AgentConfig,
  AgentHarness,
  ComposerSubmission,
  ConversationMention,
  ConversationAttachment,
  ConversationMode,
  McpServer,
  PermissionChoice,
  QueuedMessage,
  WaitingMessage,
  RecordingState,
} from "../conversation.models";
import { AgentPickerComponent } from "./agent-picker.component";
import { ComposerQueueComponent } from "./composer-queue.component";
import { MentionComponent } from "./mention.component";
import { MentionMenuComponent } from "./mention-menu.component";
import { ModeToggleComponent } from "./mode-toggle.component";
import { PermissionPickerComponent } from "./permission-picker.component";
import { AttachmentsComponent } from "../chat/attachments.component";
import { ElementChipComponent } from "../element/element-chip.component";
import { elementPlace } from "../element/element-geometry";
import { ToolsMenuComponent } from "./tools-menu.component";
@Component({
  selector: "ex-composer",
  imports: [
    OverlayModule,
    AutoHeightDirective,
    PresenceComponent,
    ButtonComponent,
    IconButtonComponent,
    IconComponent,
    AgentPickerComponent,
    ComposerQueueComponent,
    MentionComponent,
    MentionMenuComponent,
    ModeToggleComponent,
    PermissionPickerComponent,
    ToolsMenuComponent,
    AttachmentsComponent,
    ElementChipComponent,
  ],
  templateUrl: "./composer.component.html",
  styleUrl: "./composer.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(dragover)": "dragOver($event)",
    "(dragenter)": "dragOver($event)",
    "(document:dragend)": "dropping.set(null)",
    "(dragleave)": "dragLeave($event)",
    "(drop)": "drop($event)",
    "(paste)": "paste($event)",
  },
})
export class ComposerComponent implements OnChanges {
  private readonly destroy = inject(DestroyRef);
  private readonly sendAnimations = new Set<Animation>();
  readonly wordsLeaving = signal(false);
  readonly sendButton = viewChild<unknown, ElementRef<HTMLButtonElement>>("sendButton", { read: ElementRef });
  readonly draft = model("");

  constructor() {
    this.destroy.onDestroy(() => {
      for (const animation of this.sendAnimations) animation.cancel();
      this.sendAnimations.clear();
    });
  }
  readonly mode = input<ConversationMode>("code");
  readonly agent = input<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly hideAgent = input(false);
  readonly agentLocked = input(true);
  readonly settingsDisabled = input(false);
  readonly settingsBusy = input(false);
  readonly modeAvailable = input(true);
  readonly showFork = input(true);
  readonly showSavePreset = input(true);
  readonly reasoningAvailable = input(true);
  readonly fastAvailable = input(true);
  readonly canCompact = input(false);
  readonly showSettings = input(true);
  readonly showTools = input(true);
  readonly attachmentsEnabled = input(false);
  readonly attachments = input<readonly ConversationAttachment[]>([]);
  /** Pick again from a staged element's snapshot. */
  readonly elementRepick = output<NonNullable<ConversationAttachment["element"]>>();
  /** Offers the ⌖ button and the @ menu command for pointing at a browser element. */
  readonly elementPickAvailable = input(false);
  readonly elementPickRequested = output<void>();
  readonly attachmentRemoved = output<string>();
  readonly attachmentRetry = output<string>();
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>("fileInput");
  chooseFiles(): void {
    if (!this.disabled() && !this.sending())
      this.fileInput()?.nativeElement.click();
  }
  filesChosen(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length && !this.disabled() && !this.sending())
      this.filesAttached.emit(files);
    this.textarea()?.nativeElement.focus();
  }
  canSend(): boolean {
    return (
      (!!this.draft().trim() || !!this.attachments().length) &&
      this.attachments().every((file) => file.status === "ready")
    );
  }
  readonly showDictation = input(true);
  readonly mentionsEnabled = input(true);
  /** Drops must belong to the same connected backend generation. */
  readonly sessionMentionScope = input<string>();
  readonly waitingFor = input<string>();
  readonly waitingAction = input('Try now');
  readonly waitingNoun = computed(() => this.waiting().length && this.waiting().every(item => item.kind === 'message') ? 'message' : 'action');
  readonly waiting = input<readonly WaitingMessage[]>([]);
  readonly waitingRemoved = output<string>();
  readonly waitingEdited = output<QueuedMessage>();
  readonly waitingEditing = output<string | null>();
  readonly reconnectRequested = output<void>();
  readonly waitingSending = computed(() => this.waiting().some(item => item.state === 'sending'));
  readonly queueEditable = input(true);
  readonly queueReorderable = input(true);
  readonly permission = input<string>("ask");
  readonly permissionChoices = input<readonly PermissionChoice[]>();
  readonly servers = input<readonly McpServer[]>([]);
  readonly context = input<readonly ConversationMention[]>([]);
  readonly queue = input<readonly QueuedMessage[]>([]);
  readonly mentionItems = input<readonly ConversationMention[]>([]);
  /** Element snapshots read as chips in the context row; other files keep their tiles. */
  readonly elementFiles = computed(() =>
    this.attachments()
      .filter((file) => file.element && file.marker)
      .sort((a, b) => (a.marker ?? 0) - (b.marker ?? 0)),
  );
  readonly otherFiles = computed(() => this.attachments().filter((file) => !file.element));
  readonly referencedMarkers = computed(() => new Set(elementMarkersIn(this.draft())));
  /** The pin whose chip has pointer or focus; its markers light up in the prose. */
  readonly hotMarker = signal<number | null>(null);
  readonly allMentionItems = computed<readonly ConversationMention[]>(() => [
    ...this.elementFiles().map((file) => ({
      id: file.element!.id,
      kind: "element" as const,
      label: file.element!.label,
      marker: file.marker,
      meta: elementPlace(file.element!.page),
    })),
    ...this.mentionItems(),
  ]);
  /**
   * Paints a soft mark behind each pin character, positioned exactly by
   * mirroring the textarea's text. Only rendered while the draft holds a pin.
   */
  readonly markerHighlights = computed(() => {
    const draft = this.draft();
    if (!this.elementFiles().length || !elementMarkersIn(draft).length) return null;
    const known = new Set(this.elementFiles().map((file) => file.marker));
    const parts: { text: string; marker?: number; known?: boolean }[] = [];
    let run = "";
    for (const char of draft) {
      const marker = elementMarkersIn(char)[0];
      if (!marker) {
        run += char;
        continue;
      }
      if (run) parts.push({ text: run });
      run = "";
      parts.push({ text: char, marker, known: known.has(marker) });
    }
    // A trailing newline needs content after it to occupy a line, like the textarea.
    parts.push({ text: run + "\u200b" });
    return parts;
  });
  readonly highlightScroll = signal(0);
  /** Inserts a pin at the caret, spaced from neighbouring words. */
  insertElement(marker: number): void {
    const glyph = elementMarker(marker);
    if (!glyph || this.disabled() || this.sending()) return;
    const element = this.textarea()?.nativeElement;
    const draft = this.draft();
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? draft.length;
    this.replaceRange(start, end, glyph);
    this.dropAnnouncement.set(`Pin ${marker} added to your message.`);
  }
  /** Removing a chip also removes its pins, so no marker is left pointing at nothing. */
  removeElement(file: ConversationAttachment): void {
    const glyph = file.marker ? elementMarker(file.marker) : "";
    if (glyph && this.draft().includes(glyph)) {
      // Keep one space where the pin sat between two words.
      const draft = this.draft().replace(new RegExp(`( ?)${glyph}( ?)`, "g"), (_, lead: string, trail: string) => (lead && trail ? " " : ""));
      this.draft.set(draft);
      const element = this.textarea()?.nativeElement;
      if (element) element.value = draft;
    }
    this.hotMarker.set(null);
    this.attachmentRemoved.emit(file.id);
    this.textarea()?.nativeElement.focus({ preventScroll: true });
  }
  requestElementPick(): void {
    if (!this.elementPickAvailable() || this.disabled() || this.sending()) return;
    if (this.elementFiles().length >= MAX_BROWSER_ELEMENTS) {
      this.dropAnnouncement.set(`You can point at up to ${MAX_BROWSER_ELEMENTS} elements in a message.`);
      return;
    }
    this.elementPickRequested.emit();
  }
  /** The @ menu command consumes its query, then starts a pick. */
  pickFromMentions(): void {
    const element = this.textarea()?.nativeElement;
    const before = this.draft().slice(0, element?.selectionStart ?? 0);
    const query = /(?:^|\s)@[^\s@]*$/.exec(before);
    if (element && query) {
      const start = before.lastIndexOf("@");
      this.replaceRange(start, element.selectionEnd, "", false);
    }
    this.mentionQuery.set(null);
    this.requestElementPick();
  }
  private replaceRange(start: number, end: number, token: string, spaced = true): void {
    const draft = this.draft();
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const lead = spaced && before && !/\s$/.test(before) ? " " : "";
    const trail = spaced && !/^\s/.test(after) ? " " : "";
    const inserted = before + lead + token + trail;
    const next = inserted + after;
    this.draft.set(next);
    const element = this.textarea()?.nativeElement;
    if (element) {
      // Set the value before the selection: a later binding would move the caret.
      element.value = next;
      element.setSelectionRange(inserted.length, inserted.length);
      element.focus({ preventScroll: true });
    }
  }
  readonly running = input(false);
  readonly disabled = input(false);
  readonly sending = input(false);
  readonly clearOnSubmit = input(true);
  readonly stoppable = input(true);
  readonly recording = input<RecordingState | false>(false);
  readonly placeholder = input("Ask anything, or @ to mention");
  readonly dropping = signal<'session' | 'files' | null>(null);
  readonly dropAnnouncement = signal('');
  readonly mentionQuery = signal<string | null>(null);
  readonly submitted = output<ComposerSubmission>();
  readonly stop = output<void>();
  readonly modeChanged = output<ConversationMode>();
  readonly agentChanged = output<AgentConfig>();
  readonly permissionChanged = output<string>();
  readonly attach = output<void>();
  readonly filesAttached = output<readonly File[]>();
  readonly mentionInserted = output<ConversationMention>();
  readonly contextRemoved = output<string>();
  readonly dictate = output<void>();
  readonly recordingKept = output<void>();
  readonly recordingDiscarded = output<void>();
  readonly serverChanged = output<{ id: string; on: boolean }>();
  readonly manageServers = output<void>();
  readonly queueSteer = output<string>();
  readonly queueRemove = output<string>();
  readonly queueEdited = output<QueuedMessage>();
  readonly queueReordered = output<readonly string[]>();
  readonly focusLastMessage = output<void>();
  readonly forkAgent = output<void>();
  readonly savePreset = output<AgentConfig>();
  readonly compactRequested = output<void>();
  readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>("textarea");
  readonly agentPicker = viewChild(AgentPickerComponent);
  readonly mentions = viewChild(MentionMenuComponent);
  ngOnChanges(): void {
    if (this.disabled() || this.sending() || !this.mentionsEnabled()) this.mentionQuery.set(null);
    if (this.disabled() || this.sending() || (!this.mentionsEnabled() && this.dropping() === 'session')) this.dropping.set(null);
  }
  update(event: Event): void {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    this.wordsLeaving.set(false);
    this.draft.set(event.target.value);
    const before = event.target.value.slice(0, event.target.selectionStart);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    this.mentionQuery.set(this.mentionsEnabled() ? (match?.[1] ?? null) : null);
  }
  send(steer = false): void {
    const text = this.draft().trim();
    if (
      !this.canSend() ||
      this.disabled() ||
      this.sending() ||
      this.recording()
    )
      return;
    const textarea = this.textarea()?.nativeElement;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const intent = this.waitingFor() ? "queue" : this.running() ? (steer ? "steer" : "queue") : "send";
    // A textarea has no text Range. Its content origin includes padding and its
    // internal scroll offset; long/scrolled drafts use the message rise instead.
    const rect = textarea?.getBoundingClientRect();
    const style = textarea ? getComputedStyle(textarea) : undefined;
    const sendOrigin = intent === "send" && text && rect && style && !textarea?.scrollTop
      ? { left: rect.left + parseFloat(style.paddingLeft), top: rect.top + parseFloat(style.paddingTop), at: performance.now() }
      : undefined;
    if (!reduced) {
      const button = this.sendButton()?.nativeElement;
      if (button?.animate) {
        this.animateSend(button, [{ transform: "scale(.86)" }, { transform: "scale(1)" }], 320, style?.getPropertyValue("--ease-spring").trim() || "ease-out");
        const icon = button.querySelector("ex-icon");
        if (icon) this.animateSend(icon, [{ transform: "none" }, { transform: "translateY(-4px)", offset: .35 }, { transform: "none" }], 300, style?.getPropertyValue("--ease-out").trim() || "ease-out");
      }
    }
    this.wordsLeaving.set(!reduced);
    this.submitted.emit({
      ...(sendOrigin ? { sendOrigin } : {}),
      text,
      intent,
      context: this.context(),
    });
    if (this.clearOnSubmit()) this.draft.set("");
    this.mentionQuery.set(null);
    this.textarea()?.nativeElement.focus({ preventScroll: true });
  }
  private animateSend(element: Element, frames: Keyframe[], duration: number, easing: string): void {
    // Repeated sends restart the small press feedback and release old effects.
    for (const previous of this.sendAnimations) {
      if (previous.effect instanceof KeyframeEffect && previous.effect.target === element) previous.cancel();
    }
    const animation = element.animate(frames, { duration, easing });
    this.sendAnimations.add(animation);
    const done = () => this.sendAnimations.delete(animation);
    animation.onfinish = done;
    animation.oncancel = done;
  }
  insertMention(mention: ConversationMention, source: 'picker' | 'drop' = 'picker'): void {
    if (!this.mentionsEnabled() || this.disabled() || this.sending()) return;
    if (mention.kind === 'element') {
      const element = this.textarea()?.nativeElement;
      const before = this.draft().slice(0, element?.selectionStart ?? 0);
      const query = /(?:^|\s)@[^\s@]*$/.exec(before);
      const start = query ? before.lastIndexOf('@') : (element?.selectionStart ?? this.draft().length);
      this.replaceRange(start, element?.selectionEnd ?? this.draft().length, elementMarker(mention.marker ?? 0));
      this.mentionQuery.set(null);
      return;
    }
    const duplicate = mention.kind === 'session' && this.context().some(item => item.kind === mention.kind && item.id === mention.id);
    if (!duplicate && mention.kind === 'session' && this.context().filter(item => item.kind === 'session').length >= 8) {
      this.dropAnnouncement.set('You can mention up to 8 sessions in a message.'); return;
    }
    const element = this.textarea()?.nativeElement;
    if (element) {
      const before = this.draft().slice(0, element.selectionStart);
      const after = this.draft().slice(element.selectionEnd);
      const query = /(?:^|\s)@[^\s@]*$/.exec(before);
      // Session context lives only in its controlled chip. A picker consumes its
      // active query; a drop never rewrites the draft or the selected text.
      if (mention.kind !== 'session' || (source === 'picker' && this.mentionQuery() !== null && query)) {
        const prefix = query
          ? before.slice(0, before.lastIndexOf("@"))
          : before + (before && !/\s$/.test(before) ? " " : "");
        const inserted = mention.kind === 'session' ? prefix : `${prefix}@${mention.label} `;
        const draft = inserted + after;
        this.draft.set(draft);
        // Set the value before the selection: a later binding would move the caret.
        element.value = draft;
        element.setSelectionRange(inserted.length, inserted.length);
      }
      element.focus({ preventScroll: true });
    }
    if (!duplicate) this.mentionInserted.emit(mention);
    this.dropAnnouncement.set(duplicate ? `${mention.label} is already mentioned.` : `Added ${mention.label} to message context.`);
    this.mentionQuery.set(null);
  }
  openMentions(): void {
    this.mentionQuery.set("");
    this.textarea()?.nativeElement.focus();
  }
  onKey(event: KeyboardEvent): void {
    if (event.isComposing || this.disabled()) return;
    if (
      this.mentionQuery() !== null &&
      ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
    ) {
      this.mentions()?.onKey(event);
      return;
    }
    if (
      this.showSettings() &&
      this.modeAvailable() &&
      !this.settingsDisabled() &&
      !this.settingsBusy() &&
      event.shiftKey &&
      event.key === "Tab"
    ) {
      event.preventDefault();
      this.modeChanged.emit(this.mode() === "plan" ? "code" : "plan");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
      event.preventDefault();
      this.agentPicker()?.openPicker();
      return;
    }
    if (
      (this.showTools() || this.attachmentsEnabled()) &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "u"
    ) {
      event.preventDefault();
      if (this.attachmentsEnabled()) this.chooseFiles();
      else this.attach.emit();
      return;
    }
    if (
      this.showDictation() &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "d"
    ) {
      event.preventDefault();
      this.dictate.emit();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "." &&
      this.running() &&
      this.stoppable()
    ) {
      event.preventDefault();
      this.stop.emit();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.send(event.altKey);
    }
    if (
      event.key === "ArrowUp" &&
      !this.draft() &&
      !this.attachments().length
    ) {
      event.preventDefault();
      this.focusLastMessage.emit();
    }
  }
  dragOver(event: DragEvent): void {
    if (event.defaultPrevented) return;
    if (this.mentionsEnabled() && event.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = this.disabled() || this.sending() ? 'none' : 'copy';
      this.dropping.set(this.disabled() || this.sending() ? null : 'session');
      return;
    }
    if (
      (!this.showTools() && !this.attachmentsEnabled()) ||
      !event.dataTransfer?.types.includes("Files") ||
      this.disabled() ||
      this.sending()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    this.dropping.set('files');
    event.dataTransfer.dropEffect = "copy";
  }
  dragLeave(event: DragEvent): void {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    this.dropping.set(null);
  }
  drop(event: DragEvent): void {
    this.dropping.set(null);
    if (event.defaultPrevented) return;
    if (event.dataTransfer?.types.includes(SESSION_DRAG_TYPE)) {
      event.preventDefault();
      event.stopPropagation();
      if (!this.mentionsEnabled() || this.disabled() || this.sending()) return;
      const reference = readSessionDrag(event.dataTransfer, this.sessionMentionScope());
      if (!reference) { this.dropAnnouncement.set('This session cannot be mentioned here.'); return; }
      this.insertMention(this.mentionItems().find(item => item.kind === 'session' && item.id === reference.id)
        ?? { id: reference.id, kind: 'session', label: reference.title }, 'drop');
      return;
    }
    if (
      (!this.showTools() && !this.attachmentsEnabled()) ||
      !event.dataTransfer?.files.length ||
      this.disabled() ||
      this.sending()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const entries = Array.from(event.dataTransfer.items ?? []);
    if (entries.some((item) => item.webkitGetAsEntry?.()?.isDirectory)) return;
    this.filesAttached.emit(Array.from(event.dataTransfer.files));
  }
  paste(event: ClipboardEvent): void {
    if (
      (!this.showTools() && !this.attachmentsEnabled()) ||
      !event.clipboardData?.files.length ||
      this.disabled() ||
      this.sending()
    )
      return;
    event.preventDefault();
    this.filesAttached.emit(Array.from(event.clipboardData.files));
  }
}
