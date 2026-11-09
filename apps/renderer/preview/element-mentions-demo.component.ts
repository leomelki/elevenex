import {
  ChangeDetectionStrategy,
  Component,
  computed,
  signal,
} from "@angular/core";
import type { BrowserElementSnapshot } from "@elevenex/shared";
import {
  ComposerComponent,
  AttachmentsComponent,
  type ConversationAttachment,
  type ComposerSubmission,
} from "../src/app/conversation";
import { ButtonComponent } from "../src/app/ui";

/** Supply a real host snapshot through stage(); no generated screenshot fixtures. */
@Component({
  selector: "ex-element-mentions-demo",
  imports: [ComposerComponent, AttachmentsComponent, ButtonComponent],
  templateUrl: "./element-mentions-demo.component.html",
  styleUrl: "./element-mentions-demo.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ElementMentionsDemoComponent {
  readonly files = signal<readonly ConversationAttachment[]>([]);
  readonly sent = signal<readonly ConversationAttachment[]>([]);
  readonly prompt = signal("");
  readonly draft = signal("Align this element with the page heading.");
  readonly disabled = signal(false);
  readonly hasFiles = computed(() => this.files().length > 0);
  stage(snapshot: BrowserElementSnapshot): void {
    this.files.update((files) =>
      files.some((file) => file.id === snapshot.reference.id)
        ? files
        : [
            ...files,
            {
              id: snapshot.reference.id,
              element: snapshot.reference,
              name: `element-${snapshot.reference.id}.jpg`,
              path: "",
              kind: "image",
              status: "ready",
              preview: snapshot.jpeg
                ? "data:image/jpeg;base64," + snapshot.jpeg
                : undefined,
            },
          ],
    );
  }
  state(status: "ready" | "error" | "uploading"): void {
    this.files.update((files) =>
      files.map((file) => ({
        ...file,
        status,
        progress: 42,
        error: status === "error" ? "Upload interrupted" : undefined,
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
