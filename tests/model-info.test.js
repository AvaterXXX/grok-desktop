"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  apiRatesForModel,
  estimateApiUsd,
  modelContextSize,
  modelFamilyOf,
  numberOrNull,
} = require("../src/model-info");
const { dailyHistoryFromLog } = require("../src/usage");

test("recognizes Grok Build Fast aliases without merging their ordinary billing", () => {
  for (const id of [
    "grok-4.7-fast",
    "grok-4.7-build-fast",
    "Grok 4.7 build fast",
    "grok_4_7_build_fast",
  ]) {
    assert.equal(modelFamilyOf(id), "grok-4.7-fast", id);
  }
  assert.equal(modelFamilyOf("grok-4.7-build"), "grok-4.7");
  assert.equal(modelFamilyOf("grok-4.7-build-fastest"), "grok-4.7");
  assert.equal(modelFamilyOf("grok-4.8-build"), "grok-4.8-build");
  assert.equal(modelFamilyOf(null), "unknown");
  assert.equal(apiRatesForModel("custom-model"), null);
  assert.equal(modelContextSize("custom-model"), null);
  assert.equal(estimateApiUsd({ modelId: "custom-model", input: 1000 }), null);
});

test("uses Grok 4.7 official short and long-context rates, including the Fast tier", () => {
  const ordinary = { name: "grok-4.7", input: 2, cache: 0.5, output: 6, longContext: false };
  const fast = { name: "grok-4.7-fast", input: 4, cache: 1, output: 12, longContext: false };
  assert.deepEqual(apiRatesForModel("grok-4.7-build", 0), ordinary);
  assert.deepEqual(apiRatesForModel("grok-4.7-build", 200000), ordinary);
  assert.deepEqual(apiRatesForModel("grok-4.7-build-fast", 200000), fast);
  assert.deepEqual(apiRatesForModel("grok-4.7-build", 200001), {
    name: "grok-4.7",
    input: 4,
    cache: 1,
    output: 12,
    longContext: true,
  });
  assert.deepEqual(apiRatesForModel("grok-4.7-build-fast", 200001), {
    name: "grok-4.7-fast",
    input: 6,
    cache: 1.5,
    output: 18,
    longContext: true,
  });
  assert.equal(modelContextSize("grok-4.7-build"), 500000);
  assert.equal(modelContextSize("grok-4.7-build-fast"), 500000);
});

test("charges cached input separately and uses the request prompt length for surcharges", () => {
  const parts = { input: 100000, cache: 20000, output: 10000, reasoning: 500 };
  assert.equal(estimateApiUsd({ ...parts, modelId: "grok-4.7" }), 0.233);
  assert.equal(estimateApiUsd({ ...parts, modelId: "grok-4.7-build-fast" }), 0.466);
  assert.equal(estimateApiUsd({ ...parts, modelId: "grok-4.7", promptTokens: 210000 }), 0.466);
  assert.equal(estimateApiUsd({ ...parts, modelId: "grok-4.7-fast", promptTokens: 210000 }), 0.699);
  assert.equal(estimateApiUsd({ modelId: "grok-4.7", input: 1000, cache: 2000 }), 0.0005);
  assert.equal(estimateApiUsd({ modelId: "grok-4.7", input: -100, output: NaN, cache: true }), 0);
});

test("valid model metadata overrides the official reference capacity", () => {
  assert.equal(modelContextSize("grok-4.7", { contextWindowTokens: { val: 256000 } }), 256000);
  assert.equal(
    modelContextSize("grok-4.7", { _meta: { context_window_tokens: "300000" } }),
    300000,
  );
  assert.equal(modelContextSize("custom-model", { contextLength: 64000 }), 64000);
  assert.equal(modelContextSize("grok-4.7", { contextWindowTokens: 0, contextWindow: -1 }), 500000);
  assert.equal(modelContextSize("custom-model", { contextLength: null }), null);
});

test("numeric fields preserve zero but reject empty, missing, negative and nonfinite values", () => {
  for (const value of [0, "0", { val: 0 }, { val: "0" }]) assert.equal(numberOrNull(value), 0);
  for (const value of [
    null,
    undefined,
    "",
    " ",
    false,
    true,
    -1,
    Infinity,
    NaN,
    [],
    {},
    { val: null },
    { val: "" },
    { val: false },
    { val: Infinity },
  ]) {
    assert.equal(numberOrNull(value), null, JSON.stringify(value));
  }
  assert.equal(numberOrNull("256000"), 256000);
});

test("usage history keeps ordinary, Fast and unknown model buckets independent", () => {
  const log = [
    { model: "grok-4.7-build", prompt_tokens: 100, completion_tokens: 10 },
    { model: "grok-4.7-build-fast", prompt_tokens: 200, completion_tokens: 20 },
    { model: "custom-model", prompt_tokens: 50, completion_tokens: 5 },
  ]
    .map((ctx) => JSON.stringify({ ts: "2026-10-02T12:00:00Z", msg: "inference_done", ctx }))
    .join("\n");
  const day = dailyHistoryFromLog(log)["2026-10-02"];
  assert.equal(day.byModel["grok-4.7"].tokens, 110);
  assert.equal(day.byModel["grok-4.7-fast"].tokens, 220);
  assert.equal(day.byModel["custom-model"].tokens, 55);
  assert.equal(day.byModel["grok-4.6"], undefined);
});

test("the browser loads the same model metadata without Node privileges", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/model-info.js"), "utf8"), context);
  assert.equal(
    vm.runInContext('GrokModelInfo.modelContextSize("grok-4.7-build-fast")', context),
    500000,
  );
  assert.equal(
    vm.runInContext('GrokModelInfo.apiRatesForModel("grok-4.7-build-fast", 200001).input', context),
    6,
  );
});
