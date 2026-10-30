const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function harness({ cache = true } = {}) {
  const timers = new Set();
  const children = [];
  const files = new Map([
    ["config.toml", '[models]\ndefault = "grok-test"\n'],
    [
      "models_cache.json",
      JSON.stringify({ models: { "grok-test": { info: { name: "Test model" } } } }),
    ],
  ]);
  if (!cache) files.delete("models_cache.json");
  const fakeFs = {
    existsSync: (file) => files.has(path.basename(file)),
    readFileSync: (file) => {
      const value = files.get(path.basename(file));
      if (value == null) throw new Error("ENOENT");
      return value;
    },
  };
  const context = {
    module: { exports: {} },
    process,
    setTimeout: (callback) => {
      timers.add(callback);
      return callback;
    },
    clearTimeout: (callback) => timers.delete(callback),
    require: (id) => {
      if (id === "fs") return fakeFs;
      if (id === "./sessions") return { grokHome: () => "/fixture" };
      if (id === "./plugins") return { resolveGrokCli: () => "fake-grok" };
      if (id === "./platform")
        return {
          appConfigDir: () => "/fixture",
          spawnCli: () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.kill = () => {
              child.killed = true;
              child.emit("close", 1);
            };
            children.push(child);
            return child;
          },
        };
      return id.startsWith(".") ? require(path.resolve(__dirname, "../src", id)) : require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/settings.js"), "utf8"), context);
  return { settings: context.module.exports, timers, children };
}

test("startup catalog reads the local cache without launching the CLI", () => {
  const { settings, children } = harness();
  const catalog = settings.cachedModels();
  assert.equal(catalog.models[0].id, "grok-test");
  assert.equal(catalog.models[0].name, "Test model");
  assert.equal(catalog.models[0].isDefault, true);
  assert.equal(children.length, 0);
});

test("a missing model cache still preserves the configured model", () => {
  const { settings } = harness({ cache: false });
  const catalog = settings.cachedModels();
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].id, "grok-test");
  assert.equal(catalog.defaultModel, "grok-test");
});

test("a stalled live catalog is terminated and resolves from cache", async () => {
  const { settings, timers, children } = harness();
  const pending = settings.listModels();
  const [expire] = timers;
  assert.equal(children.length, 1);
  expire();
  const catalog = await pending;
  assert.equal(catalog.models[0].name, "Test model");
  assert.equal(children[0].killed, true);
  assert.equal(timers.size, 0);
  children[0].stdout.emit("data", "* grok-unexpected");
  children[0].emit("close", 0);
  assert.equal(catalog.models[0].id, "grok-test");
});

test("CLI launch failures fall back without leaving a timeout behind", async () => {
  const { settings, timers, children } = harness();
  const pending = settings.listModels();
  children[0].emit("error", new Error("ENOENT"));
  assert.equal((await pending).models[0].id, "grok-test");
  assert.equal(timers.size, 0);
});

test("a successful live catalog replaces stale cached models", async () => {
  const { settings, timers, children } = harness();
  const pending = settings.listModels();
  children[0].stdout.emit("data", "Default model: grok-new\n* grok-new\n- grok-other\n");
  children[0].stderr.emit("data", "diagnostic output");
  children[0].emit("close", 0);
  const catalog = await pending;
  assert.equal(catalog.defaultModel, "grok-new");
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].id, "grok-new");
  assert.equal(catalog.models[0].isDefault, true);
  assert.equal(timers.size, 0);
});
