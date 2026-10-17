/** Render recorded session data without a live agent or writes to the real backend. */
export async function installSessionFixture(page, fixture) {
  if (
    !Number.isSafeInteger(fixture.sessionId) ||
    !fixture.responses ||
    !Array.isArray(fixture.events)
  )
    throw new Error("Session fixture needs sessionId, responses, and events.");
  const prefix = `/api/sessions/${fixture.sessionId}`;
  for (const event of fixture.events)
    if (event.payload?.sessionId !== fixture.sessionId)
      throw new Error("Fixture event belongs to another session.");
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (Object.hasOwn(fixture.responses, pathname)) {
      const { status = 200, delayMs = 0 } = fixture.responseOptions?.[pathname] ?? {};
      if (!Number.isInteger(status) || status < 100 || status > 599 ||
          !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000)
        throw new Error('Fixture response needs a valid HTTP status and a delay of 0–30000 ms.');
      if (delayMs) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); page.off('close', done); resolve(); };
          const timer = setTimeout(done, delayMs);
          page.once('close', done);
        });
        if (page.isClosed()) return;
      }
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(fixture.responses[pathname]),
      });
      return;
    }
    // A fixture never changes the underlying session or provider configuration.
    if (!["GET", "HEAD"].includes(request.method())) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ message: "Recorded preview is read-only." }),
      });
      return;
    }
    await route.continue();
  });
  await page.routeWebSocket(
    /\/(?:agent-runtime|claude-runtime|claude-terminal-transcript)\?/,
    (socket) => {
      if (
        Number(new URL(socket.url()).searchParams.get("sessionId")) !==
        fixture.sessionId
      ) {
        socket.connectToServer();
        return;
      }
      socket.onMessage((raw) => {
        const action = JSON.parse(String(raw));
        if (action.type === "hydrate")
          for (const event of fixture.events)
            socket.send(JSON.stringify(event));
        // Watch/unwatch are local presentation operations; mutations never reach a server.
        else if (!["watch_subagent", "unwatch_subagent"].includes(action.type))
          socket.send(
            JSON.stringify({
              type: "error",
              payload: {
                sessionId: fixture.sessionId,
                message: "Recorded preview is read-only.",
              },
            }),
          );
      });
    },
  );
}
