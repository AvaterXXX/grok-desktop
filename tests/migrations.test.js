const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DESKTOP_UI_VERSION,
  loadSessionUi,
  migrateSessionUi,
  saveSessionUi,
} = require("../src/sessions");
const { DESKTOP_SETTINGS_VERSION, migrateDesktopSettings } = require("../src/settings");

test("migrates useful session recovery fields and removes unordered stream aggregates", () => {
  const migrated = migrateSessionUi({
    input: "draft",
    user: "question",
    thought: "reasoning",
    assistant: "answer",
    cancelled: 1,
    unknownFutureField: "preserve me",
  });
  assert.equal(migrated.version, DESKTOP_UI_VERSION);
  assert.equal(migrated.draft, "draft");
  assert.equal(migrated.lastUser, "question");
  assert.equal(migrated.pendingUserMessages.length, 1);
  assert.equal(migrated.pendingUserMessages[0].text, "question");
  assert.equal("lastThought" in migrated, false);
  assert.equal("lastAssistant" in migrated, false);
  assert.equal(migrated.stopped, true);
  assert.equal(migrated.unknownFutureField, "preserve me");
  assert.equal("input" in migrated, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-ui-migration-"));
  try {
    fs.writeFileSync(path.join(dir, "desktop-ui.json"), JSON.stringify({ input: "old" }), "utf8");
    const loaded = loadSessionUi(dir);
    assert.equal(loaded.draft, "old");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "desktop-ui.json"), "utf8")).version,
      DESKTOP_UI_VERSION,
    );
    assert.equal(saveSessionUi(dir, { draft: "new", stopped: false }), true);
    assert.equal(loadSessionUi(dir).draft, "new");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates and normalizes desktop settings without discarding unknown fields", () => {
  const migrated = migrateDesktopSettings({
    autoApprove: false,
    hideThinking: true,
    sendWithEnter: false,
    openTabs: ["valid-1", "../invalid", "valid-1"],
    wallpaperDim: 999,
    customFutureSetting: 42,
  });
  assert.equal(migrated.version, DESKTOP_SETTINGS_VERSION);
  assert.equal(migrated.accessMode, "safe");
  assert.equal(migrated.showThinking, false);
  assert.equal(migrated.enterToSend, false);
  assert.deepEqual(migrated.openTabs, ["valid-1"]);
  assert.equal(migrated.wallpaperDim, 80);
  assert.equal(migrated.customFutureSetting, 42);

  const defaults = migrateDesktopSettings({});
  assert.equal(defaults.wallpaperDim, 45);
});
