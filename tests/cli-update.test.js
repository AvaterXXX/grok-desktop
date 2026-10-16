const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCliUpdateCheck,
  cliUpdateSpawnSpec,
  cliUpdateShouldRestart,
  cliUpdatePrompt,
  cliUpdateFailureCopy,
} = require("../src/cli-update");

const sample = {
  currentVersion: "1.0.61",
  latestVersion: "1.0.62",
  updateAvailable: true,
  installer: "internal",
  channel: "alpha",
  error: null,
};

test("parse grok update --check --json", () => {
  const parsed = parseCliUpdateCheck(JSON.stringify(sample));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.current, "1.0.61");
  assert.equal(parsed.latest, "1.0.62");
  assert.equal(parsed.hasUpdate, true);
  assert.equal(parsed.installer, "internal");
  assert.equal(parsed.channel, "alpha");
});

test("a check error or the same version does not ask to update", () => {
  const same = parseCliUpdateCheck(
    JSON.stringify({ ...sample, latestVersion: "1.0.61", updateAvailable: true }),
  );
  assert.equal(same.hasUpdate, false);
  const failed = parseCliUpdateCheck(
    JSON.stringify({ ...sample, error: "network", updateAvailable: true }),
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.hasUpdate, false);
  assert.equal(parseCliUpdateCheck("not json").error, "invalid");
  assert.equal(parseCliUpdateCheck("").error, "empty");
});

test("log lines before the JSON object are ignored", () => {
  const parsed = parseCliUpdateCheck("checking\n" + JSON.stringify(sample) + "\n");
  assert.equal(parsed.latest, "1.0.62");
  assert.equal(parsed.hasUpdate, true);
});

test("internal installs use grok update and winget installs use winget", () => {
  const internal = cliUpdateSpawnSpec("internal", "C:\\Users\\acdie\\.grok\\bin\\grok.exe");
  assert.deepEqual(internal.args, ["update"]);
  assert.equal(internal.command.endsWith("grok.exe"), true);
  assert.equal(internal.shell, false);
  const winget = cliUpdateSpawnSpec("WinGet", "grok");
  assert.equal(winget.command, "winget");
  assert.equal(winget.shell, true);
  assert.ok(winget.args.includes("xAI.GrokBuild"));
  assert.equal(winget.args.includes("update"), false);
});

test("restart only after a completed CLI install", () => {
  const before = { current: "1.0.61", hasUpdate: true };
  const updated = { ok: true, current: "1.0.62", hasUpdate: false };
  const same = { ok: true, current: "1.0.61", hasUpdate: true };
  assert.equal(
    cliUpdateShouldRestart({
      installer: "internal",
      exitCode: 0,
      before,
      after: updated,
      output: "",
    }),
    true,
  );
  assert.equal(
    cliUpdateShouldRestart({
      installer: "internal",
      exitCode: 0,
      before,
      after: same,
      output: "Grok 1.0.62 installed successfully!\nPlease restart Grok.",
    }),
    true,
  );
  assert.equal(
    cliUpdateShouldRestart({
      installer: "internal",
      exitCode: 0,
      before,
      after: same,
      output: "Already up to date (1.0.61).",
    }),
    false,
  );
  assert.equal(
    cliUpdateShouldRestart({
      installer: "internal",
      exitCode: 1,
      before,
      after: updated,
      output: "installed successfully",
    }),
    false,
  );
  assert.equal(
    cliUpdateShouldRestart({
      installer: "winget",
      exitCode: 0,
      before,
      after: { ok: false, current: null },
      output: "prints winget upgrade and changes nothing",
    }),
    false,
  );
  assert.equal(
    cliUpdateShouldRestart({
      installer: "winget",
      exitCode: 0,
      before,
      after: updated,
      output: "",
    }),
    true,
  );
  assert.equal(
    cliUpdateShouldRestart({
      installer: "internal",
      exitCode: 0,
      before,
      after: { ok: false, current: null },
      output: "",
    }),
    true,
  );
});

test("the update question is explicit about the restart", () => {
  const zh = cliUpdatePrompt({ current: "1.0.61", latest: "1.0.62" }, "zh");
  assert.match(zh.message, /1\.0\.62/);
  assert.match(zh.message, /1\.0\.61/);
  assert.match(zh.detail, /自动重启/);
  assert.equal(zh.confirm, "更新");
  assert.equal(zh.cancel, "稍后");
  const en = cliUpdatePrompt({ current: "1.0.61", latest: "1.0.62" }, "en");
  assert.equal(en.confirm, "Update");
  const failure = cliUpdateFailureCopy("zh", "");
  assert.match(failure.message, /没有完成/);
  assert.match(failure.detail, /保持打开/);
});
