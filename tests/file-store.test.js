const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { atomicWriteFileSync, atomicWriteJsonSync } = require("../src/file-store");

test("atomic writes replace prior content without leaving temporary files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-file-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  atomicWriteFileSync(file, "old", "utf8");
  atomicWriteJsonSync(file, { version: 1, value: "new" }, { pretty: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, value: "new" });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});
