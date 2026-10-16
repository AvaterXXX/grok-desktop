const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeAppIcon,
  appIconSet,
  resolveAppIconFile,
  shortcutUsesAppIcon,
} = require("../src/app-icon");

test("app icon ids stay on the two shipped marks", () => {
  assert.equal(normalizeAppIcon("old"), "old");
  assert.equal(normalizeAppIcon("new"), "new");
  assert.equal(normalizeAppIcon("nope"), "new");
  assert.equal(normalizeAppIcon(undefined), "new");
});

test("both icon files exist and the old ico is a real icon", () => {
  const root = path.join(__dirname, "..");
  for (const id of ["new", "old"]) {
    const files = appIconSet(root, id);
    assert.equal(fs.existsSync(files.png), true, files.png);
    assert.equal(fs.existsSync(files.ico), true, files.ico);
    assert.equal(resolveAppIconFile(root, id, "win32"), files.ico);
  }
  const ico = fs.readFileSync(appIconSet(root, "old").ico);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.ok(ico.readUInt16LE(4) >= 3);
});

test("desktop shortcut matcher ignores other grok apps", () => {
  assert.equal(shortcutUsesAppIcon("Grok Desktop.lnk", ""), true);
  assert.equal(shortcutUsesAppIcon("Grok Bot.lnk", "C:\\Program\\Grok Bot.exe"), false);
  assert.equal(
    shortcutUsesAppIcon(
      "其他.lnk",
      "C:\\Users\\acdie\\AppData\\Local\\Grok Desktop\\Grok Desktop.exe",
    ),
    true,
  );
});
