import { elementMarker } from '@elevenex/shared';

export interface EditorSelection { readonly start: number; readonly end: number }

/** Only editor-created element markers have semantic meaning; pasted HTML never enters here. */
export function editorText(root: Node): string {
  if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? '';
  if (root instanceof HTMLElement) {
    if (root.dataset['editorTail']) return '';
    const marker = Number(root.dataset['editorMarker']);
    if (marker) return elementMarker(marker);
    if (root.tagName === 'BR') return '\n';
  }
  if (root.childNodes.length === 1 && root.firstChild instanceof HTMLElement && root.firstChild.tagName === 'BR') return '';
  let text = '';
  for (const node of root.childNodes) {
    const block = node instanceof HTMLElement && /^(DIV|P)$/.test(node.tagName);
    if (block && text && !text.endsWith('\n')) text += '\n';
    text += editorText(node);
  }
  return text;
}

export function editorSelection(root: HTMLElement): EditorSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  // Focusing an embedded chip's button must preserve the last writing caret.
  const parent = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (parent?.closest('[contenteditable="false"]')) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = editorText(prefix.cloneContents()).length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return { start, end: editorText(prefix.cloneContents()).length };
}

/** The rendered surface is flat: text, atomic chips, then a caret placeholder. */
export function selectEditor(root: HTMLElement, selection: EditorSelection): void {
  const range = root.ownerDocument.createRange();
  const locate = (position: number): { node: Node; offset: number } => {
    let remaining = Math.max(0, position);
    for (let index = 0; index < root.childNodes.length; index++) {
      const node = root.childNodes[index]!;
      const length = editorText(node).length;
      if (node.nodeType === Node.TEXT_NODE && remaining <= length) return { node, offset: remaining };
      if (remaining === 0) return { node: root, offset: index };
      remaining -= length;
    }
    return { node: root, offset: Math.max(0, root.childNodes.length - 1) };
  };
  const start = locate(selection.start), end = locate(selection.end);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  root.ownerDocument.getSelection()?.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset);
}
