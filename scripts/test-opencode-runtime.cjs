#!/usr/bin/env node
// Requires a built backend and OpenCode CLI. Every model request goes to the local fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "elevenex-opencode-test-"),
  );
  for (const kind of ["data", "state", "cache", "config"])
    process.env[`XDG_${kind.toUpperCase()}_HOME`] = path.join(root, kind);
  delete process.env.OPENCODE_CONFIG;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENCODE_CONFIG_CONTENT;
  const {
    OpenCodeServer,
  } = require("../apps/backend/dist/opencode-runtime/opencode-server.js");
  const {
    openCodeMajorVersion,
  } = require("../apps/backend/dist/opencode-runtime/opencode-version.js");
  const {
    loadOpenCodeModels,
  } = require("../apps/backend/dist/opencode-runtime/opencode-model-catalog.js");
  const { findBinary } = require("../apps/backend/dist/config/system-paths.js");
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "fixture.txt"), "OpenCode tool fixture");
  const requests = [];
  let endpoint;
  let server;
  const controller = new AbortController();
  const streamController = new AbortController();
  controller.signal.addEventListener("abort", () => streamController.abort(), {
    once: true,
  });
  const deadline = setTimeout(() => controller.abort(), 45_000);
  try {
    const major = await openCodeMajorVersion(
      process.env.OPENCODE_BINARY || findBinary("opencode") || "opencode",
      cwd,
      process.env,
    );
    endpoint = http.createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        assert.equal(req.url, "/v1/chat/completions");
        const body = JSON.parse(raw);
        requests.push(body);
        assert.equal(body.model, "fake");
        const toolRequested = body.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Read fixture"),
        );
        const toolAnswered = body.messages.some(
          (message) => message.role === "tool",
        );
        const read = body.tools?.find((tool) => tool.function.name === "read");
        const useTool = toolRequested && !toolAnswered;
        if (useTool) assert.ok(read, "Native read tool must be exposed");
        const fields = read?.function.parameters.properties ?? {};
        const args = {
          [fields.filePath ? "filePath" : "path"]: path.join(
            cwd,
            "fixture.txt",
          ),
        };
        const chunks = useTool
          ? [
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fixture",
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify(args) },
                  },
                ],
              },
            ]
          : [
              { role: "assistant", content: "" },
              { content: "Integration " },
              { content: "works" },
            ];
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "fixture",
              object: "chat.completion",
              created: 1,
              model: "fake",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Integration works" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 3,
                total_tokens: 13,
              },
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const delta of chunks)
          res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          );
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fake", choices: [{ index: 0, delta: {}, finish_reason: useTool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
    await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    const api = `http://127.0.0.1:${endpoint.address().port}/v1`;
    const config =
      major >= 2
        ? {
            model: "elevenex-test/fake",
            providers: {
              "elevenex-test": {
                name: "Local test",
                package: "@opencode/ai/providers/openai-compatible",
                settings: { baseURL: api, apiKey: "local-test" },
                models: {
                  fake: {
                    name: "Fake",
                    capabilities: {
                      tools: true,
                      input: ["text", "image"],
                      output: ["text"],
                    },
                    limit: { context: 100000, output: 10000 },
                  },
                },
              },
            },
          }
        : {
            model: "elevenex-test/fake",
            provider: {
              "elevenex-test": {
                name: "Local test",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: api, apiKey: "local-test" },
                models: {
                  fake: {
                    name: "Fake",
                    tool_call: true,
                    attachment: true,
                    modalities: { input: ["text", "image"], output: ["text"] },
                    limit: { context: 100000, output: 10000 },
                  },
                },
              },
            },
          };
    if (major >= 2)
      config.providers["elevenex-test"].models.pinned = {
        ...config.providers["elevenex-test"].models.fake,
        modelID: "fake",
        variants: [{ id: "high", settings: { temperature: 0.1 } }],
      };
    await fs.writeFile(path.join(cwd, "opencode.json"), JSON.stringify(config));
    const serverOptions = {
      cwd,
      config: {
        mcp: {
          fixture: {
            type: "local",
            command: [process.execPath, "-e", ""],
            enabled: false,
          },
        },
      },
    };
    server = new OpenCodeServer(serverOptions);
    let client = await server.start();
    assert.equal(
      await server.start(),
      client,
      "Concurrent startup must reuse its client",
    );
    const loaded = await loadOpenCodeModels(client);
    assert.ok(
      loaded.models.has("elevenex-test/fake"),
      "Project model must be discoverable",
    );
    assert.equal(
      (await client.mcp.status()).data.fixture.status,
      "disabled",
      "Injected MCP config must survive protocol conversion",
    );
    const resources = await client.resources();
    assert.ok(resources.agents.some((agent) => agent.id === "plan"));
    const events = [];
    const sub = await client.event.subscribe(
      {},
      { signal: streamController.signal },
    );
    const iterator = sub.stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, "server.connected");
    const reader = (async () => {
      for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
        events.push(event);
        if (event.type === "permission.asked")
          await client.permission.reply({
            requestID: event.properties.id,
            reply: "once",
          });
      }
    })();
    // Keep a rejected stream from becoming an unhandled rejection during test cleanup.
    void reader.catch(() => undefined);
    const session = (
      await client.session.create({
        title: "Local integration test",
        permission: [{ permission: "*", pattern: "*", action: "ask" }],
      })
    ).data;
    const model = { providerID: "elevenex-test", modelID: "fake" };
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAIklEQVR4nGOUS1nFQApgIkk1w6gG4gATkergYFQDMYBkDQDIGQFMxbWePwAAAABJRU5ErkJggg==";
    const result = (
      await client.session.prompt(
        {
          sessionID: session.id,
          model,
          agent: "plan",
          system: "Elevenex test instruction",
          parts: [
            { type: "text", text: "Test" },
            {
              type: "file",
              mime: "image/png",
              url: `data:image/png;base64,${image}`,
            },
          ],
        },
        { signal: controller.signal },
      )
    ).data;
    assert.ok(result && !result.info.error, "Prompt must succeed");
    assert.equal(
      result.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      "Integration works",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(
      events.some(
        (event) =>
          event.type === "message.part.delta" ||
          event.type === "message.part.updated",
      ),
      "Output must stream",
    );
    assert.ok(
      requests.some((request) =>
        JSON.stringify(request.messages).includes("Elevenex test instruction"),
      ),
      "Mission instructions must reach the model",
    );
    if (major >= 2) {
      await client.session.prompt(
        {
          sessionID: session.id,
          model: { providerID: "elevenex-test", modelID: "pinned" },
          variant: "high",
          agent: "build",
          parts: [{ type: "text", text: "Pin a model" }],
        },
        { signal: controller.signal },
      );
      assert.equal(
        (await client.selection(session.id)).model,
        "elevenex-test/pinned",
      );
      assert.equal((await client.selection(session.id)).variant, "high");
      await client.session.prompt(
        {
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Restore agent default" }],
        },
        { signal: controller.signal },
      );
      assert.equal(
        (await client.selection(session.id)).model,
        "elevenex-test/fake",
        "Agent default must replace the previously pinned model",
      );
      assert.equal(
        (await client.selection(session.id)).variant,
        "default",
        "Agent default must clear the pinned variant",
      );
    }
    await client.compact(session.id);
    await client.session.prompt(
      {
        sessionID: session.id,
        model,
        agent: "build",
        parts: [{ type: "text", text: "Read fixture" }],
      },
      { signal: controller.signal },
    );
    const history = (await client.session.messages({ sessionID: session.id }))
      .data;
    const tool = history
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool");
    if (!tool)
      console.log({
        toolRequested: requests.map((r) => ({
          user: r.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content),
          tools: r.tools?.map((t) => t.function.name),
        })),
        error: history.at(-1)?.info.error,
      });
    assert.ok(
      tool && tool.state.status === "completed",
      "Native tool must complete",
    );
    assert.ok(tool.state.output.includes("OpenCode tool fixture"));
    assert.ok(
      events.some((event) => event.type === "permission.asked"),
      "Native approval must be answered",
    );
    assert.ok(
      history.some((message) =>
        message.parts.some(
          (part) => part.type === "file" && part.url.includes(image),
        ),
      ),
      "Image attachments must survive native history",
    );
    assert.ok(
      requests.some((request) =>
        JSON.stringify(request.messages).includes(image),
      ),
      "Images must reach the model",
    );
    streamController.abort();
    server.close();
    await reader.catch(() => undefined);
    server = new OpenCodeServer(serverOptions);
    client = await server.start();
    assert.deepEqual(
      (await client.session.messages({ sessionID: session.id })).data.map(
        (message) => message.info.id,
      ),
      history.map((message) => message.info.id),
      "Native history must survive restarting the server",
    );
    const fork = (await client.session.fork({ sessionID: session.id })).data;
    assert.ok(
      (await client.session.messages({ sessionID: fork.id })).data.length > 0,
    );
    await client.session.delete({ sessionID: fork.id });
    const user = history.find((message) => message.info.role === "user");
    if (client.rewindHistory)
      await client.rewindHistory(session.id, user.info.id);
    else
      for (const message of history)
        await client.session.deleteMessage({
          sessionID: session.id,
          messageID: message.info.id,
        });
    assert.equal(
      (await client.session.messages({ sessionID: session.id })).data.length,
      0,
    );
    assert.equal(
      await fs.readFile(path.join(cwd, "fixture.txt"), "utf8"),
      "OpenCode tool fixture",
    );
    await client.session.delete({ sessionID: session.id });
    controller.abort();
    await reader.catch(() => undefined);
    console.log(
      `PASS OpenCode v${major}: project models, native agents, instructions, streaming, approvals, tools, images, compaction, MCP config, restart, persisted history, fork, and history-only rewind.`,
    );
  } finally {
    clearTimeout(deadline);
    controller.abort();
    server?.close();
    if (endpoint) {
      endpoint.closeAllConnections();
      await new Promise((resolve) => endpoint.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
