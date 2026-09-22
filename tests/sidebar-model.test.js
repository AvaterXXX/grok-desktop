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

test("a project lists at most 5 sessions until expanded", () => {
  const { previewProjectSessions, PROJECT_SESSION_PREVIEW_LIMIT } = loadSidebarModel();
  assert.equal(PROJECT_SESSION_PREVIEW_LIMIT, 5);
  const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` }));
  const capped = previewProjectSessions(sessions);
  assert.deepEqual(
    Array.from(capped.shown, (session) => session.id),
    ["s0", "s1", "s2", "s3", "s4"],
  );
  assert.equal(capped.hidden, 3);
  assert.equal(capped.overflow, true);
  assert.equal(capped.forceAll, false);

  const all = previewProjectSessions(sessions, { expanded: true });
  assert.equal(all.shown.length, 8);
  assert.equal(all.hidden, 0);
  assert.equal(all.expanded, true);

  const five = previewProjectSessions(sessions.slice(0, 5));
  assert.equal(five.shown.length, 5);
  assert.equal(five.overflow, false);
  assert.equal(five.hidden, 0);
});

test("the active session past the fold expands the project list", () => {
  const { previewProjectSessions } = loadSidebarModel();
  const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` }));
  const preview = previewProjectSessions(sessions, { activeId: "s6" });
  assert.equal(preview.shown.length, 8);
  assert.equal(preview.hidden, 0);
  assert.equal(preview.forceAll, true);

  const inFold = previewProjectSessions(sessions, { activeId: "s2" });
  assert.equal(inFold.shown.length, 5);
  assert.equal(inFold.hidden, 3);
});

test("search / pinned groups skip the 5-session preview", () => {
  const { previewProjectSessions } = loadSidebarModel();
  const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}` }));
  const preview = previewProjectSessions(sessions, { limit: 0 });
  assert.equal(preview.shown.length, 8);
  assert.equal(preview.overflow, false);
});
