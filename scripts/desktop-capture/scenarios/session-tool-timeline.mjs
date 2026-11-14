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

/** Message boundaries, section-local compaction and retained tool inspection. */
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
  const summary = (id) => row(id) + " .group";
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
    await finish();
    assert.equal(await shown("concurrency"), true);
    await scene("after-message");
    await finish();
    assert.equal(await shown("concurrency"), false);
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).textContent,
        summary("concurrency"),
      ),
      /1 command/,
    );
    yield {
      name: theme + "-new-message-closes-activity",
      inspect: ["ex-turn", summary("concurrency")],
    };

    await scene("before-message");
    await finish();
    await scroll(head("concurrency"));
    await capture.click(head("concurrency"));
    await finish();
    await capture.evaluate((s) => {
      document.querySelector(s).dataset.inspected = "retained";
    }, head("concurrency"));
    await scene("after-message");
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
    assert.equal(await shown("concurrency"), true);
    yield {
      name: theme + "-new-message-retains-inspection",
      inspect: ["ex-turn", head("concurrency")],
    };

    await scene("sections");
    await finish();
    assert.equal(await shown("retry"), false);
    assert.equal(await shown("edit"), false);
    const labels = await capture.evaluate(() =>
      [...document.querySelectorAll(".group-fold:not([inert]) .group")].map(
        (e) => e.getAttribute("aria-label"),
      ),
    );
    assert.equal(labels.length, 2);
    assert.match(labels[0], /2 reads · 1 command/);
    assert.match(labels[1], /1 command · 1 edit/);
    yield {
      name: theme + "-message-section-summaries",
      inspect: ["ex-turn", summary("retry"), summary("edit")],
    };
    await scroll(summary("retry"));
    await capture.click(summary("retry"));
    yield* timelineFrames(
      capture,
      theme + "-section-reveal",
      [0, 100, 200, 320],
      [summary("retry"), row("retry")],
    );
    await finish();
    assert.equal(await shown("retry"), true);
    assert.equal(await shown("edit"), false);
    await scroll(summary("retry"));
    await capture.press("Enter");
    await finish();
    assert.equal(await shown("retry"), false);
    assert.equal(
      await capture.evaluate(
        (s) => document.activeElement === document.querySelector(s),
        summary("retry"),
      ),
      true,
    );
    await capture.press("Enter");
    await capture.press("Enter");
    await capture.press("Enter");
    await finish();
    assert.equal(await shown("retry"), true);
    yield {
      name: theme + "-interrupted-section-toggle",
      inspect: [summary("retry"), row("retry")],
    };
    await capture.press("Enter");
    await finish();

    await scroll("ex-turn .work");
    await capture.click("ex-turn .work");
    await finish();
    await capture.click("ex-turn .work");
    await finish();
    assert.equal(await shown("retry"), true);
    assert.equal(await shown("edit"), true);
    yield { name: theme + "-expand-all-activity", inspect: ["ex-turn"] };
    await scroll("ex-turn .work");
    await capture.click("ex-turn .work");
    await finish();
    assert.equal(await shown("retry"), false);
    assert.equal(await shown("edit"), false);
    await capture.component("ex-turn", (c) => c.toggled.set(null));

    await scene("active-ten");
    await finish();
    assert.equal(await shown("check-0"), true);
    yield { name: theme + "-ten-active-steps", inspect: ["ex-turn"] };
    await scene("active-eleven");
    await finish();
    assert.equal(await shown("check-0"), false);
    assert.equal(await shown("check-5"), false);
    assert.equal(await shown("check-6"), true);
    assert.equal(await shown("check-10"), true);
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).textContent,
        summary("check-0"),
      ),
      /6 commands/,
    );
    yield {
      name: theme + "-active-section-five-recent",
      inspect: ["ex-turn", summary("check-0")],
    };

    await scene("busy");
    await finish();
    assert.equal(await shown("watch"), true);
    assert.equal(await shown("database"), false);
    assert.equal(await shown("check-0"), false);
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).textContent,
        summary("watch"),
      ),
      /9 commands/,
    );
    yield {
      name: theme + "-failure-merged-running-visible",
      inspect: ["ex-turn", row("watch"), row("database")],
    };

    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).getAttribute("aria-label"),
        summary("watch"),
      ),
      /1 failed · 9 commands/,
    );
    await capture.evaluate((s) => {
      document.querySelector(s).dataset.retained = "summary";
    }, summary("watch"));
    await scroll(summary("watch"));
    await capture.evaluate(
      (s) => document.querySelector(s).focus(),
      summary("watch"),
    );
    await scene("busy-receipt");
    await finish();
    assert.equal(await shown("watch"), false);
    assert.equal(
      await capture.evaluate(
        (s) =>
          document.activeElement === document.querySelector(s) &&
          document.querySelector(s).dataset.retained === "summary",
        summary("watch"),
      ),
      true,
    );
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).getAttribute("aria-label"),
        summary("watch"),
      ),
      /2 failed · 10 commands/,
    );
    yield {
      name: theme + "-second-failure-updates-summary",
      inspect: ["ex-turn", summary("watch")],
    };
    await scene("failure-only");
    await finish();
    assert.equal(await shown("database"), false);
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).getAttribute("aria-label"),
        summary("database"),
      ),
      /1 failed · 1 command/,
    );
    await scroll(summary("database"));
    yield {
      name: theme + "-failure-only-summary",
      inspect: [summary("database")],
    };
    await capture.click(summary("database"));
    await finish();
    await scroll(head("database"));
    await capture.click(head("database"));
    await finish();
    assert.equal(await shown("database"), true);
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).textContent,
        row("database"),
      ),
      /database is unavailable/,
    );
    yield { name: theme + "-failed-call-details", inspect: [row("database")] };
    await scroll(summary("database"));
    await capture.click(summary("database"));
    await finish();
    assert.equal(await shown("database"), false);
    assert.equal(
      await capture.evaluate(
        (s) => document.activeElement === document.querySelector(s),
        summary("database"),
      ),
      true,
    );

    await scene("long");
    await finish();
    const before = await capture.rect("ex-turn");
    await scene("finished");
    await finish();
    const after = await capture.rect("ex-turn");
    assert.equal(await shown("check-19"), false);
    assert.ok(
      Math.abs(after.height - before.height) < 50,
      JSON.stringify({ before, after }),
    );
    yield {
      name: theme + "-completion-preserves-messages",
      inspect: ["ex-turn"],
      metadata: { before, after },
    };

    await capture.viewport(1000, 760);
    await capture.reducedMotion(true);
    await scene("failed-sections");
    await finish();
    await scroll(summary("retry"));
    assert.equal(
      await capture.evaluate(() => {
        const bounds = document
          .querySelector("ex-work-timeline")
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll(
            "ex-work-timeline .group, ex-work-timeline .summary-fact",
          ),
        ].every((e) => {
          const r = e.getBoundingClientRect();
          return r.left >= bounds.left - 1 && r.right <= bounds.right + 1;
        });
      }),
      true,
    );
    assert.match(
      await capture.evaluate(
        (s) => document.querySelector(s).getAttribute("aria-label"),
        summary("retry"),
      ),
      /1 failed · 2 reads · 1 command/,
    );
    yield {
      name: theme + "-narrow-reduced-motion",
      inspect: ["ex-turn", summary("edit")],
    };
    await capture.viewport(700, 760);
    await finish();
    yield {
      name: theme + "-compact-section-summaries",
      inspect: ["ex-turn", summary("edit")],
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
  await scroll(summary("test"));
  await capture.click(summary("test"));
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
  assert.equal(
    await capture.evaluate(() => document.activeElement?.getAttribute("role")),
    "dialog",
  );
  yield {
    name: "full-output-reader",
    inspect: ['[role="dialog"][aria-label="Full transcript content"]'],
  };
  await capture.evaluate(() => {
    const pre = document.querySelector(
      'pre[aria-label="Original tool output"]',
    );
    pre.scrollTop = pre.scrollHeight;
  });
  await capture.click(
    '[role="dialog"][aria-label="Full transcript content"] footer button:last-child',
  );
  await capture.waitFor(() =>
    document
      .querySelector(
        '[role="dialog"][aria-label="Full transcript content"] footer span',
      )
      ?.textContent.includes("16001"),
  );
  assert.equal(
    await capture.evaluate(
      () =>
        document.querySelector('pre[aria-label="Original tool output"]')
          .scrollTop,
    ),
    0,
  );
  yield {
    name: "next-output-page-starts-at-top",
    inspect: ['[role="dialog"][aria-label="Full transcript content"]'],
  };
  const input =
    '[role="radiogroup"][aria-label="Tool content"] button:last-child';
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
