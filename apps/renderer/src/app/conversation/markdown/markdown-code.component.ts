import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from "@angular/core";
import { codeTokens } from "./code-tokens";
@Component({
  selector: "ex-markdown-code",
  templateUrl: "./markdown-code.component.html",
  styleUrl: "./markdown-code.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MarkdownCodeComponent {
  readonly text = input.required<string>();
  readonly language = input("");
  readonly streaming = input(false);
  readonly copyRequested = output<string>();
  readonly copied = input(false);
  readonly tokens = computed(() => codeTokens(this.text(), this.language()));
}
