const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadComposerModel() {
  const sandbox = { globalThis: {}, window: {} };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "renderer", "composer-model.js"), "utf8"),
    sandbox,
  );
  return sandbox.globalThis.GrokComposerModel;
}

test("composer model parses attachments, call routing, and goal display text", () => {
  const model = loadComposerModel();
  const files = model.parseAttachText("附加 2 个文件：\n- C:\\repo\\a.js\n- /tmp/b.md");
  assert.equal(files.length, 2);
  assert.equal(files[0].name, "a.js");
  const call = model.parseCallSession("/call 123e4567-e89b-12d3-a456-426614174000 review this");
  assert.equal(call.sessionId, "123e4567-e89b-12d3-a456-426614174000");
  assert.equal(call.text, "review this");
  assert.equal(model.unwrapGoalWrap("/goal hidden wrapper", "visible goal"), "visible goal");
});

test("composer model formats file prompts and stable user-facing errors", () => {
  const model = loadComposerModel();
  assert.match(
    model.buildPromptWithFiles("question", [{ path: "/tmp/a.txt", preview: "body" }]),
    /<file path="\/tmp\/a.txt">/,
  );
  assert.equal(model.formatWaitClock(3_723_000), "1小时 2分钟");
  assert.match(
    model.formatSendError({ error: { message: "ACP timeout: session/prompt" } }),
    /等太久/,
  );
});
