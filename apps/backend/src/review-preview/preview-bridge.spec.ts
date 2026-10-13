import { runInNewContext } from 'node:vm';
import { buildPreviewBridgeScript } from './preview-bridge.js';

function visualizationBridge() {
  const messages: { type: string; [key: string]: unknown }[] = [];
  const documentListeners = new Map<string, (event?: unknown) => void>();
  const windowListeners = new Map<string, (event?: unknown) => void>();
  const body = { scrollHeight: 320, appendChild: jest.fn() };
  const document = {
    currentScript: {
      dataset: {
        exPreviewId: 'test',
        exPrefix: 'https://backend.test/p/test/',
        exVisualization: '1',
      },
    },
    baseURI: 'https://backend.test/p/test/chart.html',
    readyState: 'loading',
    title: 'Chart',
    body,
    documentElement: {
      scrollHeight: 320,
      style: { setProperty: jest.fn() },
      classList: { toggle: jest.fn() },
    },
    head: { appendChild: jest.fn() },
    createElement: () => ({ style: {} }),
    addEventListener: (type: string, listener: (event?: unknown) => void) =>
      documentListeners.set(type, listener),
  };
  const parent = {
    postMessage: (message: (typeof messages)[number]) => messages.push(message),
  };
  const window = {
    parent,
    addEventListener: (type: string, listener: (event?: unknown) => void) =>
      windowListeners.set(type, listener),
  };
  runInNewContext(buildPreviewBridgeScript(), { document, window, URL });
  return { messages, documentListeners, windowListeners, document, parent };
}

describe('visualization preview bridge', () => {
  it('reports local and external navigation without running review selection listeners', () => {
    const bridge = visualizationBridge();
    expect(bridge.documentListeners.has('selectionchange')).toBe(false);
    expect(bridge.windowListeners.has('scroll')).toBe(false);
    for (const href of [
      'https://backend.test/p/test/details.html?x=1#part',
      'https://external.test/',
      'https://backend.test/p/test/bad%zz.html',
    ]) {
      const event = {
        target: { closest: () => ({ href, getAttribute: () => href }) },
        preventDefault: jest.fn(),
      };
      bridge.documentListeners.get('click')!(event);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(bridge.messages.at(-1)).toMatchObject({ type: 'navigate', href });
    }
    expect(bridge.messages[0].path).toBe('details.html');
  });

  it('reports script failures and authenticates probes without inserting a review overlay', () => {
    const bridge = visualizationBridge();
    bridge.windowListeners.get('error')!();
    bridge.documentListeners.get('DOMContentLoaded')!();
    expect(bridge.messages.map((message) => message.type)).toEqual([
      'error',
      'ready',
    ]);
    const message = {
      type: 'probe',
      ex: 'elevenex-preview',
      v: 1,
      previewId: 'test',
    };
    bridge.windowListeners.get('message')!({ source: {}, data: message });
    expect(bridge.messages).toHaveLength(2);
    bridge.windowListeners.get('message')!({
      source: bridge.parent,
      data: message,
    });
    expect(bridge.messages.at(-1)?.type).toBe('ready');
    bridge.windowListeners.get('message')!({
      source: bridge.parent,
      data: {
        ...message,
        type: 'init',
        theme: { variables: { '--foreground': 'red' }, colorScheme: 'dark' },
      },
    });
    expect(
      bridge.document.documentElement.style.setProperty,
    ).toHaveBeenCalledWith('--foreground', 'red');
    expect(bridge.document.body.appendChild).not.toHaveBeenCalled();
  });
});
