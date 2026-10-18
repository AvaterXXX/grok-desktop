#!/usr/bin/env electron
/**
 * Renders one real conversation read-only to inspect layout problems.
 * The window is never shown and nothing is written back to the session.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const root = path.resolve(__dirname, "..");
const sid = process.argv.find((a) => a.startsWith("--session="))?.split("=")[1];
if (!sid) {
  console.error("--session=<id> is required");
  app.exit(2);
}
const outDir = path.join(root, "artifacts", "media-check");
fs.mkdirSync(outDir, { recursive: true });

const userData = path.join(root, ".media-check-profile");
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-gpu");

const { findSession, loadHistoryPreview } = require("../src/sessions");

function buildBridge(session, messages, assets) {
  const noop = () => {};
  const off = () => () => {};
  const clone = (v) => JSON.parse(JSON.stringify(v));
  globalThis.grokDesktop = {
    platform: "win32",
    listSessions: async () => [clone(session)],
    loadHistory: async () => ({
      session: clone(session),
      messages,
      assets,
      ui: {},
    }),
    openSession: async () => ({
      ok: true,
      session: clone(session),
      models: { availableModels: [] },
    }),
    activateSession: async () => ({ ok: true, session: clone(session), openIds: [session.id] }),
    listCommands: async () => ({ commands: [] }),
    listModels: async () => ({ availableModels: [] }),
    setModel: async () => ({ ok: true }),
    setEffort: async () => ({ ok: true }),
    sessionUsage: async () => ({ ok: false }),
    accountUsage: async () => ({ ok: false }),
    accountProfile: async () => ({ loggedIn: true }),
    appInfo: async () => ({ grokCli: "grok", grokHome: "", desktopVersion: "0.2.5" }),
    getSettings: async () => ({
      desktop: {
        theme: "light",
        locale: "zh",
        localeChosen: true,
        setupDismissed: true,
        trayHintShown: true,
      },
      grok: {},
      models: { models: [] },
    }),
    saveDesktopSettings: async () => ({}),
    saveGrokSettings: async () => ({}),
    saveSessionUi: async () => ({ ok: true }),
    diagnose: async () => ({ ok: true, cliExists: true, loggedIn: true }),
    listWallpapers: async () => [],
    listAgents: async () => ({ openIds: [session.id] }),
    isOccluded: async () => false,
    setBusyCount: async () => ({ ok: true }),
    readImage: async (p) => {
      try {
        const buf = fs.readFileSync(p);
        const ext = path.extname(p).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
        return { dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
      } catch {
        return null;
      }
    },
    previewFile: async () => ({ ok: false }),
    describeFilePaths: async () => [],
    getPathForFile: () => "",
    flashFrame: noop,
    notify: noop,
    openExternal: noop,
    openPath: noop,
    showItem: noop,
    onChunk: off,
    onTool: off,
    onDiff: off,
    onMedia: off,
    onPermission: off,
    onStatus: off,
    onPlan: off,
    onGoal: off,
    onUsage: off,
    onSubagent: off,
    onCodebase: off,
    onAgents: off,
    onLog: off,
    onInsertText: off,
    onPasteRequest: off,
    onCommands: off,
    onMode: off,
    onModels: off,
    onModel: off,
    onTrayNewSession: off,
    onAppCommand: off,
    onOpenSession: off,
    onTrayHint: off,
  };
}

async function main() {
  await app.whenReady();
  const s = findSession(sid);
  if (!s?.dir) throw new Error(`session ${sid} not found`);
  const messages = loadHistoryPreview(s.dir, { maxChars: 200000 });
  const assetsDir = path.join(s.dir, "assets");
  let assets = [];
  try {
    assets = fs
      .readdirSync(assetsDir)
      .filter((n) => /\.(png|jpe?g|gif|webp)$/i.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(assetsDir, name));
        return { name, path: path.join(assetsDir, name), mtimeMs: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    assets = [];
  }
  console.log(`session ${sid}: ${messages.length} rows, ${assets.length} images`);

  const preloadPath = path.join(userData, "bridge.js");
  fs.writeFileSync(
    preloadPath,
    `(${buildBridge.toString()})(${JSON.stringify(s)}, ${JSON.stringify(messages)}, ${JSON.stringify(assets)});`,
    "utf8",
  );

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: 1440,
    height: 900,
    backgroundColor: "#f6f3ed",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(root, "renderer", "index.html"));
  await win.reload();
  await win.webContents.executeJavaScript(`new Promise(r => setTimeout(r, 3500))`);

  const report = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.thread-inner > .turn')];
    const withMedia = rows
      .map((row, i) => ({ i, imgs: row.querySelectorAll('.turn-media img').length }))
      .filter((x) => x.imgs > 0);
    return {
      turns: rows.length,
      mediaRows: withMedia,
      totalImgs: withMedia.reduce((n, x) => n + x.imgs, 0),
      maxPerRow: Math.max(0, ...withMedia.map((x) => x.imgs)),
    };
  })()`);
  console.log(JSON.stringify(report, null, 2));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${sid.slice(0, 8)}-media.png`), img.toPNG());
  console.log("shot:", path.join(outDir, `${sid.slice(0, 8)}-media.png`));

  const ok = report.maxPerRow <= 3;
  win.destroy();
  console.log(ok ? "MEDIA LAYOUT OK" : "MEDIA LAYOUT BAD: images piled on one row");
  app.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  app.exit(1);
});
