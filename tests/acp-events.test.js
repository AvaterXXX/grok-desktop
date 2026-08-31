const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeAcpUpdate, isHydrateSafeEvent } = require("../src/acp-events");

test("normalizes streamed thought, commentary, tool, and final answer events", () => {
  const fixtures = [
    { sessionUpdate: "agent_thought_chunk", content: { text: "reason" } },
    { sessionUpdate: "agent_message_chunk", content: { text: "I will inspect." } },
    {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "read_file",
      kind: "read_file",
      rawInput: { path: "src/demo.js" },
    },
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: "body",
    },
    { sessionUpdate: "agent_message_chunk", content: { text: "Done." } },
  ];
  assert.deepEqual(
    fixtures.map((fixture) => normalizeAcpUpdate(fixture).type),
    ["thought.chunk", "assistant.chunk", "tool.start", "tool.update", "assistant.chunk"],
  );
  assert.deepEqual(normalizeAcpUpdate(fixtures[2]).tool.rawInput, { path: "src/demo.js" });
  assert.equal(normalizeAcpUpdate(fixtures[3]).tool.status, "completed");
});

test("preserves falsey tool input values and limits hydrate-safe events", () => {
  const tool = normalizeAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "t0",
    input: 0,
  });
  assert.equal(tool.tool.rawInput, 0);
  assert.equal(
    isHydrateSafeEvent(
      normalizeAcpUpdate({
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      }),
    ),
    true,
  );
  assert.equal(isHydrateSafeEvent(tool), false);
});
