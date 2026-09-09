/**
 * Placing the floating action bar above a text selection.
 *
 * Pure arithmetic, kept apart from the components so the three surfaces that
 * show the bar (diff panel, markdown preview, HTML preview) agree on where it
 * goes — and so the offset and the clamp are testable, which they were not
 * while they lived inline in two components.
 */

/** Vertical gap between the top of the selection and the action bar. */
export const SELECTION_MENU_OFFSET_PX = 38;

/** Smallest inset from the container edge, so the bar never clips. */
const MIN_INSET_PX = 8;

/** Just the corner we need; `DOMRect` satisfies this. */
export interface RectLike {
  top: number;
  left: number;
}

export interface SelectionMenuPlacement {
  top: number;
  left: number;
}

/**
 * Convert a viewport-relative selection rect into coordinates for an
 * absolutely-positioned bar inside a scrolled container.
 *
 * `scroll` is the container's own scroll offset; pass zeroes when the
 * container does not scroll (the HTML preview scrolls inside its iframe, so
 * the rect it reports is already net of that).
 */
export function placeSelectionMenu(
  selectionRect: RectLike,
  containerRect: RectLike,
  scroll: { top: number; left: number },
): SelectionMenuPlacement {
  return {
    top: Math.max(
      MIN_INSET_PX,
      selectionRect.top - containerRect.top + scroll.top - SELECTION_MENU_OFFSET_PX,
    ),
    left: Math.max(
      MIN_INSET_PX,
      selectionRect.left - containerRect.left + scroll.left,
    ),
  };
}
