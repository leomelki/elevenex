import assert from "node:assert/strict";

/** A compact rail for short conversations and thousands of navigation targets. */
export default async function* (capture) {
  await capture.evaluate(() => {
    location.href = "/conversation";
  });
  await capture.waitFor(() =>
    document.querySelector(".navigation-demo .markers"),
  );
  for (const theme of ["light", "dark"]) {
    await capture.theme(theme);
    for (const count of [1, 10000]) {
      await capture.component(
        "ex-conversation-demo",
        (component, count) => component.navigationSize(count),
        count,
      );
      await capture.evaluate(() =>
        document
          .querySelector(".navigation-demo")
          .scrollIntoView({ block: "center" }),
      );
      await capture.waitFor(() =>
        document.querySelector('.navigation-demo [aria-current="step"]'),
      );
      const geometry = await capture.evaluate(() => {
        const stage = document.querySelector(".navigation-demo");
        const rail = stage.querySelector("ex-turn-nav");
        return {
          height: rail.getBoundingClientRect().height,
          parent: stage.clientHeight,
          rows: rail.querySelectorAll("button").length,
        };
      });
      assert.ok(
        geometry.height <= geometry.parent * 0.4 + 1,
        JSON.stringify(geometry),
      );
      assert.ok(geometry.height <= 224, JSON.stringify(geometry));
      assert.ok(
        geometry.rows > 0 && geometry.rows < 30,
        JSON.stringify(geometry),
      );
      yield {
        name: `${theme}-${count}-compact`,
        selector: ".navigation-demo",
        metadata: geometry,
      };
      if (count === 1) continue;
      // Large windows expose all nine targets; smaller ones retain the 40% cap.
      await capture.evaluate(() => {
        const stage = document.querySelector(".navigation-demo");
        stage.style.height = "640px";
        stage.scrollIntoView({ block: "center" });
      });
      await capture.waitFor(() => {
        const viewport = document.querySelector(".navigation-demo .markers");
        const box = viewport.getBoundingClientRect();
        return viewport.clientHeight === 216 && Array.from(viewport.querySelectorAll("button")).filter(button => {
          const row = button.getBoundingClientRect();
          return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
        }).length === 9;
      });
      const expanded = await capture.evaluate(() => {
        const rail = document.querySelector(".navigation-demo ex-turn-nav");
        const box = rail.querySelector(".markers").getBoundingClientRect();
        return {
          height: rail.getBoundingClientRect().height,
          visible: Array.from(rail.querySelectorAll("button")).filter(button => {
            const row = button.getBoundingClientRect();
            return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
          }).length,
        };
      });
      assert.equal(expanded.height, 224);
      assert.equal(expanded.visible, 9);
      yield { name: `${theme}-nine-markers`, selector: ".navigation-demo", metadata: expanded };
      await capture.evaluate(() => { document.querySelector(".navigation-demo").style.height = ""; });
      await capture.settle();
      const viewport = ".navigation-demo .markers";
      await capture.evaluate(() =>
        document.querySelector(".navigation-demo .markers").focus(),
      );
      await capture.press("End");
      await capture.waitFor(() => {
        const list = document.querySelector(".navigation-demo .markers");
        return (
          document
            .getElementById(list.getAttribute("aria-activedescendant"))
            ?.getAttribute("aria-posinset") === "10000"
        );
      });
      assert.equal(
        await capture.component("ex-conversation-demo", (c) =>
          c.navigationActive(),
        ),
        "navigation-5000",
      );
      await capture.press("Enter");
      assert.equal(
        await capture.component("ex-conversation-demo", (c) =>
          c.navigationActive(),
        ),
        "navigation-9999",
      );
      assert.equal(
        await capture.evaluate(() =>
          document.activeElement.classList.contains("markers"),
        ),
        true,
      );
      yield {
        name: `${theme}-last-keyboard`,
        selector: ".navigation-demo",
        inspect: [viewport, '.navigation-demo [aria-selected="true"]'],
      };
      await capture.press("Home");
      await capture.press("PageDown");
      await capture.press("ArrowUp");
      await capture.press("Enter");
      const selected = await capture.component("ex-conversation-demo", (c) =>
        c.navigationActive(),
      );
      assert.ok(selected !== "navigation-9999" && selected !== "navigation-0");
      // Pointer browsing must hold the rail still when the chat's current turn changes.
      await capture.evaluate(() => document.activeElement.blur());
      await capture.hover(".navigation-demo nav");
      const before = await capture.evaluate(
        () => document.querySelector(".navigation-demo .markers").scrollTop,
      );
      await capture.component("ex-conversation-demo", (c) =>
        c.navigationActive.set("navigation-8000"),
      );
      assert.equal(
        await capture.evaluate(
          () => document.querySelector(".navigation-demo .markers").scrollTop,
        ),
        before,
      );
      // Wheel browsing stays local to the rail and retains bounded DOM.
      const wheel = await capture.evaluate(() => {
        const box = document
          .querySelector(".navigation-demo .markers")
          .getBoundingClientRect();
        return {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2,
          parentScroll: document.querySelector(".preview-content").scrollTop,
        };
      });
      await capture.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: wheel.x,
        y: wheel.y,
        deltaX: 0,
        deltaY: 120,
      });
      await capture.waitFor(
        (offset) =>
          document.querySelector(".navigation-demo .markers").scrollTop >
          offset,
        before,
      );
      assert.equal(
        await capture.evaluate(
          () => document.querySelector(".preview-content").scrollTop,
        ),
        wheel.parentScroll,
      );
      assert.equal(
        await capture.component("ex-conversation-demo", (c) =>
          c.navigationActive(),
        ),
        "navigation-8000",
      );
      await capture.evaluate(() => {
        const list = document.querySelector(".navigation-demo .markers");
        list.scrollTop = 400 * 24;
        list.dispatchEvent(new window.Event("scroll"));
      });
      await capture.waitFor(() =>
        document.querySelector('.navigation-demo [aria-posinset="401"]'),
      );
      await capture.click('.navigation-demo [aria-posinset="401"]');
      assert.equal(
        await capture.component("ex-conversation-demo", (c) =>
          c.navigationActive(),
        ),
        "navigation-400",
      );
      yield {
        name: `${theme}-browse-select`,
        selector: ".navigation-demo",
        inspect: [viewport],
      };
    }
    await capture.viewport(480, 620);
    await capture.reducedMotion(true);
    await capture.evaluate(() => document.activeElement.blur());
    await capture.component("ex-conversation-demo", (c) =>
      c.navigationSize(1000),
    );
    await capture.evaluate(() =>
      document
        .querySelector(".navigation-demo")
        .scrollIntoView({ block: "center" }),
    );
    yield {
      name: `${theme}-narrow-reduced`,
      selector: ".navigation-demo",
      inspect: [".navigation-demo ex-turn-nav"],
    };
    await capture.evaluate(() => {
      document.querySelector(".navigation-demo").style.height = "80px";
    });
    await capture.settle();
    assert.ok(
      await capture.evaluate(
        () =>
          document
            .querySelector(".navigation-demo ex-turn-nav")
            .getBoundingClientRect().height <= 33,
      ),
    );
    yield {
      name: `${theme}-short`,
      selector: ".navigation-demo",
      inspect: [".navigation-demo ex-turn-nav"],
    };
    await capture.evaluate(() => {
      document.querySelector(".navigation-demo").style.height = "";
    });
    await capture.viewport(1200, 900);
    await capture.reducedMotion(false);
  }
  // Use the real Chat owner to verify that choosing a marker scrolls its transcript.
  await capture.component("ex-conversation-demo", (c) =>
    c.exchanges.set(
      Array.from({ length: 60 }, (_, index) => ({
        id: `chat-${index}`,
        prompt: `Question ${index + 1}`,
        status: "done",
        steps: [],
        answer: "A detailed answer.\n\n".repeat(6),
      })),
    ),
  );
  await capture.evaluate(() =>
    document.querySelector(".demo-chat").scrollIntoView({ block: "start" }),
  );
  // Keep the pointer over the list while Home recycles its rows. A stationary
  // pointer must not replace the keyboard choice with a newly revealed marker.
  await capture.hover("ex-chat .markers");
  await capture.evaluate(() =>
    document.querySelector("ex-chat .markers").focus(),
  );
  await capture.press("Home");
  await capture.press("Enter");
  await capture.waitFor(
    () => document.querySelector("ex-chat-scroll .viewport").scrollTop < 1,
  );
  await capture.press("End");
  await capture.press("Enter");
  await capture.waitFor(() => {
    const viewport = document.querySelector("ex-chat-scroll .viewport");
    return (
      viewport.scrollTop > 1000 &&
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 1
    );
  });
  yield {
    name: "chat-integration",
    selector: ".demo-chat",
    inspect: ["ex-chat ex-turn-nav", "ex-chat-scroll .viewport"],
  };
}
