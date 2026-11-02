import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from "@angular/core";
import { AutoHeightDirective, ButtonComponent, IconComponent } from "../../ui";
import type {
  AgentQuestion,
  QuestionAnswers,
  QuestionOption,
} from "../conversation.models";
@Component({
  selector: "ex-question-card",
  imports: [AutoHeightDirective, ButtonComponent, IconComponent],
  templateUrl: "./question-card.component.html",
  styleUrl: "./question-card.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "(keydown)": "onKey($event)" },
})
export class QuestionCardComponent {
  readonly question = input("");
  readonly options = input<readonly QuestionOption[]>([]);
  readonly kind = input<"single" | "multi">("single");
  readonly questions = input<readonly AgentQuestion[]>([]);
  readonly answers = input<QuestionAnswers>();
  readonly disabled = input(false);
  readonly submitted = output<QuestionAnswers>();
  readonly index = signal(0);
  readonly draft = signal<QuestionAnswers>({});
  readonly custom = signal<Readonly<Record<string, string>>>({});
  readonly customOpen = signal<ReadonlySet<string>>(new Set());
  readonly items = computed<readonly AgentQuestion[]>(() =>
    this.questions().length
      ? this.questions()
      : [
          {
            id: "question",
            question: this.question(),
            kind: this.kind(),
            options: this.options(),
          },
        ],
  );
  readonly current = computed(
    () => this.items()[Math.min(this.index(), this.items().length - 1)],
  );
  readonly selected = computed(
    () => this.draft()[this.current()?.id ?? ""] ?? [],
  );
  readonly complete = computed(() =>
    this.items().every(
      (question) => (this.draft()[question.id]?.length ?? 0) > 0,
    ),
  );
  readonly summary = computed(() =>
    Object.values(this.answers() ?? {})
      .map((value) => value.join(", "))
      .join(" · "),
  );
  choose(label: string): void {
    const question = this.current();
    if (!question || this.disabled()) return;
    this.draft.update((answers) => {
      const existing = answers[question.id] ?? [];
      const next =
        question.kind === "multi"
          ? existing.includes(label)
            ? existing.filter((item) => item !== label)
            : [...existing, label]
          : [label];
      return { ...answers, [question.id]: next };
    });
    if (question.kind !== "multi") {
      if (this.items().length === 1) this.submit();
      else if (this.index() < this.items().length - 1)
        this.index.update((value) => value + 1);
    }
  }
  openCustom(): void {
    const question = this.current();
    if (question)
      this.customOpen.update((open) => new Set([...open, question.id]));
  }
  writeCustom(event: Event): void {
    const question = this.current();
    if (!question || !(event.target instanceof HTMLInputElement)) return;
    const value = event.target.value;
    const previous = this.custom()[question.id];
    this.custom.update((values) => ({ ...values, [question.id]: value }));
    this.draft.update((answers) => ({
      ...answers,
      [question.id]:
        question.kind === "multi"
          ? [
              ...(answers[question.id] ?? []).filter(
                (item) => item !== previous,
              ),
              ...(value.trim() ? [value] : []),
            ]
          : value.trim()
            ? [value]
            : [],
    }));
  }
  closeCustom(): void {
    const question = this.current();
    if (question)
      this.customOpen.update((open) => {
        const next = new Set(open);
        next.delete(question.id);
        return next;
      });
  }
  next(): void {
    if (!this.selected().length) return;
    if (this.index() < this.items().length - 1)
      this.index.update((value) => value + 1);
    else this.submit();
  }
  submit(): void {
    if (this.complete() && !this.disabled()) this.submitted.emit(this.draft());
  }
  onKey(event: KeyboardEvent): void {
    if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (event.target instanceof HTMLInputElement) {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeCustom();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.next();
      }
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const option = this.current()?.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        this.choose(option.label);
      }
    } else if (event.key === "ArrowLeft" && this.index() > 0) {
      event.preventDefault();
      this.index.update((value) => value - 1);
    } else if (
      event.key === "ArrowRight" &&
      this.index() < this.items().length - 1
    ) {
      event.preventDefault();
      this.index.update((value) => value + 1);
    }
  }
}
