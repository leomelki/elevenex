import { OverlayModule } from "@angular/cdk/overlay";
import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
  signal,
  viewChild,
  type ElementRef,
} from "@angular/core";
import { ButtonComponent, IconButtonComponent, IconComponent } from "../../ui";
import type {
  AgentConfig,
  AgentHarness,
  ComposerSubmission,
  ConversationMention,
  ConversationMode,
  McpServer,
  PermissionLevel,
  QueuedMessage,
  RecordingState,
} from "../conversation.models";
import { AgentPickerComponent } from "./agent-picker.component";
import { ComposerQueueComponent } from "./composer-queue.component";
import { MentionComponent } from "./mention.component";
import { MentionMenuComponent } from "./mention-menu.component";
import { ModeToggleComponent } from "./mode-toggle.component";
import { PermissionPickerComponent } from "./permission-picker.component";
import { ToolsMenuComponent } from "./tools-menu.component";
@Component({
  selector: "ex-composer",
  imports: [
    OverlayModule,
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
  ],
  templateUrl: "./composer.component.html",
  styleUrl: "./composer.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "(dragover)": "dragOver($event)",
    "(dragleave)": "dragLeave($event)",
    "(drop)": "drop($event)",
    "(paste)": "paste($event)",
  },
})
export class ComposerComponent {
  readonly draft = model("");
  readonly mode = input<ConversationMode>("code");
  readonly agent = input<AgentConfig>();
  readonly harnesses = input<readonly AgentHarness[]>([]);
  readonly hideAgent = input(false);
  readonly permission = input<PermissionLevel>("ask");
  readonly servers = input<readonly McpServer[]>([]);
  readonly context = input<readonly ConversationMention[]>([]);
  readonly queue = input<readonly QueuedMessage[]>([]);
  readonly mentionItems = input<readonly ConversationMention[]>([]);
  readonly running = input(false);
  readonly disabled = input(false);
  readonly recording = input<RecordingState | false>(false);
  readonly placeholder = input("Ask anything, or @ to mention");
  readonly dropping = signal(false);
  readonly mentionQuery = signal<string | null>(null);
  readonly submitted = output<ComposerSubmission>();
  readonly stop = output<void>();
  readonly modeChanged = output<ConversationMode>();
  readonly agentChanged = output<AgentConfig>();
  readonly permissionChanged = output<PermissionLevel>();
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
  readonly textarea = viewChild<ElementRef<HTMLTextAreaElement>>("textarea");
  readonly agentPicker = viewChild(AgentPickerComponent);
  readonly mentions = viewChild(MentionMenuComponent);
  update(event: Event): void {
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    this.draft.set(event.target.value);
    const before = event.target.value.slice(0, event.target.selectionStart);
    const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
    this.mentionQuery.set(match?.[1] ?? null);
  }
  send(steer = false): void {
    const text = this.draft().trim();
    if (!text || this.disabled() || this.recording()) return;
    this.submitted.emit({
      text,
      intent: this.running() ? (steer ? "steer" : "queue") : "send",
      context: this.context(),
    });
    this.draft.set("");
    this.mentionQuery.set(null);
  }
  insertMention(mention: ConversationMention): void {
    this.mentionInserted.emit(mention);
    const element = this.textarea()?.nativeElement;
    if (element) {
      const before = this.draft().slice(0, element.selectionStart);
      const after = this.draft().slice(element.selectionEnd);
      this.draft.set(before.replace(/@[^\s@]*$/, `@${mention.label} `) + after);
      element.focus();
    }
    this.mentionQuery.set(null);
  }
  openMentions(): void {
    this.mentionQuery.set("");
    this.textarea()?.nativeElement.focus();
  }
  onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (
      this.mentionQuery() !== null &&
      ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
    ) {
      this.mentions()?.onKey(event);
      return;
    }
    if (event.shiftKey && event.key === "Tab") {
      event.preventDefault();
      this.modeChanged.emit(this.mode() === "plan" ? "code" : "plan");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
      event.preventDefault();
      this.agentPicker()?.open.set(true);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "u") {
      event.preventDefault();
      this.attach.emit();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.dictate.emit();
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "." &&
      this.running()
    ) {
      event.preventDefault();
      this.stop.emit();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this.send(event.altKey);
    }
    if (event.key === "ArrowUp" && !this.draft()) {
      event.preventDefault();
      this.focusLastMessage.emit();
    }
  }
  dragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes("Files") || this.disabled()) return;
    event.preventDefault();
    this.dropping.set(true);
    event.dataTransfer.dropEffect = "copy";
  }
  dragLeave(event: DragEvent): void {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    this.dropping.set(false);
  }
  drop(event: DragEvent): void {
    this.dropping.set(false);
    if (!event.dataTransfer?.files.length || this.disabled()) return;
    event.preventDefault();
    this.filesAttached.emit(Array.from(event.dataTransfer.files));
  }
  paste(event: ClipboardEvent): void {
    if (!event.clipboardData?.files.length || this.disabled()) return;
    event.preventDefault();
    this.filesAttached.emit(Array.from(event.clipboardData.files));
  }
}
