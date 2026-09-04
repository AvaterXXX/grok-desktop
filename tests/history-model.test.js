const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateIpcRequest } = require("../src/security");

function loadHistoryModel() {
  const sandbox = { globalThis: {}, window: {}, Map, Date };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "renderer", "history-model.js"), "utf8"),
    sandbox,
  );
  return sandbox.globalThis.GrokHistoryModel;
}

test("history tail keeps the last user turn", () => {
  const model = loadHistoryModel();
  const rows = Array.from({ length: 60 }, (_, index) => ({
    role: index === 15 ? "user" : "assistant",
  }));
  assert.equal(model.tailHistoryFrom(rows, 40), 15);
});

test("history tail includes a recovered question before a tool-heavy answer", () => {
  const model = loadHistoryModel();
  const rows = Array.from({ length: 100 }, (_, index) => ({
    role: index === 10 ? "user" : index % 4 === 0 ? "thought" : "tool",
  }));
  assert.equal(model.tailHistoryFrom(rows, 40), 10);
});

test("history tail still pages a very long single user turn", () => {
  const model = loadHistoryModel();
  const rows = Array.from({ length: 281 }, (_, index) => ({
    role: index === 0 ? "user" : "tool",
  }));
  assert.equal(model.tailHistoryFrom(rows, 40), 241);
});

test("previous history page aligns to a nearby thought boundary", () => {
  const model = loadHistoryModel();
  const rows = Array.from({ length: 120 }, () => ({ role: "tool" }));
  rows[76] = { role: "thought" };
  assert.equal(model.previousHistoryFrom(rows, 120, 40), 76);
  assert.equal(model.previousHistoryFrom(rows, 20, 40), 0);
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

test("recovered user message is restored at its timestamp without reordering ACP rows", () => {
  const model = loadHistoryModel();
  const messages = [
    { role: "thought", text: "earlier thought", createdAt: "2026-09-03T02:54:50Z" },
    { role: "assistant", text: "progress one", createdAt: "2026-09-03T03:02:00Z" },
    { role: "tool", text: "read", createdAt: "2026-09-03T03:03:00Z" },
    { role: "assistant", text: "final", createdAt: "2026-09-03T03:14:00Z" },
  ];
  const pending = [
    {
      id: "message-1",
      text: "question hidden by the goal wrapper",
      createdAt: "2026-09-03T02:55:08Z",
    },
  ];

  const result = model.mergeRecoveredUserMessages(messages, pending);

  assert.deepEqual(
    Array.from(result.messages, (item) => item.text),
    ["earlier thought", "question hidden by the goal wrapper", "progress one", "read", "final"],
  );
  assert.equal(result.messages[1].role, "user");
  assert.equal(result.messages[1].pending, true);
  assert.equal(result.unresolved.length, 1);
});

test("goal-mode recovery matches the persisted slash prompt without duplicating it", () => {
  const model = loadHistoryModel();
  const messages = [
    { role: "user", text: "/goal fix the timeline", createdAt: "2026-09-03T02:55:09Z" },
    { role: "assistant", text: "done", createdAt: "2026-09-03T03:00:00Z" },
  ];

  const result = model.mergeRecoveredUserMessages(messages, [
    { text: "fix the timeline", createdAt: "2026-09-03T02:55:08Z" },
  ]);

  assert.equal(result.messages.length, 2);
  assert.equal(result.unresolved.length, 0);
});

test("separate repeated pending questions are both restored", () => {
  const model = loadHistoryModel();
  const result = model.mergeRecoveredUserMessages(
    [{ role: "assistant", text: "later", createdAt: "2026-09-03T03:00:00Z" }],
    [
      { id: "one", text: "repeat", createdAt: "2026-09-03T02:55:00Z" },
      { id: "two", text: "repeat", createdAt: "2026-09-03T02:56:00Z" },
    ],
  );

  assert.deepEqual(
    Array.from(result.messages, (item) => item.text),
    ["repeat", "repeat", "later"],
  );
  assert.equal(result.unresolved.length, 2);
});

test("session recovery patch is bounded before crossing IPC", () => {
  const model = loadHistoryModel();
  const huge = "界".repeat(200 * 1024);
  const safe = model.sanitizeSessionUiPatch({
    draft: huge,
    lastUser: huge,
    stopped: 1,
    pendingUserMessages: Array.from({ length: 9 }, (_, index) => ({
      id: `message-${index}`,
      text: huge,
      createdAt: "2026-09-03T03:23:57.222Z",
    })),
    accidentalLargeField: huge,
  });

  assert.ok(safe.draft.length <= 128 * 1024);
  assert.equal(safe.lastUser.length, 64 * 1024);
  assert.equal(safe.stopped, true);
  assert.ok(safe.pendingUserMessages.length <= 4);
  assert.ok(
    safe.pendingUserMessages.reduce((total, item) => total + item.text.length, 0) <= 128 * 1024,
  );
  assert.equal(Object.hasOwn(safe, "accidentalLargeField"), false);
  assert.doesNotThrow(() =>
    validateIpcRequest("sessions:saveUi", [{ sessionId: "session-1", ui: safe }]),
  );
});
