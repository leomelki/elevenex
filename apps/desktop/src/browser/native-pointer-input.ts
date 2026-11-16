import type { MouseInputEvent, MouseWheelInputEvent } from 'electron';
import type { TaskBrowserStreamEvent } from '@elevenex/shared';

/** Stream coordinates are CSS pixels; Electron's native dispatcher uses view
 * pixels and the opposite wheel direction from CDP. Preserve held buttons so
 * native capture, selection and dragging receive the complete mouse state.
 */
export function nativePointerInput(
  input: Extract<TaskBrowserStreamEvent, { kind: 'pointer' | 'wheel' }>,
  zoom: number,
): MouseInputEvent | MouseWheelInputEvent {
  const modifiers: NonNullable<MouseInputEvent['modifiers']> = [];
  for (const [bit, name] of [[1, 'alt'], [2, 'control'], [4, 'meta'], [8, 'shift']] as const)
    if (input.modifiers & bit) modifiers.push(name);
  const point = { x: Math.round(input.x * zoom), y: Math.round(input.y * zoom) };
  if (input.kind === 'wheel')
    return { type: 'mouseWheel', ...point, deltaX: -input.deltaX * zoom, deltaY: -input.deltaY * zoom, canScroll: true, modifiers };
  for (const [bit, name] of [[1, 'leftbuttondown'], [2, 'rightbuttondown'], [4, 'middlebuttondown']] as const)
    if (input.buttons & bit) modifiers.push(name);
  return {
    type: input.type === 'down' ? 'mouseDown' : input.type === 'up' ? 'mouseUp' : 'mouseMove',
    ...point, modifiers, clickCount: input.clicks,
    ...(input.button === 'none' ? {} : { button: input.button }),
  };
}
