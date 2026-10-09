"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  contextUsageFromPayload,
  estimateContextTokens,
  normalizeContextUsage,
} = require("../src/context-usage");

test("context payloads use explicit occupancy, never request totals", () => {
  for (const payload of [
    null,
    undefined,
    42,
    "",
    [],
    {},
    { totalTokens: 100000 },
    { inputTokens: 999, outputTokens: 1 },
  ]) {
    assert.equal(contextUsageFromPayload(payload), null);
  }
  assert.deepEqual(
    contextUsageFromPayload({
      contextTokensUsed: 0,
      contextWindowTokens: 256000,
      totalTokens: 100000,
    }),
    {
      used: 0,
      size: 256000,
      estimated: false,
    },
  );
  assert.deepEqual(
    contextUsageFromPayload({ context_tokens_used: { val: 20 }, context_window_tokens: "256000" }),
    {
      used: 20,
      size: 256000,
      estimated: false,
    },
  );
  assert.deepEqual(contextUsageFromPayload({ used: 0 }), { used: 0, size: null, estimated: false });
  assert.deepEqual(contextUsageFromPayload({ used: 0, modelId: "grok-4.7-build-fast" }), {
    used: 0,
    size: null,
    estimated: false,
    modelId: "grok-4.7-build-fast",
  });
});

test("invalid measurements cannot create a false zero or a bogus capacity", () => {
  for (const value of [
    "",
    " ",
    false,
    -1,
    Infinity,
    NaN,
    { val: null },
    { val: "" },
    { val: false },
  ]) {
    assert.equal(contextUsageFromPayload({ used: value, size: value }), null);
  }
  assert.deepEqual(
    contextUsageFromPayload({
      contextTokensUsed: "invalid",
      used: 20,
      contextWindowTokens: 0,
      size: 256000,
    }),
    {
      used: 20,
      size: 256000,
      estimated: false,
    },
  );
  assert.deepEqual(contextUsageFromPayload({ used: 5, size: -1 }), {
    used: 5,
    size: null,
    estimated: false,
  });
  assert.deepEqual(contextUsageFromPayload({ size: 256000 }), {
    used: null,
    size: 256000,
    estimated: false,
  });
});

test("new sessions start at zero with no fixed context offset or inherited measurement", () => {
  assert.equal(estimateContextTokens(0), 0);
  assert.equal(estimateContextTokens(4), 1);
  assert.equal(estimateContextTokens(5), 2);
  assert.equal(estimateContextTokens(-1), 0);
  const first = normalizeContextUsage({ used: 110000, size: 256000, estimated: false }, null, {
    modelId: "grok-4.7",
  });
  const fresh = normalizeContextUsage({ used: estimateContextTokens(0), estimated: true }, null, {
    modelId: "grok-4.7",
  });
  assert.equal(first.used, 110000);
  assert.equal(fresh.used, 0);
  assert.equal(fresh.size, 500000);
});

test("runtime capacity wins over metadata and survives estimates and sparse updates", () => {
  const options = { modelId: "grok-4.7", modelEntry: { contextWindowTokens: 400000 } };
  const first = normalizeContextUsage(
    { used: 100000, size: 256000, estimated: false },
    null,
    options,
  );
  assert.equal(first.size, 256000);
  assert.equal(first.sizeSource, "runtime");
  const estimated = normalizeContextUsage(
    { used: 120000, size: 500000, estimated: true },
    first,
    options,
  );
  assert.equal(estimated.size, 256000);
  assert.equal(estimated.used, 100000);
  assert.equal(estimated.estimated, false);
  const sparse = normalizeContextUsage({ used: 110000, estimated: false }, estimated, options);
  assert.equal(sparse.size, 256000);
  assert.equal(sparse.used, 110000);
  const changed = normalizeContextUsage({ size: 300000, estimated: false }, sparse, options);
  assert.equal(changed.size, 300000);
  assert.equal(changed.used, 110000);
});

test("measured context can drop after compaction and reset to explicit zero", () => {
  const options = { modelId: "grok-4.7" };
  const full = normalizeContextUsage(
    { used: 200000, size: 256000, estimated: false },
    null,
    options,
  );
  const compacted = normalizeContextUsage({ used: 15000, estimated: false }, full, options);
  assert.equal(compacted.used, 15000);
  const zero = normalizeContextUsage({ used: 0, estimated: false }, compacted, options);
  assert.equal(zero.used, 0);
  assert.equal(zero.estimated, false);
  assert.equal(normalizeContextUsage({ used: 2000, estimated: true }, zero, options).used, 0);
});

test("a model switch keeps conversation occupancy while discarding the old runtime capacity", () => {
  const ordinary = normalizeContextUsage({ used: 40000, size: 256000, estimated: false }, null, {
    modelId: "grok-4.7-build",
  });
  const fast = normalizeContextUsage(null, ordinary, { modelId: "grok-4.7-build-fast" });
  assert.equal(fast.used, 40000);
  assert.equal(fast.estimated, true);
  assert.equal(fast.size, 500000);
  assert.equal(fast.sizeSource, "model");
  const measuredFast = normalizeContextUsage(
    { used: 35000, size: 256000, estimated: false },
    fast,
    { modelId: "grok-4.7-build-fast" },
  );
  assert.equal(measuredFast.used, 35000);
  assert.equal(measuredFast.estimated, false);
  assert.equal(measuredFast.sizeSource, "runtime");
});

test("unknown capacity stays unknown and invalid updates preserve existing context", () => {
  const unknown = normalizeContextUsage(null, null, { modelId: "custom-model" });
  assert.equal(unknown.size, null);
  assert.equal(unknown.used, 0);
  const first = normalizeContextUsage({ used: 20000, size: 256000, estimated: false }, null, {
    modelId: "grok-4.7",
  });
  const invalid = normalizeContextUsage({ used: NaN, size: -1, estimated: false }, first, {
    modelId: "grok-4.7",
  });
  assert.equal(invalid.used, 20000);
  assert.equal(invalid.size, 256000);
});

test("both shared modules work together in a sandboxed browser without require", () => {
  const context = vm.createContext({});
  for (const file of ["model-info.js", "context-usage.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context);
  }
  assert.equal(
    vm.runInContext(
      'GrokContextUsage.normalizeContextUsage(null, null, { modelId: "grok-4.7" }).size',
      context,
    ),
    500000,
  );
  assert.equal(
    vm.runInContext("GrokContextUsage.contextUsageFromPayload({ used: 0 }).used", context),
    0,
  );
});
