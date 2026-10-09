"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  billingFromLog,
  dailyHistoryFromLog,
  parseBillingPayload,
  mergeDayMax,
  mergeByModelMax,
  mergeUsageSnapshots,
  pruneHistory,
  usageSinceFromLog,
} = require("../src/usage");

test("normalizes ACP billing payloads and recovers the latest log value", () => {
  const first = parseBillingPayload({
    config: {
      used: { val: 25 },
      monthlyLimit: { val: 100 },
      currentPeriod: { start: "2026-08-22T00:00:00Z", end: "2026-08-29T00:00:00Z" },
    },
    subscriptionTier: "pro",
  });
  assert.equal(first.percent, 25);
  assert.equal(first.subscriptionTier, "pro");

  const log = [
    JSON.stringify({
      msg: "billing: fetched credits config",
      data: { creditUsagePercent: 10, currentPeriod: { end: "2026-08-28T00:00:00Z" } },
    }),
    JSON.stringify({
      msg: "billing: fetched credits config",
      data: { creditUsagePercent: 42, currentPeriod: { end: "2026-08-29T00:00:00Z" } },
    }),
  ].join("\n");
  assert.equal(billingFromLog(log).percent, 42);
});

test("aggregates inference JSONL by Shanghai day and time range", () => {
  const events = [
    {
      ts: "2026-08-28T17:00:00Z",
      msg: "inference_done",
      ctx: { model: "grok-4.6", prompt_tokens: 100, completion_tokens: 20, cached_tokens: 8 },
    },
    {
      ts: "2026-08-29T02:00:00Z",
      msg: "inference_done",
      ctx: { model: "grok-4.5", prompt_tokens: 50, completion_tokens: 10, reasoning_tokens: 5 },
    },
    { ts: "2026-08-29T03:00:00Z", msg: "not_usage", ctx: {} },
  ];
  const log = events.map(JSON.stringify).join("\n");
  const days = dailyHistoryFromLog(log);
  assert.equal(days["2026-08-29"].tokens, 185);
  assert.equal(days["2026-08-29"].cache, 8);
  assert.equal(days["2026-08-29"].byModel["grok-4.6"].tokens, 120);
  assert.equal(days["2026-08-29"].byModel["grok-4.5"].tokens, 65);

  const since = usageSinceFromLog(log, Date.parse("2026-08-29T00:00:00Z"));
  assert.equal(since.tokens, 65);
});

test("prunes usage history deterministically", () => {
  const history = {
    "2026-08-27": { tokens: 1 },
    "2026-08-28": { tokens: 2 },
    "2026-08-29": { tokens: 3 },
  };
  assert.deepEqual(Object.keys(pruneHistory(history, 2)), ["2026-08-28", "2026-08-29"]);
});

test("Fast model token buckets survive daily merging and history persistence", () => {
  const log = [
    {
      ts: "2026-10-02T12:00:00Z",
      msg: "inference_done",
      ctx: { model: "grok-4.7-build", prompt_tokens: 100, completion_tokens: 20 },
    },
    {
      ts: "2026-10-02T12:01:00Z",
      msg: "inference_done",
      ctx: { model: "grok-4.7-build-fast", prompt_tokens: 200, completion_tokens: 30 },
    },
  ]
    .map(JSON.stringify)
    .join("\n");
  const days = dailyHistoryFromLog(log);
  const merged = mergeDayMax(days["2026-10-02"], { tokens: 200 });
  const restored = pruneHistory({ "2026-10-02": merged });
  assert.equal(restored["2026-10-02"].byModel["grok-4.7"].tokens, 120);
  assert.equal(restored["2026-10-02"].byModel["grok-4.7-fast"].tokens, 230);
});

test("legacy aliases add within one history source and deduplicate across snapshots", () => {
  const first = {
    "grok-4.7-build": { tokens: 100, input: 80, output: 20 },
    "grok-4.7": { tokens: 200, input: 160, output: 40 },
    "grok-4.7-build-fast": { tokens: 50, input: 40, output: 10 },
  };
  const merged = mergeByModelMax(first, {
    "grok-4.7": { tokens: 300, input: 240, output: 60 },
  });
  assert.equal(merged["grok-4.7"].tokens, 300);
  assert.equal(merged["grok-4.7"].input, 240);
  assert.equal(merged["grok-4.7-fast"].tokens, 50);
});

test("same-period usage snapshots preserve Fast and unknown buckets without counting twice", () => {
  const stored = {
    tokens: 350,
    input: 300,
    output: 50,
    cache: 80,
    byModel: {
      "grok-4.7-build": { tokens: 110, input: 100, output: 10, cache: 20 },
      "grok-4.7-build-fast": { tokens: 220, input: 180, output: 40, cache: 60 },
      unknown: { tokens: 20, input: 20 },
    },
  };
  const partialLog = {
    tokens: 110,
    input: 100,
    output: 10,
    cache: 20,
    byModel: { "grok-4.7": { tokens: 110, input: 100, output: 10, cache: 20 } },
  };
  const merged = mergeUsageSnapshots(stored, partialLog);
  assert.equal(merged.tokens, 350);
  assert.equal(merged.input, 300);
  assert.equal(merged.output, 50);
  assert.equal(merged.cache, 80);
  assert.equal(merged.byModel["grok-4.7-fast"].tokens, 220);
  assert.equal(merged.byModel.unknown.tokens, 20);
  assert.equal(mergeUsageSnapshots(merged, partialLog).tokens, 350);
});

test("complementary model snapshots cannot sum to more than their merged aggregate", () => {
  const ordinary = {
    tokens: 120,
    input: 100,
    output: 20,
    byModel: { "grok-4.7": { tokens: 120, input: 100, output: 20 } },
  };
  const fast = {
    tokens: 240,
    input: 200,
    output: 40,
    byModel: { "grok-4.7-fast": { tokens: 240, input: 200, output: 40 } },
  };
  const merged = mergeUsageSnapshots(ordinary, fast);
  assert.equal(merged.tokens, 360);
  assert.equal(merged.input, 300);
  assert.equal(merged.output, 60);
  assert.equal(
    merged.tokens,
    Object.values(merged.byModel).reduce((sum, bucket) => sum + bucket.tokens, 0),
  );
  const withUnknown = mergeUsageSnapshots({ tokens: 500, input: 400, output: 100 }, merged);
  assert.equal(withUnknown.tokens, 500);
  assert.equal(withUnknown.input, 400);
  assert.equal(withUnknown.output, 100);
});

test("snapshot merging preserves sparse cached counters and ignores malformed aggregates", () => {
  const merged = mergeUsageSnapshots(
    {
      tokens: 110,
      input: 100,
      output: 10,
      byModel: { "grok-4.7": { tokens: 110, input: 100, output: 10 } },
    },
    {
      tokens: Infinity,
      input: -1,
      cache: 50,
      byModel: { "grok-4.7-build": { tokens: 100, input: 100, cache: 50 } },
    },
  );
  assert.equal(merged.tokens, 110);
  assert.equal(merged.input, 100);
  assert.equal(merged.output, 10);
  assert.equal(merged.cache, 50);
  assert.equal(merged.byModel["grok-4.7"].cache, 50);
});
