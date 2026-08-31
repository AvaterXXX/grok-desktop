const test = require("node:test");
const assert = require("node:assert/strict");

const { DiagnosticRing, sanitizeDiagnosticValue } = require("../src/diagnostics");

test("diagnostic ring is bounded and excludes message bodies and secrets", () => {
  let now = Date.parse("2026-08-30T00:00:00.000Z");
  const ring = new DiagnosticRing({ capacity: 50, now: () => now++ });
  for (let i = 0; i < 55; i++) {
    ring.record("session:status", {
      sessionId: `s-${i}`,
      state: "ready",
      message: "private conversation body",
      nested: { token: "secret", count: i },
    });
  }
  const events = ring.snapshot();
  assert.equal(events.length, 50);
  assert.equal(events[0].sequence, 6);
  assert.equal(events.at(-1).details.sessionId, "s-54");
  assert.equal(events.at(-1).details.message, "[redacted]");
  assert.equal(events.at(-1).details.nested.token, "[redacted]");
  assert.equal(events.at(-1).details.nested.count, 54);
});

test("diagnostic sanitizer clips strings and removes line breaks", () => {
  const result = sanitizeDiagnosticValue({ state: `ready\n${"x".repeat(400)}`, path: "/private" });
  assert.equal(result.path, "[redacted]");
  assert.equal(result.state.includes("\n"), false);
  assert.ok(result.state.length <= 256);
});
