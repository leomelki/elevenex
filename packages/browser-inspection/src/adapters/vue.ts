import type { ProbeHelpers, SourceCandidate } from './types';

export function vueSources(element: Element, { own }: ProbeHelpers): readonly SourceCandidate[] {
  const result: SourceCandidate[] = [];
  const vnode = own(element, '__vnode'), props = own(vnode, 'props');
  // Vue Inspector 7 indexes locations by opaque props identity. No application prop value
  // is enumerated or returned; older inspectors use only the explicit hidden metadata key.
  const store = own(own(globalThis, '__vue_inspector_store__'), 'vnodeToPos');
  let position: unknown;
  try {
    if (store instanceof WeakMap && props && typeof props === 'object') position = WeakMap.prototype.get.call(store, props);
  } catch { /* An incompatible inspector store must not hide the component filename. */ }
  if (Array.isArray(position) && position.length === 3 && typeof position[0] === 'string' && position[0].length <= 2048 && typeof position[1] === 'number' && typeof position[2] === 'number') {
    result.push({ type: 'location', file: position[0], line: position[1], column: position[2], kind: 'vue-inspector' });
  }
  const hidden = own(props, '__v_inspector');
  const match = typeof hidden === 'string' && hidden.length <= 2304 ? /^(.+):(\d+):(\d+)$/.exec(hidden) : null;
  if (match) result.push({ type: 'location', file: match[1]!, line: Number(match[2]), column: Number(match[3]), kind: 'vue-inspector' });
  // Vue 3 development DOM ownership; do not traverse VNode props, children or component state.
  let instance = own(element, '__vueParentComponent');
  const visited = new Set<unknown>();
  for (let depth = 0; instance && depth < 16 && result.length < 6; depth++) {
    if (visited.has(instance)) break;
    visited.add(instance);
    const file = own(own(instance, 'type'), '__file');
    // Keep a bounded owner chain so a library filename rejected by the host does not
    // prevent resolution to the nearest editable application component.
    if (typeof file === 'string' && file.length <= 2048) result.push({ type: 'component', file, framework: 'vue' });
    instance = own(instance, 'parent');
  }
  // Vue 2 development builds expose the SFC filename through the root instance's options.
  const file = own(own(own(element, '__vue__'), '$options'), '__file');
  return typeof file === 'string' && file.length <= 2048 ? [...result, { type: 'component', file, framework: 'vue' }] : result;
}
