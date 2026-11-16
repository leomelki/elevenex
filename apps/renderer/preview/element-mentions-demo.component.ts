import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
  viewChild,
} from "@angular/core";
import { MAX_BROWSER_ELEMENTS, type BrowserElementSnapshot } from "@elevenex/shared";
import {
  AttachmentsComponent,
  ComposerComponent,
  ElementProseComponent,
  type ComposerSubmission,
  type ConversationAttachment,
} from "../src/app/conversation";
import { ButtonComponent } from "../src/app/ui";

/**
 * Element pins in a composer and a sent message. Supply real host snapshots
 * through stage(); there are no generated screenshot fixtures.
 */
@Component({
  selector: "ex-element-mentions-demo",
  imports: [ComposerComponent, AttachmentsComponent, ElementProseComponent, ButtonComponent],
  templateUrl: "./element-mentions-demo.component.html",
  styleUrl: "./element-mentions-demo.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementMentionsDemoComponent {
  readonly composer = viewChild(ComposerComponent);
  readonly files = signal<readonly ConversationAttachment[]>([]);
  readonly sent = signal<readonly ConversationAttachment[]>([]);
  readonly prompt = signal("");
  readonly draft = signal("");
  readonly disabled = signal(false);
  readonly pickRequests = signal(0);
  readonly hasFiles = computed(() => this.files().length > 0);
  /** Like SessionChat: the lowest free pin, then the pin drops at the caret. */
  stage(snapshot: BrowserElementSnapshot): number | null {
    const existing = this.files().find((file) => file.element?.id === snapshot.reference.id);
    const used = new Set(this.files().map((file) => file.marker));
    const marker =
      existing?.marker ??
      Array.from({ length: MAX_BROWSER_ELEMENTS }, (_, index) => index + 1).find((n) => !used.has(n));
    if (!marker || !snapshot.jpeg) return null;
    if (!existing)
      this.files.update((files) => [
        ...files,
        {
          id: snapshot.reference.id,
          element: snapshot.reference,
          marker,
          name: `element-${snapshot.reference.id}.jpg`,
          path: "",
          kind: "image",
          status: "ready",
          preview: "data:image/jpeg;base64," + snapshot.jpeg,
        },
      ]);
    this.composer()?.insertElement(marker);
    return marker;
  }
  state(status: "ready" | "error" | "uploading"): void {
    this.files.update((files) =>
      files.map((file) => ({
        ...file,
        status,
        progress: status === "uploading" ? 42 : undefined,
        error: status === "error" ? "Upload interrupted. Your pixels are kept." : undefined,
      })),
    );
  }
  remove(id: string): void {
    this.files.update((files) => files.filter((file) => file.id !== id));
  }
  send(submission: ComposerSubmission): void {
    this.prompt.set(submission.text);
    this.sent.set(this.files());
    this.files.set([]);
    this.draft.set("");
  }
}
