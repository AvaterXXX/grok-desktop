"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { AcpClient } = require("../src/acp");
const { contextUsageFromPayload, normalizeContextUsage } = require("../src/context-usage");

function clientAndEvents() {
  const client = new AcpClient({ cliPath: "grok", cwd: process.cwd() });
  const events = [];
  client.on("usage", (event) => events.push(event));
  return { client, events };
}

const mainSource = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const mainAst = ts.createSourceFile("main.js", mainSource, ts.ScriptTarget.Latest, true);
const wireEvents = mainAst.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "wireAcpEvents",
);
const usageHook = wireEvents.body.statements.find((node) =>
  node.getText(mainAst).startsWith('client.on("usage",'),
);
assert.ok(usageHook);

function wireMainUsage(client) {
  const billed = [];
  const sent = [];
  vm.runInContext(
    usageHook.getText(mainAst),
    vm.createContext({
      client,
      sid: () => client.sessionId,
      withSid: (payload) => ({ ...payload, sessionId: client.sessionId }),
      noteDailyFromUsage: (payload) => billed.push(payload),
      send: (_name, payload) => sent.push(payload),
    }),
  );
  return { billed, sent };
}

function prepareDeferredPrompt(client) {
  let resolvePrompt;
  client.sessionId = "session";
  client.currentModelId = "grok-4.7-build";
  client.request = async (method) => {
    if (method === "session/prompt")
      return new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    if (method === "session/set_model") return {};
    throw new Error(method);
  };
  return (result) => resolvePrompt(result);
}

test("ACP request token totals remain billing usage instead of context occupancy", () => {
  const { client, events } = clientAndEvents();
  client.routeSessionUpdate(
    {
      sessionUpdate: "agent_message_chunk",
      content: { text: "answer" },
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cached_prompt_tokens: 30,
        model: "grok-4.7-build-fast",
      },
    },
    { sessionId: "first" },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].outputTokens, 20);
  assert.equal(events[0].totalTokens, 120);
  assert.equal(events[0].cacheReadTokens, 30);
  assert.equal(events[0].modelId, "grok-4.7-build-fast");
  assert.equal(events[0].used, null);
  assert.equal(events[0].size, null);
  assert.equal(contextUsageFromPayload(events[0]), null);
});

test("ACP explicit zero and wrapped runtime capacity survive real update routing", () => {
  const { client, events } = clientAndEvents();
  client.routeSessionUpdate(
    {
      sessionUpdate: "usage_update",
      usage: {
        contextTokensUsed: { val: 0 },
        contextWindowTokens: { val: 256000 },
        totalTokens: 100000,
        modelId: "grok-4.7-build-fast",
      },
    },
    { sessionId: "fresh" },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].used, 0);
  assert.equal(events[0].modelId, "grok-4.7-build-fast");
  const usage = normalizeContextUsage(contextUsageFromPayload(events[0]), null, {
    modelId: events[0].modelId,
  });
  assert.equal(usage.used, 0);
  assert.equal(usage.size, 256000);
  assert.equal(usage.sizeSource, "runtime");
});

test("sparse ACP metadata preserves the model and supports decreasing context after compaction", () => {
  const { client, events } = clientAndEvents();
  client.routeSessionUpdate(
    { sessionUpdate: "usage_update", context_tokens_used: 210000 },
    {
      meta: { context_window_tokens: 256000, modelId: "grok-4.7-build" },
    },
  );
  client.routeSessionUpdate(
    {
      sessionUpdate: "context_compacted",
      tokenUsage: { contextTokensUsed: 5000, model: "grok-4.7-build" },
    },
    {},
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].modelId, "grok-4.7-build");
  let usage = null;
  for (const event of events) {
    usage = normalizeContextUsage(contextUsageFromPayload(event), usage, {
      modelId: event.modelId,
    });
  }
  assert.equal(usage.used, 5000);
  assert.equal(usage.size, 256000);
});

test("empty ACP updates produce no fabricated context event", () => {
  const { client, events } = clientAndEvents();
  for (const update of [
    null,
    {},
    { sessionUpdate: "agent_message_chunk", content: { text: "ok" } },
    {
      sessionUpdate: "usage_update",
      usage: { totalTokens: null, inputTokens: null, contextTokensUsed: null },
    },
  ]) {
    client.routeSessionUpdate(update, {});
  }
  assert.deepEqual(events, []);
});

test("ACP rejects malformed numeric usage instead of emitting negative or nonfinite counters", () => {
  const { client, events } = clientAndEvents();
  for (const value of [
    false,
    " ",
    -1,
    Infinity,
    NaN,
    { val: null },
    { val: false },
    { val: Infinity },
  ]) {
    client.routeSessionUpdate(
      {
        sessionUpdate: "usage_update",
        usage: {
          inputTokens: value,
          totalTokens: value,
          contextTokensUsed: value,
          contextWindowTokens: value,
        },
      },
      {},
    );
  }
  assert.deepEqual(events, []);
});

