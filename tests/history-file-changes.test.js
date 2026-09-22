const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildHistoryFileChange } = require("../src/diff");

test("history reconstructs saved edits, never compares against the current filesystem", () => {
  const message = {
    title: "search_replace",
    kindName: "search_replace",
    toolCallId: "edit-1",
    status: "completed",
    rawInput: { file_path: "资料/清单.md", old_string: "旧内容", new_string: "新内容" },
  };
  const change = buildHistoryFileChange(message, process.cwd());
  assert.equal(change.path, path.resolve("资料/清单.md"));
  assert.deepEqual(change.stats, { added: 1, deleted: 1 });
  assert.equal(change.hunks.find((x) => x.type === "del").text, "旧内容");
  assert.equal(buildHistoryFileChange({ ...message, status: "failed" }, process.cwd()), null);
  assert.equal(
    buildHistoryFileChange(
      { title: "read_file", rawInput: { target_file: "资料/清单.md" } },
      process.cwd(),
    ),
    null,
  );
  const write = buildHistoryFileChange(
    { title: "write_file", status: "completed", rawInput: { path: "new.txt", content: "body" } },
    process.cwd(),
  );
  assert.equal(write.statsUnknown, true);
  assert.ok(write.hunks.every((x) => x.type === "meta"));
});
