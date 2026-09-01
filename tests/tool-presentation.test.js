"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  aggregateDiffStatus,
  buildToolDetailText,
  defaultToolGroupExpanded,
  diffPathLabel,
  diffStatusPresentation,
  extractToolTarget,
  humanizeToolActivity,
  normalizeDiffPath,
  toolPreviewLine,
} = require("../renderer/tool-presentation");

test("tool summaries stay human-readable while details retain falsey values", () => {
  assert.equal(
    buildToolDetailText({ kind: "flag", rawInput: false, rawOutput: 0 }),
    "kind: flag\n\nfalse\n\n--- output ---\n0",
  );
  assert.equal(toolPreviewLine("kind: read_file\nC:/work/file.js"), "read_file");
  assert.equal(
    extractToolTarget({ rawInput: { path: "C:/work/src/file.js" } }),
    "C:/work/src/file.js",
  );
  assert.equal(extractToolTarget({ rawInput: "{ truncated" }), "");
});

test("diff status stays silent on success and labels only failures", () => {
  assert.deepEqual(diffStatusPresentation("completed", "zh"), {
    value: "completed",
    running: false,
    done: true,
    failed: false,
    label: "",
  });
  assert.equal(diffStatusPresentation("failed", "zh").label, "失败");
  assert.equal(diffStatusPresentation("cancelled", "en").label, "Cancelled");
});

test("completed tool groups collapse by default while active and failed groups stay open", () => {
  assert.equal(defaultToolGroupExpanded({ total: 4, running: 0, failed: 0 }), false);
  assert.equal(defaultToolGroupExpanded({ total: 4, running: 1, failed: 0 }), true);
  assert.equal(defaultToolGroupExpanded({ total: 4, running: 0, failed: 1 }), true);
  assert.equal(defaultToolGroupExpanded({ total: 1, running: 0, failed: 0 }), true);
});

test("tool activity uses localized verb, short target, and terminal state", () => {
  const running = humanizeToolActivity(
    { kind: "read_file", status: "running", rawInput: { path: "C:/work/src/file.js" } },
    "zh",
  );
  assert.equal(running.running, true);
  assert.equal(running.title, "正在阅读 · src/file.js");

  const done = humanizeToolActivity(
    { kind: "apply_patch", status: "completed", rawInput: { path: "/repo/app.js" } },
    "en",
  );
  assert.equal(done.running, false);
  assert.equal(done.title, "Edited · repo/app.js");
});

test("file edits group by normalized full path and keep parent directories visible", () => {
  assert.equal(
    normalizeDiffPath("D:\\Work\\repo\\deploy\\README.md"),
    normalizeDiffPath("d:/work/repo/deploy/./README.md"),
  );
  assert.notEqual(
    normalizeDiffPath("D:/work/repo/deploy/README.md"),
    normalizeDiffPath("D:/work/repo/tools/README.md"),
  );
  assert.equal(
    diffPathLabel({ relativePath: "deploy\\README.md", basename: "README.md" }),
    "deploy/README.md",
  );
  assert.equal(
    diffPathLabel({ path: "D:/work/repo/tools/README.md", basename: "README.md" }),
    "tools/README.md",
  );
});

test("a grouped file card stays running until all edits settle and preserves failures", () => {
  assert.equal(aggregateDiffStatus([{ status: "completed" }, { status: "running" }]), "running");
  assert.equal(aggregateDiffStatus([{ status: "completed" }, { status: "done" }]), "completed");
  assert.equal(aggregateDiffStatus([{ status: "completed" }, { status: "failed" }]), "failed");
});
