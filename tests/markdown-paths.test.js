const test = require("node:test");
const assert = require("node:assert/strict");

require("../renderer/markdown");

const { findLocalFilePaths, isLocalFilePath, renderMarkdown } = globalThis;

test("finds relative, dot-prefixed and absolute file paths in prose", () => {
  assert.deepEqual(
    findLocalFilePaths("完整可滚动页在 docs/advance-util-mockups.html。").map((s) => s.text),
    ["docs/advance-util-mockups.html"],
  );
  assert.deepEqual(
    findLocalFilePaths("改了 src/acp.js 和 ../shared/util.js").map((s) => s.text),
    ["src/acp.js", "../shared/util.js"],
  );
  assert.deepEqual(
    findLocalFilePaths("看 C:\\Users\\acdie\\grok-desktop\\main.js 里").map((s) => s.text),
    ["C:\\Users\\acdie\\grok-desktop\\main.js"],
  );
  assert.deepEqual(
    findLocalFilePaths("配置在 ./config/app.json").map((s) => s.text),
    ["./config/app.json"],
  );
});

test("does not linkify versions, urls, or separator-less names in prose", () => {
  assert.deepEqual(findLocalFilePaths("当前版本 0.1.15，下一步 0.2。"), []);
  assert.deepEqual(findLocalFilePaths("支持 and/or 与 tcp/ip 转发"), []);
  assert.deepEqual(findLocalFilePaths("详见 https://example.com/a/b.js 文档"), []);
  assert.deepEqual(findLocalFilePaths("文件 README.md 已更新"), []);
});

test("code spans accept single filenames but reject version numbers", () => {
  assert.equal(isLocalFilePath("README.md"), true);
  assert.equal(isLocalFilePath("docs/advance-util-mockups.html"), true);
  assert.equal(isLocalFilePath("C:/x/y.png"), true);
  assert.equal(isLocalFilePath("0.1.15"), false);
  assert.equal(isLocalFilePath("and/or"), false);
  assert.equal(isLocalFilePath(""), false);
});

test("rendered markdown wraps paths in clickable file links", () => {
  const html = renderMarkdown("完整可滚动页在 docs/advance-util-mockups.html，参考 `src/acp.js`。");
  assert.match(html, /<a class="file-link" data-path="docs\/advance-util-mockups\.html">/);
  assert.match(
    html,
    /<a class="file-link" data-path="src\/acp\.js"><code class="md-code">src\/acp\.js<\/code><\/a>/,
  );
  // Version numbers stay plain text even inside code spans.
  const version = renderMarkdown("版本 `0.1.15` 发布");
  assert.doesNotMatch(version, /file-link/);
});

test("fence citation header becomes a file link", () => {
  const html = renderMarkdown("```12:34:src/acp.js\nconst x = 1;\n```");
  assert.match(html, /<a class="file-link" data-path="src\/acp\.js">src\/acp\.js<\/a>/);
});
