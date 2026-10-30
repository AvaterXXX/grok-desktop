"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { locateExistingPath, locateDeep, locateNamedInDirs } = require("../src/locate-path");

function make() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-locate-"));
  const proj = path.join(dir, "proj");
  const nested = path.join(proj, "BPTA", "prompts");
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, "runtime_core.md");
  fs.writeFileSync(file, "hello");
  return { dir, proj, file };
}

test("direct path is returned as-is", () => {
  const made = make();
  try {
    assert.equal(locateExistingPath(made.file), made.file);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("a path joined to the parent finds the one nested copy", () => {
  const made = make();
  try {
    const joined = path.join(made.proj, "prompts", "runtime_core.md");
    assert.equal(fs.existsSync(joined), false);
    assert.equal(locateExistingPath(joined), made.file);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("two nested copies are not guessed", () => {
  const made = make();
  try {
    const other = path.join(made.proj, "other", "prompts");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "runtime_core.md"), "other");
    assert.equal(locateExistingPath(path.join(made.proj, "prompts", "runtime_core.md")), null);
    assert.equal(locateExistingPath(made.file), made.file);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("a dotted fragment uses the one absolute path named in the conversation", () => {
  const made = make();
  const realDir = path.join(made.dir, "cursor", "canvases");
  fs.mkdirSync(realDir, { recursive: true });
  const real = path.join(realDir, "pentest-repo-code-comparison.canvas.tsx");
  fs.writeFileSync(real, "export {}");
  const otherDir = path.join(made.dir, "other");
  fs.mkdirSync(otherDir, { recursive: true });
  const other = path.join(otherDir, "second.canvas.tsx");
  fs.writeFileSync(other, "export {}");
  try {
    const requested = path.join(made.proj, ".canvas.tsx");
    assert.equal(fs.existsSync(requested), false);
    assert.equal(locateExistingPath(requested, [real]), real);
    assert.equal(locateExistingPath(requested, [real, other]), null);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("a missing path under the drive root is not searched", () => {
  const root = path.parse(os.tmpdir()).root;
  const missing = path.join(root, "gd-locate-missing-" + Date.now(), "file.md");
  assert.equal(locateExistingPath(missing), null);
});

test("a file several directories down is found when it is the only copy", async () => {
  const made = make();
  try {
    const deep = path.join(made.proj, "frontend", "src", "components");
    fs.mkdirSync(deep, { recursive: true });
    const file = path.join(deep, "Panel.tsx");
    fs.writeFileSync(file, "export {}");
    const requested = path.join(made.proj, "Panel.tsx");
    assert.equal(locateExistingPath(requested), null);
    assert.equal(await locateDeep(requested), file);
    const relative = path.join(made.proj, "components", "Panel.tsx");
    assert.equal(locateExistingPath(relative), null);
    assert.equal(await locateDeep(relative), file);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("two deep copies of the same name are not guessed", async () => {
  const made = make();
  try {
    const left = path.join(made.proj, "frontend", "src", "Panel.tsx");
    const right = path.join(made.proj, "backend", "pkg", "Panel.tsx");
    fs.mkdirSync(path.dirname(left), { recursive: true });
    fs.mkdirSync(path.dirname(right), { recursive: true });
    fs.writeFileSync(left, "a");
    fs.writeFileSync(right, "b");
    assert.equal(await locateDeep(path.join(made.proj, "Panel.tsx")), null);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("a copy that exists only inside node_modules is ignored", async () => {
  const made = make();
  try {
    const hidden = path.join(made.proj, "node_modules", "pkg", "Panel.tsx");
    fs.mkdirSync(path.dirname(hidden), { recursive: true });
    fs.writeFileSync(hidden, "export {}");
    assert.equal(await locateDeep(path.join(made.proj, "Panel.tsx")), null);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("a path directly under the user profile is not walked", async () => {
  const home = os.homedir();
  const requested = path.join(home, "gd-locate-missing-" + Date.now() + ".md");
  const started = Date.now();
  assert.equal(await locateDeep(requested), null);
  assert.ok(Date.now() - started < 500);
});

test("a file that exists only in another project directory is found by name", async () => {
  const made = make();
  try {
    const other = path.join(made.dir, "sibling", "单独提取");
    fs.mkdirSync(other, { recursive: true });
    const file = path.join(other, "87FE.json");
    fs.writeFileSync(file, "{}");
    const requested = path.join(made.proj, "87FE.json");
    assert.equal(await locateDeep(requested), null);
    const hits = await locateNamedInDirs([made.proj, path.join(made.dir, "sibling")], "87FE.json");
    assert.deepEqual(hits, [file]);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("two copies of the same name in a project are both returned", async () => {
  const made = make();
  try {
    const data = path.join(made.dir, "sibling", "data");
    const picked = path.join(made.dir, "sibling", "picked");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(picked, { recursive: true });
    fs.writeFileSync(path.join(data, "87FE.json"), "a");
    fs.writeFileSync(path.join(picked, "87FE.json"), "b");
    const hits = await locateNamedInDirs([path.join(made.dir, "sibling")], "87FE.json");
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((file) => path.basename(path.dirname(file))).sort(), ["data", "picked"]);
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true });
  }
});

test("a UNC path is not stated", () => {
  const bs = String.fromCharCode(92);
  const unc = bs + bs + "server" + bs + "share" + bs + "a.md";
  const started = Date.now();
  assert.equal(locateExistingPath(unc), null);
  assert.ok(Date.now() - started < 500);
});
