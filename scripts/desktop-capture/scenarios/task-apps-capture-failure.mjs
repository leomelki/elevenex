export default async function* (capture) {
  await capture.evaluate(() => { location.href='/task-apps'; });
  await capture.waitFor(() => document.querySelector('ex-task-apps-demo'));
  for (const theme of ['light','dark']) {
    await capture.theme(theme);
    await capture.viewport(theme === 'dark' ? 340 : 440,650);
    await capture.reducedMotion(theme === 'dark');
    await capture.waitFor(() => {
      const element=document.querySelector('ex-task-apps-demo');
      return element && globalThis.ng?.getComponent(element)?.fixture.watchId;
    });
    await capture.component('ex-task-apps-demo', c => c.fixture.interrupt('The host could not capture or encode the app window.'));
    await capture.waitFor(() => document.querySelector('ex-app-stream .message')?.textContent.includes("Couldn't capture the window"));
    yield {name:theme+'-capture-failed',selector:'ex-task-apps',inspect:['ex-app-stream .message','ex-app-stream .message button']};
    if (theme === 'light') await capture.click('ex-app-stream .message button');
  }
}
