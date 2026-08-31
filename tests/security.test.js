const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const {
  assertPathInside,
  boundedInteger,
  boundedStringArray,
  isPathInside,
  isSafeImagePath,
  optionalSessionId,
  safeExternalUrl,
  validateIpcRequest,
} = require("../src/security");

test("accepts only bounded session ids, arrays, and integers", () => {
  assert.equal(optionalSessionId("abc-123:child"), "abc-123:child");
  assert.throws(() => optionalSessionId("../secrets"), /invalid format/);
  assert.throws(() => optionalSessionId("x".repeat(257)), /too long/);
  assert.deepEqual(boundedStringArray(["a", "b"], { maxItems: 2 }), ["a", "b"]);
  assert.throws(() => boundedStringArray(["a", "b", "c"], { maxItems: 2 }), /too many/);
  assert.equal(boundedInteger("5", { min: 1, max: 10 }), 5);
  assert.throws(() => boundedInteger(11, { min: 1, max: 10 }), /between/);
});

test("privileged IPC validation rejects malformed payloads before handlers", () => {
  assert.doesNotThrow(() => validateIpcRequest("sessions:history", [{ sessionId: "abc-123" }]));
  assert.throws(
    () => validateIpcRequest("sessions:history", [{ sessionId: "../outside" }]),
    /invalid format/,
  );
  assert.throws(
    () => validateIpcRequest("session:prompt", [{ text: "hi", images: new Array(13).fill({}) }]),
    /at most 12/,
  );
  assert.throws(
    () => validateIpcRequest("shell:openExternal", ["file:///tmp/secret"]),
    /only http/,
  );
  assert.throws(() => validateIpcRequest("plugins:install", ["--unsafe-option"]), /option/);
  const args = ["https://example.com/docs"];
  assert.equal(validateIpcRequest("shell:openExternal", args)[0], "https://example.com/docs");
});

test("external URL policy rejects executable schemes and embedded credentials", () => {
  assert.equal(safeExternalUrl("https://example.com/a?q=1"), "https://example.com/a?q=1");
  assert.equal(safeExternalUrl("http://localhost:3000"), "http://localhost:3000/");
  assert.throws(() => safeExternalUrl("javascript:alert(1)"), /only http/);
  assert.throws(() => safeExternalUrl("file:///etc/passwd"), /only http/);
  assert.throws(() => safeExternalUrl("https://user:pass@example.com"), /credentialed/);
});

test("directory boundaries do not confuse sibling prefixes", () => {
  const root = path.join(os.tmpdir(), "grok-security-root");
  const inside = path.join(root, "child", "file.png");
  const sibling = `${root}-other${path.sep}file.png`;
  assert.equal(isPathInside(root, inside), true);
  assert.equal(isPathInside(root, sibling), false);
  assert.equal(assertPathInside(inside, [root]), path.resolve(inside));
  assert.throws(() => assertPathInside(sibling, [root]), /outside/);
  assert.equal(isSafeImagePath(inside), true);
  assert.equal(isSafeImagePath(path.join(root, "notes.txt")), false);
});
