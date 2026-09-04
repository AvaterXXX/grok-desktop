const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalGrokHome = process.env.GROK_HOME;

function writeSession(root, id, { title, kind, rows = [], updatedAt }) {
  const dir = path.join(root, "sessions", encodeURIComponent("C:\\demo"), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      info: { id, cwd: "C:\\demo" },
      generated_title: title,
      session_kind: kind,
      updated_at: updatedAt,
    }),
  );
  fs.writeFileSync(
    path.join(dir, "chat_history.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  return dir;
}

test("async session index filters internal sessions and powers non-blocking search", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-index-"));
  process.env.GROK_HOME = root;
  t.after(() => {
    if (originalGrokHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sessions = require("../src/sessions");
  sessions.invalidateSessionIndex();
  writeSession(root, "s1", {
    title: "Alpha project",
    updatedAt: "2026-08-29T10:00:00.000Z",
    rows: [
      { type: "user", content: "find the renderer race" },
      { type: "assistant", content: "I found the renderer race." },
    ],
  });
  writeSession(root, "child", {
    title: "hidden child",
    kind: "subagent",
    updatedAt: "2026-08-29T11:00:00.000Z",
  });

  const visible = await sessions.listSessionsAsync({ limit: 20 });
  assert.deepEqual(
    visible.map((row) => row.id),
    ["s1"],
  );
  assert.equal(sessions.findSession("s1").title, "Alpha project");

  const { searchSessions } = require("../src/search");
  const hits = await searchSessions("renderer race", { limit: 10 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "s1");
  assert.equal(hits[0].matchRole, "user");
});

test("history preview retains commentary, tool, and final answer order", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-history-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = writeSession(root, "s2", {
    title: "Tool order",
    rows: [
      { type: "user", content: "inspect" },
      {
        type: "assistant",
        content: "Looking now.",
        tool_calls: [{ id: "t1", function: { name: "read_file", arguments: '{"path":"a.js"}' } }],
      },
      { type: "tool_result", tool_call_id: "t1", content: "body" },
      { type: "assistant", content: "Finished." },
    ],
  });
  const { loadHistoryPreview } = require("../src/sessions");
  const rows = loadHistoryPreview(dir);
  assert.deepEqual(
    rows.map((row) => row.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.deepEqual(rows[2].rawInput, { path: "a.js" });
});

test("history preview preserves thought and tool order for one rendered thought group", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-history-thought-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = writeSession(root, "s3", {
    title: "Thought order",
    rows: [
      { type: "user", content: "inspect" },
      { type: "reasoning", content: "first thought" },
      { type: "reasoning", content: "continuation" },
      {
        type: "assistant",
        content: "",
        tool_calls: [{ id: "t1", function: { name: "read_file", arguments: "{}" } }],
      },
      { type: "tool_result", tool_call_id: "t1", content: "body" },
      { type: "reasoning", content: "second thought" },
      { type: "assistant", content: "Done." },
    ],
  });
  const { loadHistoryPreview } = require("../src/sessions");
  const rows = loadHistoryPreview(dir);

  assert.deepEqual(
    rows.map((row) => row.role),
    ["user", "thought", "tool", "thought", "assistant"],
  );
  assert.match(rows[1].text, /first thought[\s\S]*continuation/);
  assert.equal(rows[3].text, "second thought");
});

test("history preview recovers pre-compaction turns from ACP updates", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-history-compacted-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = writeSession(root, "s4", {
    title: "Compacted history",
    rows: [
      { type: "user", content: "latest question" },
      { type: "assistant", content: "latest answer" },
    ],
  });
  fs.mkdirSync(path.join(dir, "compaction"));
  fs.writeFileSync(path.join(dir, "compaction", "INDEX.md"), "# compacted\n");
  const packets = [
    [
      "e1",
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "older question" } },
    ],
    ["e2", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } }],
    [
      "e3",
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        rawInput: { path: "a.js" },
      },
    ],
    [
      "e4",
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "body" } }],
      },
    ],
    [
      "e5",
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "older answer" } },
    ],
    [
      "e6",
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "latest question" } },
    ],
    [
      "e7",
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "latest answer" } },
    ],
  ].map(([eventId, update], index) =>
    JSON.stringify({
      timestamp: 1788400000 + index,
      method: "session/update",
      params: { update, _meta: { eventId } },
    }),
  );
  fs.writeFileSync(path.join(dir, "updates.jsonl"), packets.join("\n") + "\n");

  const { loadHistoryPreview } = require("../src/sessions");
  const rows = loadHistoryPreview(dir);
  assert.deepEqual(
    rows.map((row) => row.role),
    ["user", "thought", "tool", "assistant", "user", "assistant"],
  );
  assert.equal(rows[2].rawOutput, "body");
  assert.equal(rows[0].createdAt, "2026-09-03T01:46:40.000Z");
});
