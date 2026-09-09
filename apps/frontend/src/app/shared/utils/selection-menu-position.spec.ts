import {
  SELECTION_MENU_OFFSET_PX,
  placeSelectionMenu,
} from './selection-menu-position';

describe('placeSelectionMenu', () => {
  const container = { top: 100, left: 50 };

  it('sits one offset above the selection, in container coordinates', () => {
    const placement = placeSelectionMenu(
      { top: 300, left: 120 },
      container,
      { top: 0, left: 0 },
    );

    expect(placement.top).toBe(300 - 100 - SELECTION_MENU_OFFSET_PX);
    expect(placement.left).toBe(120 - 50);
  });

  it('adds the container scroll offset, so it stays put while scrolling', () => {
    const placement = placeSelectionMenu(
      { top: 300, left: 120 },
      container,
      { top: 400, left: 20 },
    );

    expect(placement.top).toBe(300 - 100 + 400 - SELECTION_MENU_OFFSET_PX);
    expect(placement.left).toBe(120 - 50 + 20);
  });

  it('clamps to the container edge for a selection near the top', () => {
    const placement = placeSelectionMenu(
      { top: 105, left: 45 },
      container,
      { top: 0, left: 0 },
    );

    // Unclamped this would be negative and the bar would be clipped away.
    expect(placement.top).toBe(8);
    expect(placement.left).toBe(8);
  });

  it('treats a non-scrolling container as zero scroll', () => {
    const placement = placeSelectionMenu(
      { top: 200, left: 80 },
      { top: 0, left: 0 },
      { top: 0, left: 0 },
    );

    expect(placement.top).toBe(200 - SELECTION_MENU_OFFSET_PX);
    expect(placement.left).toBe(80);
  });
});
