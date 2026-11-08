import assert from "node:assert/strict";

// Seek only this timeline's current animation objects. Other preview regions can
// retire debugger animation IDs while their own cleanup timers are running.
async function* timelineFrames(capture, name, times, inspect) {
  await capture.evaluate(() => {
    for (const a of document
      .querySelector("ex-work-timeline")
      .getAnimations({ subtree: true }))
      if (Number.isFinite(a.effect?.getComputedTiming().endTime)) {
        a.pause();
        a.currentTime = 0;
      }
  });
  for (const time of times) {
    await capture.evaluate((time) => {
      for (const a of document
        .querySelector("ex-work-timeline")
        .getAnimations({ subtree: true }))
        if (Number.isFinite(a.effect?.getComputedTiming().endTime)) {
          a.pause();
          a.currentTime = time;
        }
    }, time);
    yield { name: `${name}-${time}`, inspect };
  }
  await capture.evaluate(() => {
    for (const a of document
      .querySelector("ex-work-timeline")
      .getAnimations({ subtree: true }))
      if (Number.isFinite(a.effect?.getComputedTiming().endTime)) a.play();
  });
}

/** Public chat rendering, stable provider receipts and trusted disclosure input. */
export default async function* (capture) {
  await capture.evaluate(() => {
    location.href = "/connected-workspace";
  });
  await capture.waitFor(() =>
    document.querySelector("ex-workspace-navigation ex-task-list"),
  );
  await capture.component("ex-machine-workspace", (c) =>
    c.store.selectSession({ taskId: "11", sessionId: "101" }),
  );
  const scene = async (value) => {
    await capture.component(
      "ex-connected-workspace-demo",
      (c, value) => c.fixture.chat.timeline(value),
      value,
    );
    await capture.waitFor(() =>
      document.querySelector('[data-work-step="timeline-intro"]'),
    );
  };
  const finish = async () => {
    await capture.settle();
    await capture.waitFor(() =>
      document
        .getAnimations()
        .every(
          (a) =>
            !Number.isFinite(a.effect?.getComputedTiming().endTime) ||
            a.playState !== "running",
        ),
    );
  };
  const row = (id) => `[data-work-step="${id}"]`;
  const head = (id) => row(id) + " ex-tool-step .head";
  const scroll = async (selector) => {
    await capture.evaluate(
      (s) => document.querySelector(s).scrollIntoView({ block: "center" }),
      selector,
    );
    if (
      await capture.evaluate(
        () => !!document.querySelector(".reminder-top button"),
      )
    )
      await capture.click(".reminder-top button");
    await finish();
  };
  const shown = (id) =>
    capture.evaluate(
      (id) =>
        !document
          .querySelector(`[data-work-step="${id}"] .step-fold`)
          ?.hasAttribute("inert"),
      id,
    );
  for (const theme of ["light", "dark"]) {
    await capture.theme(theme);
    await capture.viewport(1440, 960);
    await scene("before-message");
    await capture.waitFor(() =>
      document.querySelector('[data-work-step="concurrency"]'),
    );
    await finish();
    await scroll(head("concurrency"));
    await capture.evaluate(
      (s) => document.querySelector(s).focus(),
      head("concurrency"),
    );
    await capture.press("Enter");
    await finish();
    await capture.evaluate((s) => {
      document.querySelector(s).dataset.inspected = "retained";
    }, head("concurrency"));
    yield {
      name: theme + "-inspected-tool",
      inspect: ["ex-turn", head("concurrency")],
    };
    await scene("after-message");
    await capture.waitFor(() =>
      document.querySelector(".answer")?.textContent.includes("focused checks"),
    );
    await finish();
    assert.equal(
      await capture.evaluate(
        (s) =>
          document.activeElement === document.querySelector(s) &&
          document.querySelector(s).dataset.inspected === "retained" &&
          document.querySelector(s).getAttribute("aria-expanded") === "true",
        head("concurrency"),
      ),
      true,
    );
    assert.equal(
      await capture.evaluate(
        () => document.querySelectorAll("ex-turn ex-work-timeline").length,
      ),
      1,
    );
    yield {
      name: theme + "-new-message-keeps-inspection",
      inspect: ["ex-turn", head("concurrency")],
    };

    await scene("two-reads");
    await capture.waitFor(() =>
      document.querySelector('[data-work-step="retry"]'),
    );
    await finish();
    await scroll(head("retry"));
    await capture.click(head("retry"));
    await finish();
    await capture.evaluate((s) => {
      document.querySelector(s).focus();
      document.querySelector(s).dataset.inspected = "retained";
    }, head("retry"));
    await scene("three-reads");
    await capture.waitFor(() =>
      document
        .querySelector("ex-work-timeline .group")
        ?.textContent.includes("Read 3 files"),
    );
    assert.equal(
      await capture.evaluate(
        (s) =>
          document.activeElement === document.querySelector(s) &&
          document.querySelector(s).dataset.inspected === "retained",
        head("retry"),
      ),
      true,
    );
    yield* timelineFrames(
      capture,
      theme + "-group-forms",
      [0, 80, 160, 280],
      ["ex-turn", "ex-work-timeline .group", head("retry")],
    );
    await finish();
    await scroll("ex-work-timeline .group");
    await capture.click("ex-work-timeline .group");
    await finish();
    assert.equal(await shown("retry"), false);
    assert.equal(
      await capture.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("ex-work-timeline .group"),
      ),
      true,
    );
    await capture.press("Enter");
    await finish();
    assert.equal(await shown("retry"), true);

    await scene("busy");
    await capture.waitFor(() =>
      document.querySelector('[data-work-step="watch"]'),
    );
    await finish();
    assert.equal(await shown("watch"), true);
    assert.equal(await shown("database"), true);
    assert.equal(await shown("check-0"), false);
    await scroll("ex-work-timeline .earlier");
    const counts = await capture.evaluate(() => ({
      controls: document.querySelectorAll("ex-work-timeline .earlier").length,
      text: document
        .querySelector("ex-work-timeline .earlier")
        .textContent.trim(),
    }));
    assert.equal(counts.controls, 1);
    assert.match(counts.text, /4 earlier steps/);
    yield {
      name: theme + "-running-and-failed-stay-visible",
      inspect: ["ex-turn", row("watch"), row("database")],
    };
    await capture.click("ex-work-timeline .earlier");
    yield* timelineFrames(
      capture,
      theme + "-reveal-earlier",
      [0, 100, 200, 320],
      ["ex-work-timeline .earlier", row("check-0"), row("check-7")],
    );
    await finish();
    assert.equal(await shown("check-0"), true);
    assert.equal(
      await capture.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("ex-work-timeline .earlier"),
      ),
      true,
    );
    assert.match(
      await capture.evaluate(
        () => document.querySelector("ex-work-timeline .earlier").textContent,
      ),
      /Show fewer steps/,
    );
    await scroll("ex-work-timeline .earlier");
    await capture.press("Enter");
    await finish();
    assert.equal(await shown("check-0"), false);
    assert.equal(
      await capture.evaluate(
        () =>
          document.activeElement ===
          document.querySelector("ex-work-timeline .earlier"),
      ),
      true,
    );
    await capture.click("ex-work-timeline .earlier");
    await capture.click("ex-work-timeline .earlier");
    await capture.click("ex-work-timeline .earlier");
    await finish();
    assert.equal(await shown("check-0"), true);
    assert.equal(
      await capture.evaluate(
        () => document.querySelectorAll("ex-work-timeline .earlier").length,
      ),
      1,
    );
    yield {
      name: theme + "-interrupted-disclosure",
      inspect: ["ex-work-timeline .earlier", row("check-0")],
    };
    await capture.click("ex-work-timeline .earlier");
    await finish();

    await scene("long");
    await capture.waitFor(() =>
      document.querySelector('[data-work-step="check-19"]'),
    );
    await capture.component("ex-turn", (c) => c.toggled.set(true));
    await finish();
    await scroll("ex-work-timeline .earlier");
    const before = await capture.rect("ex-turn");
    await scene("finished");
    await capture.waitFor(() =>
      document.querySelector(".work-label")?.textContent.includes("Worked"),
    );
    await finish();
    const after = await capture.rect("ex-turn");
    assert.equal(await shown("check-0"), false);
    assert.equal(await shown("check-19"), true);
    assert.ok(
      Math.abs(after.height - before.height) < 50,
      JSON.stringify({ before, after }),
    );
    yield {
      name: theme + "-completion-keeps-recent-window",
      inspect: ["ex-turn", "ex-work-timeline .earlier"],
      metadata: { before, after },
    };

    await capture.viewport(1000, 760);
    await capture.reducedMotion(true);
    await scene("busy");
    await capture.waitFor(() =>
      document.querySelector('[data-work-step="watch"]'),
    );
    await capture.component("ex-turn", (c) => c.toggled.set(null));
    await finish();
    await scroll(row("watch"));
    assert.equal(await shown("watch"), true);
    assert.equal(await shown("database"), true);
    assert.equal(
      await capture.evaluate(() => {
        const bounds = document
          .querySelector("ex-work-timeline")
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll("ex-work-timeline ex-tool-step .head"),
        ].every((head) => {
          const rect = head.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
        });
      }),
      true,
    );
    yield {
      name: theme + "-narrow-reduced-motion",
      inspect: ["ex-turn", "ex-work-timeline .earlier"],
    };
    await capture.reducedMotion(false);
  }

  await capture.viewport(1440, 960);
  await capture.component("ex-connected-workspace-demo", (c) =>
    c.fixture.chat.scenario("long"),
  );
  await capture.waitFor(() =>
    document.querySelector('[data-work-step="test"]'),
  );
  await capture.component("ex-turn", (c) => c.toggled.set(true));
  await finish();
  await scroll(head("test"));
  await capture.click(head("test"));
  await finish();
  await scroll(".full-content button");
  await capture.click(".full-content button");
  await capture.waitFor(() =>
    document
      .querySelector(
        '[role="dialog"][aria-label="Full transcript content"] pre',
      )
      ?.textContent.includes("Verified concurrent request"),
  );
  await finish();
  assert.equal(await capture.evaluate(() => document.activeElement?.getAttribute('role')), 'dialog');
  yield {
    name: "full-output-reader",
    inspect: ['[role="dialog"][aria-label="Full transcript content"]'],
  };
  await capture.evaluate(() => {
    const pre = document.querySelector('pre[aria-label="Original tool output"]');
    pre.scrollTop = pre.scrollHeight;
  });
  await capture.click('[role="dialog"][aria-label="Full transcript content"] footer button:last-child');
  await capture.waitFor(() => document.querySelector('[role="dialog"][aria-label="Full transcript content"] footer span')?.textContent.includes('16001'));
  assert.equal(await capture.evaluate(() => document.querySelector('pre[aria-label="Original tool output"]').scrollTop), 0);
  yield { name: 'next-output-page-starts-at-top', inspect: ['[role="dialog"][aria-label="Full transcript content"]'] };
  const input = '[role="radiogroup"][aria-label="Tool content"] button:last-child';
  await capture.click(input);
  await capture.waitFor(() =>
    document
      .querySelector(
        '[role="dialog"][aria-label="Full transcript content"] pre',
      )
      ?.textContent.includes("pnpm test retry"),
  );
  yield {
    name: "paired-tool-input",
    inspect: ['[role="dialog"][aria-label="Full transcript content"]'],
  };
  await capture.press("Escape");
  await finish();
  assert.equal(
    await capture.evaluate(() => document.activeElement?.textContent.trim()),
    "View full output",
  );
}
