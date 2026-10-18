const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * The timeline cursor is a cache over two append-only-ish JSONL files. Its
 * whole value depends on one invariant: the rows it returns must be identical
 * to a cold parse of whatever is on disk right now. Every case below rewrites
 * the files and compares against a fresh process-level expectation.
 */
const originalGrokHome = process.env.GROK_HOME;

function makeSession(rows = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-timeline-"));
  const dir = path.join(root, "sessions", encodeURIComponent("C:\\demo"), "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({ info: { id: "s1", cwd: "C:\\demo" }, generated_title: "t" }),
  );
  for (const [name, lines] of Object.entries(rows)) {
    fs.writeFileSync(path.join(dir, name), lines.join("\n"));
  }
  return { root, dir };
}

function chatRows(...texts) {
  const rows = [];
  for (const text of texts) {
    rows.push(JSON.stringify({ type: "user", content: text }));
    rows.push(JSON.stringify({ type: "assistant", content: `${text}-reply` }));
  }
  return rows.map((line) => line + "\n");
}

function updateRows(...texts) {
  return texts.map(
    (text) =>
      JSON.stringify({
        timestamp: 1788400000,
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } },
      }) + "\n",
  );
}

function withSession(t, files, run) {
  const session = makeSession(files);
  process.env.GROK_HOME = session.root;
  const sessions = require("../src/sessions");
  sessions.invalidateSessionIndex();
  t.after(() => {
    if (originalGrokHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    fs.rmSync(session.root, { recursive: true, force: true });
  });
  return run({ ...session, sessions });
}

function texts(rows) {
  return rows.map((row) => row.text);
}

test("an appended log parses only its new tail", (t) => {
  withSession(t, { "chat_history.jsonl": chatRows("one") }, ({ dir, sessions }) => {
    const file = path.join(dir, "chat_history.jsonl");
    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), ["one", "one-reply"]);

    fs.appendFileSync(file, chatRows("two").join(""));
    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), [
      "one",
      "one-reply",
      "two",
      "two-reply",
    ]);
  });
});

test("a rewritten log is re-parsed even when it grows", (t) => {
  withSession(t, { "chat_history.jsonl": chatRows("one") }, ({ dir, sessions }) => {
    const file = path.join(dir, "chat_history.jsonl");
    sessions.loadHistoryPreview(dir);

    // Same prefix length would be easy; make the rewrite strictly longer so a
    // size-only check would wrongly treat the tail as appended data.
    fs.writeFileSync(file, chatRows("alpha", "beta").join(""));
    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), [
      "alpha",
      "alpha-reply",
      "beta",
      "beta-reply",
    ]);
  });
});

test("a log truncated by rewind drops the removed turns", (t) => {
  withSession(t, { "chat_history.jsonl": chatRows("keep", "drop") }, ({ dir, sessions }) => {
    const file = path.join(dir, "chat_history.jsonl");
    assert.equal(sessions.loadHistoryPreview(dir).length, 4);

    fs.writeFileSync(file, chatRows("keep").join(""));
    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), ["keep", "keep-reply"]);
  });
});

test("the newest row is visible even without a trailing newline", (t) => {
  withSession(t, {}, ({ dir, sessions }) => {
    const file = path.join(dir, "updates.jsonl");
    const body = updateRows("older", "newest").join("");
    fs.writeFileSync(file, body.trimEnd());

    // A last line the CLI has not terminated yet must not stay invisible.
    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), ["oldernewest"]);
  });
});

test("a partial final line stays buffered until it is complete", (t) => {
  withSession(t, {}, ({ dir, sessions }) => {
    const file = path.join(dir, "updates.jsonl");
    const full = updateRows("complete", "pending").join("");
    const cut = full.trimEnd();
    // Simulate the CLI mid-write: the last row is only partly on disk.
    const partial = cut.slice(0, cut.length - 12);
    fs.writeFileSync(file, partial);

    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), ["complete"]);
    // Once the rest of the row lands it must join the buffered fragment
    // instead of being dropped.
    fs.appendFileSync(file, cut.slice(partial.length));
    assert.deepEqual(texts(sessions.loadHistoryPreview(dir)), ["completepending"]);
  });
});

test("the async reader returns the same timeline as the sync reader", async (t) => {
  const session = makeSession({ "chat_history.jsonl": chatRows("first", "second") });
  process.env.GROK_HOME = session.root;
  const sessions = require("../src/sessions");
  sessions.invalidateSessionIndex();
  t.after(() => {
    if (originalGrokHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalGrokHome;
    fs.rmSync(session.root, { recursive: true, force: true });
  });

  const sync = sessions.loadHistoryPreviewSync(session.dir);
  sessions.invalidateSessionIndex();
  const async = await sessions.loadHistoryPreviewAsync(session.dir);
  assert.deepEqual(async, sync);
});

test("cached rows are copies so history annotations cannot leak", (t) => {
  withSession(t, { "chat_history.jsonl": chatRows("one") }, ({ dir, sessions }) => {
    const first = sessions.loadHistoryPreview(dir);
    first[0].fileChange = { path: "leaked" };
    first[1].text = "mutated";

    const second = sessions.loadHistoryPreview(dir);
    assert.equal(second[0].fileChange, undefined);
    assert.equal(second[1].text, "one-reply");
  });
});
