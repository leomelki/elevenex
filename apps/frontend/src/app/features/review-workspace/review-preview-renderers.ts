/**
 * Which rendered view, if any, a review target has.
 *
 * This replaces a lone `isMarkdownPath` check that the workspace component and
 * the tab strip each called directly. The point is not abstraction for its own
 * sake — it is that "render this thing" is about to have a third and fourth
 * answer (React build output, a live dev-server URL), and each one should be a
 * descriptor plus a template case rather than another branch threaded through
 * two components.
 */

/** What a review tab is showing. `url` exists for dev-server targets later. */
export type ReviewPreviewTarget =
  | { kind: 'worktree-file'; worktreePath: string; path: string }
  | { kind: 'url'; url: string };

export type ReviewPreviewRendererId = 'markdown' | 'html';

export interface ReviewPreviewRenderer {
  id: ReviewPreviewRendererId;
  /** Tooltip for the button that switches *into* the rendered view. */
  label: string;
  /** Tooltip for the button that switches back to the diff. */
  codeLabel: string;
  /** Icon shown while the rendered view is active (i.e. "go back to code"). */
  icon: string;
  /** Icon shown while the diff is active (i.e. "show me the rendered view"). */
  previewIcon: string;
  /** Whether opening this file lands on the rendered view or on the diff. */
  opensByDefault: boolean;
  matches(target: ReviewPreviewTarget): boolean;
}

export const REVIEW_PREVIEW_RENDERERS: readonly ReviewPreviewRenderer[] = [
  {
    id: 'markdown',
    label: 'Show rendered markdown',
    codeLabel: 'Show the diff',
    icon: 'lucideCode',
    previewIcon: 'lucideBookOpen',
    // You open a document to read it, so markdown lands on the rendered view.
    opensByDefault: true,
    matches: (target) =>
      target.kind === 'worktree-file' && /\.(md|markdown|mdx)$/i.test(target.path),
  },
  {
    id: 'html',
    label: 'Show rendered page',
    codeLabel: 'Show the diff',
    icon: 'lucideCode',
    // A distinct icon from markdown's, so the two are told apart at a glance
    // in the tab strip.
    previewIcon: 'lucideEye',
    // Unlike markdown, HTML lands on the diff: rendering it runs the
    // repository's own JavaScript, which should be a deliberate click.
    opensByDefault: false,
    matches: (target) =>
      // Templates (.hbs, .ejs, .vue, .svelte) are deliberately excluded: they
      // are not documents a browser can render on their own.
      target.kind === 'worktree-file' && /\.(html?|xhtml)$/i.test(target.path),
  },
];

export function resolveReviewPreviewRenderer(
  target: ReviewPreviewTarget,
): ReviewPreviewRenderer | null {
  return REVIEW_PREVIEW_RENDERERS.find((renderer) => renderer.matches(target)) ?? null;
}

/** Convenience for the common case: a file open as a review tab. */
export function reviewPreviewRendererForPath(
  path: string,
): ReviewPreviewRenderer | null {
  return resolveReviewPreviewRenderer({
    kind: 'worktree-file',
    worktreePath: '',
    path,
  });
}

export function isMarkdownPath(path: string): boolean {
  return reviewPreviewRendererForPath(path)?.id === 'markdown';
}

export function isHtmlPath(path: string): boolean {
  return reviewPreviewRendererForPath(path)?.id === 'html';
}
