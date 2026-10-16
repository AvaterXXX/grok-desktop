const fs = require("fs");
const path = require("path");

function normalizeAppIcon(value) {
  return value === "old" ? "old" : "new";
}

/** Paths for the two shipped marks. `new` is the current build icon. */
function appIconSet(root, id) {
  const which = normalizeAppIcon(id);
  if (which === "old") {
    const dir = path.join(root, "assets", "icons", "old");
    return {
      id: "old",
      ico: path.join(dir, "icon.ico"),
      png: path.join(dir, "icon.png"),
      png64: path.join(dir, "icon-64.png"),
      tray: path.join(dir, "icon-64.png"),
    };
  }
  return {
    id: "new",
    ico: path.join(root, "assets", "icon.ico"),
    png: path.join(root, "assets", "icon.png"),
    png64: path.join(root, "assets", "icon-64.png"),
    tray: path.join(root, "assets", "tray-icon.png"),
  };
}

function resolveAppIconFile(root, id, platform) {
  const files = appIconSet(root, id);
  if (platform === "win32" && fs.existsSync(files.ico)) return files.ico;
  if (fs.existsSync(files.png)) return files.png;
  if (fs.existsSync(files.png64)) return files.png64;
  return null;
}

/** Desktop and taskbar pins for this app, not Grok Bot or other shortcuts. */
function shortcutUsesAppIcon(name, target) {
  const base = path.win32.basename(String(name || "")).toLowerCase();
  if (base === "grok desktop.lnk") return true;
  const normalized = String(target || "").split("/").join("\\").toLowerCase();
  return normalized.endsWith("\\grok desktop.exe");
}

module.exports = {
  normalizeAppIcon,
  appIconSet,
  resolveAppIconFile,
  shortcutUsesAppIcon,
};
