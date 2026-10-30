#!/usr/bin/env node
// Keep a versioned, unpacked copy so Windows launches Electron directly.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");

if (process.platform !== "win32") throw new Error("This command is for Windows only");
const source = path.resolve(__dirname, "../release/win-unpacked");
const archive = path.join(source, "resources/app.asar");
const executable = "Grok Desktop.exe";
if (!fs.existsSync(archive) || !fs.existsSync(path.join(source, executable))) {
  throw new Error("Run npm run dist:win:dir first");
}
const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
const current = require("../package.json");
if (packaged.version !== current.version) throw new Error("Rebuild the current version first");
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[\w.-]+)?$/.test(packaged.version)) {
  throw new Error("Invalid packaged version");
}
// The executable hash also distinguishes Electron upgrades of the same app.
const digest = crypto.createHash("sha256");
digest.update(fs.readFileSync(archive));
digest.update(fs.readFileSync(path.join(source, executable)));
const buildId = digest.digest("hex").slice(0, 12);
if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is not available");
const destination = path.join(
  process.env.LOCALAPPDATA,
  "Programs/Grok Desktop",
  `${packaged.version}-${buildId}`,
);
const marker = path.join(destination, ".copy-complete");
if (!fs.existsSync(marker)) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
  fs.writeFileSync(marker, `${buildId}\n`);
}
// Explorer cannot load an icon through Electron's virtual asar filesystem.
const icon = path.join(destination, "app-icon.ico");
fs.writeFileSync(icon, asar.extractFile(archive, "assets/icon.ico"));
const shortcutScript = `
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Grok Desktop 快速启动.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $env:GROK_QUICK_EXE
$shortcut.WorkingDirectory = $env:GROK_QUICK_DIR
$shortcut.IconLocation = $env:GROK_QUICK_ICON + ',0'
$shortcut.Description = 'Grok Desktop — 直接启动，无需重复解压'
$shortcut.Save()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output $shortcutPath
`;
const shortcut = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", shortcutScript],
  {
    windowsHide: true,
    encoding: "utf8",
    env: {
      ...process.env,
      GROK_QUICK_EXE: path.join(destination, executable),
      GROK_QUICK_DIR: destination,
      GROK_QUICK_ICON: icon,
    },
  },
).trim();
console.log(
  JSON.stringify(
    { version: packaged.version, executable: path.join(destination, executable), shortcut },
    null,
    2,
  ),
);
