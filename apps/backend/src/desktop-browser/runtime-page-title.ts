import type { CDPSession } from 'playwright-core';

const world = 'elevenex-page-title';
const binding = '__elevenexPageTitle';
const maxUrlLength = 2048;
const maxTitleLength = 200;

/** Observe DOM title changes on the tab's Runtime-enabled CDP session. */
export async function observeRuntimePageTitle(
  cdp: CDPSession,
  publish: (url: string, title: string) => void,
): Promise<() => void> {
  const receive = ({ name, payload }: { name: string; payload: string }) => {
    if (name !== binding || payload.length > maxUrlLength + 1 + maxTitleLength)
      return;
    const separator = payload.indexOf('\n');
    if (separator < 1 || separator > maxUrlLength) return;
    const title = payload.slice(separator + 1);
    if (title.length <= maxTitleLength)
      publish(payload.slice(0, separator), title);
  };
  await cdp.send('Runtime.addBinding', {
    name: binding,
    executionContextName: world,
  });
  cdp.on('Runtime.bindingCalled', receive);
  const stop = () => cdp.off('Runtime.bindingCalled', receive);
  try {
    // Target events can miss a title mutation after load. Keep the observer in
    // an isolated world so it cannot change the site's JavaScript globals.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${pageTitleObserver.toString()})(${JSON.stringify(binding)},${maxUrlLength},${maxTitleLength})`,
      worldName: world,
      runImmediately: true,
    });
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}

function pageTitleObserver(
  bindingName: string,
  maxUrl: number,
  maxTitle: number,
): void {
  if (window !== window.top) return;
  const publish: unknown = Reflect.get(globalThis, bindingName);
  if (typeof publish !== 'function') return;
  let root: Element | null | undefined;
  let head: Element | null | undefined;
  let previous: string | undefined;
  const update = () => {
    const nextRoot = document.documentElement;
    const nextHead = document.head ?? nextRoot;
    if (root !== nextRoot || head !== nextHead) {
      if (root !== nextRoot) previous = undefined;
      root = nextRoot;
      head = nextHead;
      observer.disconnect();
      // document.open can replace the DOM while this isolated world survives.
      observer.observe(document, { childList: true });
      if (root && root !== head) observer.observe(root, { childList: true });
      if (head)
        observer.observe(head, {
          childList: true,
          subtree: true,
          characterData: true,
        });
    }
    const title = document.title
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maxTitle);
    const url = location.href;
    if (title === previous || url.length > maxUrl) return;
    previous = title;
    Reflect.apply(publish, globalThis, [url + '\n' + title]);
  };
  const observer = new MutationObserver(update);
  update();
}
