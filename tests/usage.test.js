"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  billingFromLog,
  dailyHistoryFromLog,
  parseBillingPayload,
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
