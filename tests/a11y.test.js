const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadA11y() {
  const sandbox = { globalThis: {}, window: {}, queueMicrotask };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "renderer", "a11y.js"), "utf8"),
    sandbox,
  );
  return sandbox.globalThis.GrokA11y;
}

test("menu index navigation wraps and handles boundaries", () => {
  const api = loadA11y();
  assert.equal(api.nextMenuIndex(-1, 4, "ArrowDown"), 0);
  assert.equal(api.nextMenuIndex(3, 4, "ArrowDown"), 0);
  assert.equal(api.nextMenuIndex(0, 4, "ArrowUp"), 3);
  assert.equal(api.nextMenuIndex(2, 4, "Home"), 0);
  assert.equal(api.nextMenuIndex(2, 4, "End"), 3);
  assert.equal(api.nextMenuIndex(2, 4, "x"), 2);
});
