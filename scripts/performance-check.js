#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const SESSION_COUNT = 240;
const INDEX_LIMIT_MS = 5_000;
const SEARCH_LIMIT_MS = 5_000;
const WARM_LIMIT_MS = 250;

function elapsed(start) {
  return Math.round((performance.now() - start) * 10) / 10;
}

function writeFixture(root, index) {
  const id = `perf-session-${String(index).padStart(4, "0")}`;
  const cwd = `C:${path.win32.sep}perf${path.win32.sep}project-${index % 12}`;
  const dir = path.join(root, "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      info: { id, cwd },
      generated_title: `Performance session ${index}`,
      updated_at: new Date(Date.UTC(2026, 7, 30, 0, index)).toISOString(),
      num_chat_messages: 24,
    }),
  );
  const marker = index === SESSION_COUNT - 1 ? " unique-search-needle" : "";
  const rows = [];
  for (let turn = 0; turn < 12; turn += 1) {
    rows.push(
      JSON.stringify({
        type: turn % 2 ? "assistant" : "user",
        content: `fixture ${index} turn ${turn} renderer history performance${marker}`,
      }),
    );
  }
  fs.writeFileSync(path.join(dir, "chat_history.jsonl"), `${rows.join("\n")}\n`);
}

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "grok-performance-"));
  const originalHome = process.env.GROK_HOME;
  process.env.GROK_HOME = fixtureRoot;
  try {
    for (let index = 0; index < SESSION_COUNT; index += 1) writeFixture(fixtureRoot, index);
    const sessions = require("../src/sessions");
    const { searchSessions } = require("../src/search");

    sessions.invalidateSessionIndex();
    let start = performance.now();
    const rows = await sessions.listSessionsAsync({ limit: SESSION_COUNT + 10 });
    const coldIndexMs = elapsed(start);
    assert.equal(rows.length, SESSION_COUNT);
    assert.ok(coldIndexMs < INDEX_LIMIT_MS, `cold session index took ${coldIndexMs}ms`);

    start = performance.now();
    const cachedRows = await sessions.listSessionsAsync({ limit: SESSION_COUNT + 10 });
    const warmIndexMs = elapsed(start);
    assert.equal(cachedRows.length, SESSION_COUNT);
    assert.ok(warmIndexMs < WARM_LIMIT_MS, `cached session index took ${warmIndexMs}ms`);

    let eventLoopTicks = 0;
    const timer = setInterval(() => {
      eventLoopTicks += 1;
    }, 1);
    start = performance.now();
    const hits = await searchSessions("unique-search-needle", { limit: 10 });
    const coldSearchMs = elapsed(start);
    clearInterval(timer);
    assert.equal(hits.length, 1);
    assert.ok(coldSearchMs < SEARCH_LIMIT_MS, `uncached search took ${coldSearchMs}ms`);
    assert.ok(eventLoopTicks > 0 || coldSearchMs < 20, "search blocked the event loop");

    start = performance.now();
    await searchSessions("unique-search-needle", { limit: 10 });
    const warmSearchMs = elapsed(start);
    assert.ok(warmSearchMs < WARM_LIMIT_MS, `cached search took ${warmSearchMs}ms`);

    start = performance.now();
    assert.equal(sessions.findSession(rows[0].id)?.id, rows[0].id);
    const cachedLookupMs = elapsed(start);
    assert.ok(cachedLookupMs < WARM_LIMIT_MS, `cached session lookup took ${cachedLookupMs}ms`);

    console.log(
      JSON.stringify({
        sessions: SESSION_COUNT,
        coldIndexMs,
        warmIndexMs,
        coldSearchMs,
        warmSearchMs,
        cachedLookupMs,
        eventLoopTicks,
      }),
    );
  } finally {
    if (originalHome == null) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = originalHome;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
