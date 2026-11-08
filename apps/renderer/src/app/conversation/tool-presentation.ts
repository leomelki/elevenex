/** Original transcript addresses; the connected owner performs bounded reads. */
export interface ToolContentSource {
  readonly inputId?: string;
  readonly outputId?: string;
}
export interface ToolContentRequest {
  readonly itemId: string;
  readonly part: 'input' | 'text';
}
/** Bounded display data supplied by a tool adapter; all strings remain inert text. */
export interface ToolPresentation {
  readonly summary: string;
  readonly meta?: string;
  readonly blocks: readonly ToolBlock[];
  /** Curated primary evidence; complete parsed blocks remain under Details. */
  readonly preview?: readonly ToolBlock[];
  readonly previewNotice?: string;
  readonly notice?: string;
}
export interface ToolField {
  readonly label: string;
  readonly value: string;
}
export interface ToolListItem {
  readonly label: string;
  readonly detail?: string;
  readonly status?: "pending" | "running" | "done" | "failed";
}
export type ToolBlock =
  | {
      readonly kind: "fields";
      readonly title?: string;
      readonly fields: readonly ToolField[];
    }
  | {
      readonly kind: "code";
      readonly title?: string;
      readonly text: string;
      readonly language?: string;
    }
  | { readonly kind: "patch"; readonly title?: string; readonly text: string }
  | { readonly kind: "text"; readonly title?: string; readonly text: string }
  | {
      readonly kind: "diff";
      readonly title?: string;
      readonly before: string;
      readonly after: string;
    }
  | {
      readonly kind: "list";
      readonly title?: string;
      readonly items: readonly ToolListItem[];
    };
