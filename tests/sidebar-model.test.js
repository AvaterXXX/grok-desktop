const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadSidebarModel() {
  const sandbox = { globalThis: {}, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "renderer", "sidebar-model.js"), "utf8"),
    sandbox,
  );
  return sandbox.globalThis.GrokSidebarModel;
}

test("sidebar ordering keeps running sessions and projects ahead of idle ones", () => {
  const model = loadSidebarModel();
  const sessions = [
    { id: "idle-new", cwd: "/b", updatedAt: "2026-08-30T10:00:00Z" },
    { id: "running", cwd: "/a", updatedAt: "2026-08-29T10:00:00Z" },
    { id: "idle-old", cwd: "/a", updatedAt: "2026-08-28T10:00:00Z" },
  ];
  const groups = model.groupSessionsByProject(sessions, {
    projectName: (session) => session.cwd,
    isWorking: (session) => session.id === "running",
    sessionOrder: ["idle-old", "running", "idle-new"],
    projectOrder: ["/b", "/a"],
  });
  assert.equal(groups[0].cwd, "/a");
  assert.deepEqual(
    Array.from(groups[0].sessions, (session) => session.id),
    ["running", "idle-old"],
  );
});

test("sidebar drag ordering inserts before, after, and at the end", () => {
  const { moveKey } = loadSidebarModel();
  assert.deepEqual(Array.from(moveKey(["a", "b", "c"], "c", "a", false)), ["c", "a", "b"]);
  assert.deepEqual(Array.from(moveKey(["a", "b", "c"], "a", "b", true)), ["b", "a", "c"]);
  assert.deepEqual(Array.from(moveKey(["a", "b"], "a", null)), ["b", "a"]);
});

test("unsaved sessions float above the saved drag order in input order", () => {
  const model = loadSidebarModel();
  const sessions = [
    { id: "newest", cwd: "/a", updatedAt: "2026-09-05T17:02:00Z" },
    { id: "older", cwd: "/a", updatedAt: "2026-09-05T14:35:00Z" },
    { id: "saved-2", cwd: "/a", updatedAt: "2026-08-28T10:00:00Z" },
    { id: "saved-1", cwd: "/a", updatedAt: "2026-08-27T10:00:00Z" },
  ];
  const groups = model.groupSessionsByProject(sessions, {
    projectName: (session) => session.cwd,
    isWorking: () => false,
    sessionOrder: ["saved-2", "saved-1"],
    projectOrder: [],
  });
  assert.deepEqual(
    Array.from(groups[0].sessions, (session) => session.id),
    ["newest", "older", "saved-2", "saved-1"],
  );
});

test("a saved order that no longer matches any session falls back to input order", () => {
  const { sortBySavedOrder } = loadSidebarModel();
  const items = [{ id: "b" }, { id: "a" }, { id: "c" }];
  assert.deepEqual(
    Array.from(
      sortBySavedOrder(items, ["gone-1", "gone-2"], (item) => item.id),
      (item) => item.id,
    ),
    ["b", "a", "c"],
  );
});
