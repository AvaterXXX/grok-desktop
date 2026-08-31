const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SessionStore,
  createSessionModel,
  reduceSessionModel,
} = require("../renderer/session-store");

test("session reducer preserves commentary/tool/final-answer boundaries", () => {
  let state = createSessionModel("s1");
  state = reduceSessionModel(state, { type: "turn.start" });
  state = reduceSessionModel(state, { type: "assistant.chunk", text: "Inspecting." });
  state = reduceSessionModel(state, {
    type: "tool.start",
    tool: { toolCallId: "t1", status: "running", title: "read_file" },
  });
  state = reduceSessionModel(state, { type: "assistant.chunk", text: "Finished." });
  assert.equal(state.assistantText, "Inspecting.\n\nFinished.");
  assert.deepEqual(state.toolOrder, ["t1"]);
});

test("terminal tool state cannot be downgraded by a late update", () => {
  let state = createSessionModel("s1");
  state = reduceSessionModel(state, {
    type: "tool.start",
    tool: { toolCallId: "t1", status: "running" },
  });
  state = reduceSessionModel(state, {
    type: "tool.update",
    tool: { toolCallId: "t1", status: "completed" },
  });
  state = reduceSessionModel(state, {
    type: "tool.update",
    tool: { toolCallId: "t1", status: "updated" },
  });
  assert.equal(state.tools.get("t1").status, "completed");
});

test("session store isolates simultaneous sessions", () => {
  const store = new SessionStore(() => ({ viewOnly: true }));
  store.dispatch("a", { type: "assistant.chunk", text: "A" });
  store.dispatch("b", { type: "assistant.chunk", text: "B" });
  assert.equal(store.ensure("a").model.assistantText, "A");
  assert.equal(store.ensure("b").model.assistantText, "B");
});
