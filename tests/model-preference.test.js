const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { restorePreferredModel } = require("../src/model-preference");

test("restores the saved model, preserves CLI default when unset, and surfaces rejected models", async () => {
  const selected = [];
  const client = {
    currentModelId: "grok-4.6",
    async setModel(id) {
      selected.push(id);
      this.currentModelId = id;
    },
  };
  await restorePreferredModel(client, "grok-4.7");
  await restorePreferredModel(client, "grok-4.7");
  await restorePreferredModel(client, null);
  assert.deepEqual(selected, ["grok-4.7"]);
  await assert.rejects(
    restorePreferredModel(
      {
        async setModel() {
          throw new Error("unavailable");
        },
      },
      "retired",
    ),
    /unavailable/,
  );
});

test("model selection survives a fresh settings process", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-model-preference-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (script) => {
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, GROK_HOME: dir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  run('require("./src/settings").updateGrokConfig({defaultModel:"grok-4.7"})');
  assert.equal(
    run('console.log(require("./src/settings").readGrokConfigSummary().defaultModel)'),
    "grok-4.7",
  );
  run('require("./src/settings").updateGrokConfig({defaultModel:"grok-4.5"})');
  assert.equal(
    run('console.log(require("./src/settings").readGrokConfigSummary().defaultModel)'),
    "grok-4.5",
  );
});

test("model list refresh does not send a model change or overwrite the saved selection", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
  const start = source.indexOf("async function applyPreferredDefaults(");
  const code = source.slice(start, source.indexOf("\nfunction shortModelName", start));
  let modelCalls = 0;
  const context = vm.createContext({
    activeId: "session",
    currentModelId: "grok-4.7",
    currentEffort: "high",
    sessionEffortUser: new Map(),
    refreshEffortOptions() {},
    defaultEffortForModel: () => "high",
    grokDesktop: {
      async setModel() {
        modelCalls++;
      },
      async setEffort() {},
    },
    syncModelChip() {},
    updateLiveStrip() {},
  });
  vm.runInContext(code, context);
  await vm.runInContext('applyPreferredDefaults("session")', context);
  await vm.runInContext('applyPreferredDefaults("session")', context);
  assert.equal(modelCalls, 0);
  assert.equal(context.currentModelId, "grok-4.7");
});