test("streamed and terminal request usage keeps its start model when the user selects Fast", async () => {
  const { client, events } = clientAndEvents();
  const finish = prepareDeferredPrompt(client);
  const { billed, sent } = wireMainUsage(client);
  const prompt = client.prompt("work");
  await client.setModel("grok-4.7-build-fast");
  client.routeSessionUpdate(
    { sessionUpdate: "usage_update", usage: { inputTokens: 100, outputTokens: 10 } },
    {},
  );
  finish({ usage: { inputTokens: 100, outputTokens: 20 } });
  await prompt;
  assert.equal(events[1].modelId, "grok-4.7-build");
  assert.equal(billed.length, 2);
  assert.ok(billed.every((payload) => payload.modelId === "grok-4.7-build"));
  assert.ok(sent.every((payload) => payload.modelId === "grok-4.7-build"));
  assert.equal(client.currentModelId, "grok-4.7-build-fast");
});

test("each prompt captures its new model and explicit protocol attribution overrides the fallback", async () => {
  const { client } = clientAndEvents();
  const finish = prepareDeferredPrompt(client);
  const { billed } = wireMainUsage(client);
  await client.setModel("grok-4.7-build-fast");
  const prompt = client.prompt("fast work");
  await client.setModel("grok-4.7-build");
  client.routeSessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100 } }, {});
  client.routeSessionUpdate(
    { sessionUpdate: "usage_update", usage: { inputTokens: 110, modelId: "grok-4.7-build" } },
    {},
  );
  finish({ usage: { inputTokens: 120, model: "grok-4.7-build" } });
  await prompt;
  assert.equal(billed[0].modelId, "grok-4.7-build-fast");
  assert.equal(billed[1].modelId, "grok-4.7-build");
  assert.equal(billed[2].modelId, "grok-4.7-build");
});

test("an unknown request model cannot become Fast just because it was selected later", async () => {
  const { client } = clientAndEvents();
  const finish = prepareDeferredPrompt(client);
  client.currentModelId = null;
  const { billed } = wireMainUsage(client);
  const prompt = client.prompt("work with unknown model");
  await client.setModel("grok-4.7-build-fast");
  client.routeSessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100 } }, {});
  finish({ usage: { inputTokens: 100, outputTokens: 20 } });
  await prompt;
  assert.ok(billed.every((payload) => payload.modelId === "unknown"));
});

test("loading and creating sessions clear the previous prompt model, including during hydration", async () => {
  const { client } = clientAndEvents();
  const finish = prepareDeferredPrompt(client);
  const prompt = client.prompt("previous work");
  finish({});
  await prompt;
  await client.setModel("grok-4.7-build-fast");
  const { billed } = wireMainUsage(client);
  let resolveLoad;
  client.request = async (method) => {
    if (method === "session/load")
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    if (method === "session/new")
      return { sessionId: "fresh", models: { currentModelId: "grok-4.7-build-fast" } };
    throw new Error(method);
  };
  const load = client.loadSession("loaded");
  assert.equal(client.requestModelId, null);
  client.routeSessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100 } }, {});
  assert.equal(billed[0].modelId, "grok-4.7-build-fast");
  resolveLoad({ models: { currentModelId: "grok-4.7-build-fast" } });
  await load;
  assert.equal(client.requestModelId, null);
  client.requestModelId = "grok-4.7-build";
  await client.newSession();
  assert.equal(client.requestModelId, null);
  client.requestModelId = "grok-4.7-build";
  client.dispose();
  assert.equal(client.requestModelId, null);
});

test("official goal slash requests use the same frozen request model for streamed usage", async () => {
  const { client } = clientAndEvents();
  const finish = prepareDeferredPrompt(client);
  const { billed } = wireMainUsage(client);
  const runSlash = mainAst.statements.find((node) =>
    node.getText(mainAst).startsWith('handleIpc("session:run-slash",'),
  );
  assert.ok(runSlash);
  let slashHandler;
  vm.runInContext(
    runSlash.getText(mainAst),
    vm.createContext({
      handleIpc: (_name, callback) => {
        slashHandler = callback;
      },
      activeSessionId: "session",
      activeSessionMeta: null,
      getAgent: () => client,
      getAgentEntry: () => null,
      send() {},
    }),
  );
  const slash = slashHandler(null, {
    command: "goal",
    args: "finish the work",
    sessionId: "session",
  });
  await client.setModel("grok-4.7-build-fast");
  client.routeSessionUpdate({ sessionUpdate: "usage_update", usage: { inputTokens: 100 } }, {});
  finish({});
  assert.equal((await slash).ok, true);
  assert.equal(billed[0].modelId, "grok-4.7-build");
});
