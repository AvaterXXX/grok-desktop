const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function extractFunction(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unclosed " + name);
}

function loadFunctions(file, names, sandbox) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const code = names.map((name) => extractFunction(src, name)).join("\n");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox;
}

test("project names and wallpaper URLs keep Windows backslashes as separators", () => {
  const sandbox = loadFunctions("renderer/app.js", ["projectName", "pathToFileUrl"], {});
  assert.equal(sandbox.projectName({ cwd: "C:\\Users\\acdie\\proj" }), "proj");
  assert.equal(sandbox.projectName({ cwd: "C:\\Users\\acdie\\proj\\" }), "proj");
  assert.equal(sandbox.projectName({ cwd: "C:/Users/acdie/proj" }), "proj");
  assert.equal(sandbox.projectName({}), "其他");
  assert.equal(sandbox.pathToFileUrl("C:\\wall\\a.jpg"), "file://C:/wall/a.jpg");
  assert.equal(sandbox.pathToFileUrl("C:/wall/a.jpg"), "file://C:/wall/a.jpg");
});

test("message file paths treat a Windows drive path as absolute", () => {
  const sandbox = loadFunctions("renderer/app.js", ["sessionCwdFor", "resolveFilePath"], {
    activeId: null,
    activeMeta: { cwd: "C:\\proj\\" },
    sessions: [],
    sessionUi: { get() { return null; } },
  });
  assert.equal(sandbox.resolveFilePath(null, "C:\\Users\\a\\b.txt"), "C:\\Users\\a\\b.txt");
  assert.equal(sandbox.resolveFilePath(null, "notes\\b.txt"), "C:\\proj/notes\\b.txt");
  assert.equal(sandbox.resolveFilePath(null, "/tmp/a.txt"), "/tmp/a.txt");
});

test("project cwd keys ignore a trailing Windows separator", () => {
  const sandbox = loadFunctions("renderer/app.js", ["listKnownProjectCwds"], {
    sessions: [{ cwd: "C:\\proj\\" }, { cwd: "C:\\proj" }],
    lastUsedCwd: null,
    activeMeta: null,
  });
  const found = sandbox.listKnownProjectCwds();
  assert.equal(found.length, 1);
  assert.equal(found[0], "C:\\proj\\");
});

test("a Windows relative plugin spec stays on the local-path check", () => {
  const calls = [];
  const sandbox = loadFunctions("main.js", ["normalizePluginInstallSpec"], {
    path,
    calls,
    boundedString: (raw) => String(raw).trim(),
    workspaceCliCwd: () => "C:\\work",
    assertAllowedLocalPath: (full) => {
      calls.push(full);
      return full;
    },
  });
  assert.equal(sandbox.normalizePluginInstallSpec(".\\plugin"), path.resolve("C:\\work", ".\\plugin"));
  assert.equal(sandbox.normalizePluginInstallSpec("..\\plugin"), path.resolve("C:\\work", "..\\plugin"));
  assert.equal(calls.length, 2);
  assert.equal(sandbox.normalizePluginInstallSpec("published-plugin"), "published-plugin");
  assert.equal(calls.length, 2);
});
