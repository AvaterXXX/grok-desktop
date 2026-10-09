"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const usage = require("../src/usage");

const source = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
const ast = ts.createSourceFile("main.js", source, ts.ScriptTarget.Latest, true);
const accountHandler = ast.statements.find((node) =>
  node.getText(ast).startsWith('handleIpc("account:usage",'),
);
assert.ok(accountHandler);
const from = "2026-10-01T00:00:00.000Z";
const billing = { percent: 10, periodStart: from, resetAt: "2026-10-08T00:00:00.000Z" };

function bucket(input, output = 0) {
  return { tokens: input + output, input, output, reasoning: 0, cache: 0 };
}

function inference(model, input, output = 0, time = "2026-10-02T12:00:00Z") {
  return JSON.stringify({
    ts: time,
    msg: "inference_done",
    ctx: { model, prompt_tokens: input, completion_tokens: output },
  });
}

async function queryUsage({ storedWeek, lastBilling = billing, log = "", dailyHistory = {} }) {
  let handler;
  const desk = { weekUsage: storedWeek, lastBilling, dailyHistory };
  const context = vm.createContext({
    ...usage,
    shanghaiDate: (date) => (date ? usage.shanghaiDate(date) : "2026-10-03"),
    settings: {
      readDesktopSettings: () => desk,
      writeDesktopSettings: (updates) => Object.assign(desk, updates),
    },
    handleIpc: (_name, callback) => {
      handler = callback;
    },
    applyProxyEnv() {},
    anyLiveAgent: () => null,
    readUnifiedTail: () => "",
    readUnifiedLog: () => log,
    lastUsageTurn: new Map(),
    activeSessionId: "session",
    perf() {},
    log() {},
  });
  vm.runInContext(accountHandler.getText(ast), context);
  return { result: await handler(null, {}), persisted: desk.weekUsage };
}

test("account usage keeps a complete same-period Fast snapshot when logs contain only ordinary requests", async () => {
  const storedWeek = {
    from,
    ...bucket(300, 30),
    byModel: { "grok-4.7": bucket(100, 10), "grok-4.7-fast": bucket(200, 20) },
  };
  const { result, persisted } = await queryUsage({
    storedWeek,
    log: inference("grok-4.7-build", 100, 10),
  });
  assert.equal(result.weekTokens, 330);
  assert.equal(result.weekInput, 300);
  assert.equal(result.weekByModel["grok-4.7"].tokens, 110);
  assert.equal(result.weekByModel["grok-4.7-fast"].tokens, 220);
  assert.equal(persisted.tokens, 330);
  assert.equal(persisted.byModel["grok-4.7-fast"].tokens, 220);
});

test("account usage merges complementary current-period model snapshots and keeps unknown totals", async () => {
  const storedWeek = { from, ...bucket(300, 30), byModel: { "grok-4.7-fast": bucket(200, 20) } };
  const { result } = await queryUsage({ storedWeek, log: inference("grok-4.7-build", 150, 15) });
  assert.equal(result.weekTokens, 385);
  assert.equal(result.weekInput, 350);
  assert.equal(result.weekOutput, 35);
  const unknown = await queryUsage({
    storedWeek: { from, ...bucket(500, 50), byModel: { "grok-4.7-fast": bucket(200, 20) } },
    log: inference("grok-4.7-build", 100, 10),
  });
  assert.equal(unknown.result.weekTokens, 550);
  assert.equal(unknown.result.weekInput, 500);
});

test("account usage excludes stored snapshots and log events from a different billing period", async () => {
  const storedWeek = {
    from: "2026-09-24T00:00:00.000Z",
    ...bucket(900),
    byModel: { "grok-4.7-fast": bucket(900) },
  };
  const { result, persisted } = await queryUsage({
    storedWeek,
    log: [
      inference("grok-4.7-fast", 800, 0, "2026-09-30T12:00:00Z"),
      inference("grok-4.7-build", 100),
    ].join("\n"),
  });
  assert.equal(result.weekTokens, 100);
  assert.equal(result.weekByModel["grok-4.7-fast"], undefined);
  assert.equal(persisted.from, from);
});

test("undated snapshots cannot contaminate the fallback history date range", async () => {
  const storedWeek = { from: "", ...bucket(900), byModel: { "grok-4.7-fast": bucket(900) } };
  const { result } = await queryUsage({
    storedWeek,
    lastBilling: null,
    dailyHistory: {
      "2026-09-20": { ...bucket(800), byModel: { "grok-4.7-fast": bucket(800) } },
      "2026-10-02": { ...bucket(100), byModel: { "grok-4.7": bucket(100) } },
    },
  });
  assert.equal(result.weekTokens, 100);
  assert.equal(result.weekByModel["grok-4.7-fast"], undefined);
});
