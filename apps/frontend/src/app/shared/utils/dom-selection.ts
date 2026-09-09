/**
 * Reading the current text selection, for the surfaces that turn one into a
 * chat mention.
 *
 * The diff panel and the markdown preview each grew their own copy of these
 * guards; the HTML preview would have been a third. The rules are subtle
 * enough to be worth stating once: a selection is only ours if it is a real
 * range (not a caret) and *both* ends live inside our own scroller, otherwise
 * a selection made elsewhere on the page would pop our action bar.
 */

/** A non-empty selection that belongs to a given container. */
export interface CapturedSelection {
  range: Range;
  /** The selected text, exactly as the user selected it. */
  text: string;
  /** Viewport-relative bounds of the selection, for placing an action bar. */
  rect: DOMRect;
}

/**
 * The current selection, if it is a non-empty range wholly inside `container`.
 *
 * Returns null for a caret, for an empty selection, and for one that starts or
 * ends outside the container — callers treat all three the same way, by
 * dismissing whatever they were showing.
 */
export function captureSelectionWithin(
  container: HTMLElement | null | undefined,
): CapturedSelection | null {
  if (!container) return null;

  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;

  const { anchorNode, focusNode } = selection;
  if (
    !anchorNode ||
    !focusNode ||
    !container.contains(anchorNode) ||
    !container.contains(focusNode)
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  // jsdom-based tests and very old engines can lack the method; falling back to
  // the container's own box keeps the action bar on screen rather than at 0,0.
  const rect =
    typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : container.getBoundingClientRect();

  return { range, text: selection.toString(), rect };
}

/** Drop the current selection, after acting on it. */
export function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}
