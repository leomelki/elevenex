import {
  ChangeDetectionStrategy,
  Component,
  input,
  linkedSignal,
} from "@angular/core";
interface StreamChunk {
  readonly id: number;
  readonly text: string;
  readonly fresh: boolean;
}
@Component({
  selector: "ex-stream-text",
  template: `@for (chunk of chunks(); track chunk.id) {
      <span [class.fresh]="chunk.fresh">{{ chunk.text }}</span>
    }
    @if (streaming()) {
      <span class="caret" aria-hidden="true"></span>
    }`,
  styleUrl: "./stream-text.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StreamTextComponent {
  readonly text = input.required<string>();
  readonly streaming = input(false);
  readonly chunks = linkedSignal<string, readonly StreamChunk[]>({
    source: () => this.text(),
    computation: (text, previous) => {
      if (!previous || !text.startsWith(previous.source))
        return [{ id: 0, text, fresh: false }];
      const added = text.slice(previous.source.length);
      const settled =
        previous.value.length >= 64
          ? [
              {
                id: 0,
                text: previous.value
                  .slice(0, -32)
                  .map((chunk) => chunk.text)
                  .join(""),
                fresh: false,
              },
              ...previous.value.slice(-32),
            ]
          : previous.value;
      return added
        ? [
            ...settled,
            { id: text.length, text: added, fresh: this.streaming() },
          ]
        : previous.value;
    },
  });
}
