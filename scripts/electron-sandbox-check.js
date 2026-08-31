#!/usr/bin/env electron
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const root = path.resolve(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-electron-sandbox-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-gpu");

async function main() {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(root, "preload.js"),
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  await window.loadFile(path.join(root, "tests", "fixtures", "sandbox-check.html"));
  const state = await window.webContents.executeJavaScript(`({
    contextBridgeReady: typeof window.grokDesktop === "object",
    platform: window.grokDesktop?.platform,
    promptApi: typeof window.grokDesktop?.prompt,
    diagnosticsApi: typeof window.grokDesktop?.exportDiagnostics,
    rendererRequire: typeof window.require,
    rendererProcess: typeof window.process,
    slashCatalog: typeof window.GrokSlashCatalog,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ""
  })`);
  assert.equal(state.contextBridgeReady, true);
  assert.ok(["win32", "linux", "darwin"].includes(state.platform));
  assert.equal(state.promptApi, "function");
  assert.equal(state.diagnosticsApi, "function");
  assert.equal(state.rendererRequire, "undefined");
  assert.equal(state.rendererProcess, "undefined");
  assert.equal(state.slashCatalog, "object");
  assert.match(state.csp, /default-src 'self'/);
  console.log(JSON.stringify({ electron: process.versions.electron, sandbox: true, ...state }));
  window.destroy();
}

const timeout = setTimeout(() => {
  console.error("Electron sandbox check timed out");
  app.exit(1);
}, 20_000);

main()
  .then(() => {
    clearTimeout(timeout);
    app.quit();
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error(error.stack || error.message);
    app.exit(1);
  });

app.once("will-quit", () => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    /* temporary test data only */
  }
});
