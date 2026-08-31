const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHistoryModel() {
  const sandbox = { globalThis: {}, window: {}, Map, Date };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "renderer", "history-model.js"), "utf8"),
    sandbox,
  );
  return sandbox.globalThis.GrokHistoryModel;
}

test("history tail keeps the last user turn and recovery avoids duplicate text", () => {
  const model = loadHistoryModel();
  const rows = Array.from({ length: 60 }, (_, index) => ({
    role: index === 15 ? "user" : "assistant",
  }));
  assert.equal(model.tailHistoryFrom(rows, 40), 15);
  assert.equal(model.mergeRecoveredText("hello", "hello world"), "hello world");
  assert.equal(model.recoveredAssistantSuffix("hello world", ["hello"]), "world");
  assert.equal(model.recoveredAssistantSuffix("hello", ["hello"]), "");
});

test("history assets stay pinned to user turns", () => {
  const model = loadHistoryModel();
  const messages = [
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "second image.png" },
    { role: "assistant", text: "reply two" },
  ];
  const assets = [
    { name: "early.png", mtimeMs: 1000 },
    { name: "image.png", mtimeMs: 9000 },
  ];
  const mapped = model.mapAssetsToMessageIndex(
    messages,
    assets,
    { createdAt: 0, updatedAt: 10_000 },
    10_000,
  );
  assert.ok([...mapped.keys()].every((index) => messages[index].role === "user"));
  assert.deepEqual(
    [...mapped.get(2)].map((item) => item.name),
    ["image.png"],
  );
});
