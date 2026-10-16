const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalGrokHome = process.env.GROK_HOME;

function writeSession(root, id, { title, createdAt, updatedAt, updates = null, messages = 2 }) {
  const dir = path.join(root, "sessions", encodeURIComponent("C:\\demo"), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      info: { id, cwd: "C:\\demo" },
      generated_title: title,
      created_at: createdAt,
      updated_at: updatedAt,
      last_active_at: updatedAt,
      num_chat_messages: messages,
    }),
  );
  if (updates) {
    fs.writeFileSync(path.join(dir, "updates.jsonl"), updates);
  }
  return dir;
}

function packet(timestamp, sessionUpdate, extra = {}) {
  return JSON.stringify({
    timestamp,
    method: "session/update",
    params: { update: { sessionUpdate, ...extra } },
  });
}

test("sidebar time follows the last conversation event, not a session load", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-activity-"));
  process.env.GROK_HOME = root;
  t.after(() => {
    if (originalGrokHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sessions = require("../src/sessions");
  sessions.invalidateSessionIndex();

  const turnAt = Math.floor(Date.parse("2026-10-08T09:42:03Z") / 1000);
  const loadAt = Math.floor(Date.parse("2026-10-15T17:01:43Z") / 1000);
  const liveAt = Math.floor(Date.parse("2026-10-16T01:30:00Z") / 1000);
  const hugeAt = Math.floor(Date.parse("2026-09-14T05:08:34Z") / 1000);

  writeSession(root, "loaded", {
    title: "GPUI",
    createdAt: "2026-10-08T09:39:08.000Z",
    updatedAt: "2026-10-15T17:01:43.774Z",
    updates: [
      packet(turnAt, "agent_message_chunk", { content: { text: "done" } }),
      packet(turnAt, "turn_completed"),
      packet(loadAt, "background_tasks", { tasks: [] }),
    ].join("\n") + "\n",
  });
  writeSession(root, "empty", {
    title: "Empty",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-16T01:01:00.000Z",
  });
  writeSession(root, "live", {
    title: "Live",
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T02:00:00.000Z",
    updates: packet(liveAt, "user_message_chunk") + "\n",
  });
  writeSession(root, "huge", {
    title: "Huge tool",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-16T01:08:10.000Z",
    updates:
      packet(hugeAt, "tool_call_update", { content: "x".repeat(80 * 1024) }) +
      "\n" +
      packet(loadAt, "background_tasks", { tasks: [] }) +
      "\n",
  });

  const rows = sessions.listSessions({ limit: 20 });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  assert.equal(byId.loaded.updatedAt, new Date(turnAt * 1000).toISOString());
  assert.equal(byId.empty.updatedAt, "2026-10-01T00:00:00.000Z");
  assert.equal(byId.live.updatedAt, new Date(liveAt * 1000).toISOString());
  assert.equal(byId.huge.updatedAt, new Date(hugeAt * 1000).toISOString());
  assert.deepEqual(
    rows.map((row) => row.id),
    ["live", "loaded", "empty", "huge"],
  );
});
