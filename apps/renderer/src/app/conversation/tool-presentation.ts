import type { Signal } from '@angular/core';
import type { SessionChatToolSource } from '@elevenex/shared';

/** Original transcript addresses; the connected owner performs bounded reads. */
export interface ToolContentSource {
  readonly inputId?: string;
  readonly outputId?: string;
}
export interface ToolContentRequest {
  readonly itemId: string;
  readonly part: 'input' | 'text';
}
export interface ToolEvidence {
  readonly presentation: ToolPresentation;
  readonly output: string;
  readonly fullContent?: ToolContentSource;
}
export type ToolDetailsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly evidence: ToolEvidence }
  | { readonly status: 'error'; readonly reason: 'unavailable' | 'changed' | 'failed' };
export interface ToolDetailsInspection {
  readonly state: Signal<ToolDetailsState>;
  retry(): void;
}
/** The connected owner supplies evidence only while an expanded row observes it. */
export interface ToolDetailsProvider {
  (source: SessionChatToolSource, signal: AbortSignal): ToolDetailsInspection;
  /**
   * Optionally warm a closed row's evidence on hover, focus or press intent.
   * The owner bounds speculative reads, cancels superseded ones and lets a
   * later observer join the read. Plain provider functions omit it.
   */
  readonly prefetch?: (source: SessionChatToolSource) => void;
}

/** Bounded display data supplied by a tool adapter; all strings remain inert text. */
export interface ToolPresentation {
  readonly summary: string;
  readonly meta?: string;
  readonly blocks: readonly ToolBlock[];
  /** Captured shell output; parsed lazily when the tool disclosure is mounted. */
  readonly shell?: ShellToolPresentation;
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

/** Shell facts are provider-neutral; timeline status supplies running/unknown completion. */
export interface ShellToolPresentation {
  readonly command: string;
  readonly directory: string;
  readonly description: string;
  readonly output: string;
  readonly exitCode?: number;
  readonly interrupted: boolean;
  readonly failed: boolean;
  readonly duration?: string;
  readonly commandShortened: boolean;
  readonly outputShortened: boolean;
}
