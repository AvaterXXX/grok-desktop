const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  Notification,
  net,
  Tray,
  nativeImage,
  nativeTheme,
  screen,
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const {
  listSessions,
  listSessionsAsync,
  loadHistoryPreviewAsync,
  findSession,
  grokHome,
  ensureSessionSummary,
  renameSession,
  deleteSessionDir,
  rewindLastUserTurn,
  loadSessionPlan,
  saveSessionPlan,
  loadSessionGoal,
  saveSessionGoal,
  clearSessionGoal,
  loadSessionUi,
  saveSessionUi,
} = require("./src/sessions");
const { isGoalAbsentReply, isGoalCleared, normalizeGoalState } = require("./src/goal-state");
const { AcpClient } = require("./src/acp");
const { contextUsageFromPayload } = require("./src/context-usage");
const { buildFileChange, buildHistoryFileChange } = require("./src/diff");
const { searchSessions } = require("./src/search");
const plugins = require("./src/plugins");
const skills = require("./src/skills");
const settings = require("./src/settings");
const { cleanProjects, projectForSession, projectAccessNote } = require("./src/project-dirs");
const { resolveOpenLocale } = require("./src/locale");
const { toTraditional } = require("./src/zh-hant");
const { normalizeAppIcon, appIconSet, resolveAppIconFile } = require("./src/app-icon");
const memory = require("./src/memory");
const mcp = require("./src/mcp");
const hooks = require("./src/hooks");
const {
  addByModel,
  addTokenParts,
  billingFromLog,
  dailyHistoryFromLog,
  emptyDaily,
  emptySpeed,
  mergeByModelMax,
  mergeDayMax,
  mergeUsageSnapshots,
  modelFamilyOf,
  parseBillingPayload,
  pruneHistory,
  readLogTail,
  sessionSpeedFromUpdates,
  shanghaiDate,
  speedStatsFromLog,
  usageSinceFromLog,
  weekStartDate,
} = require("./src/usage");
const { commandExists, defaultCwd, spawnCli, appConfigDir } = require("./src/platform");
const {
  parseCliUpdateCheck,
  cliUpdateSpawnSpec,
  cliUpdateShouldRestart,
  cliUpdatePrompt,
  cliUpdateFailureCopy,
} = require("./src/cli-update");
const { commandsForRenderer } = require("./src/commands-zh");
const { atomicWriteFileSync } = require("./src/file-store");
const { readFilePreview } = require("./src/file-preview");
const { locateExistingPath, locateDeep, locateNamedInDirs } = require("./src/locate-path");
const { restorePreferredModel } = require("./src/model-preference");
const { DiagnosticRing } = require("./src/diagnostics");
const {
  assertPathInside,
  assertTrustedIpcSender,
  boundedString,
  isSafeImagePath,
  isPathInside,
  normalizeAbsolutePath,
  safeExternalUrl,
  validateIpcRequest,
} = require("./src/security");
const { execSync, spawn, execFile } = require("child_process");
const diagnosticRing = new DiagnosticRing({ capacity: 800 });

function ensureWinConsoleUtf8() {
  if (process.platform !== "win32" || process.env.GROK_DESKTOP_UTF8 === "1") return;
  process.env.GROK_DESKTOP_UTF8 = "1";
  try {
    execSync("chcp 65001", { stdio: "ignore", windowsHide: true });
  } catch {
    /* ignore */
  }
  try {
    process.stdout.setDefaultEncoding?.("utf8");
    process.stderr.setDefaultEncoding?.("utf8");
  } catch {
    /* ignore */
  }
}
ensureWinConsoleUtf8();

function applyProxyEnv(raw, enabled) {
  if (typeof settings.applyProxyToProcessEnv === "function") {
    return settings.applyProxyToProcessEnv(raw, enabled);
  }
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  let u = String(raw || "").trim();
  const slash = String.fromCharCode(47);
  if (u && !u.includes(":" + slash + slash)) u = "http:" + slash + slash + u;
  const on = enabled !== false && !!u;
  if (!on) {
    for (const k of keys) delete process.env[k];
    return "";
  }
  for (const k of keys) process.env[k] = u;
  if (!process.env.NO_PROXY && !process.env.no_proxy) process.env.NO_PROXY = "localhost,127.0.0.1";
  return u;
}

function perf(label, t0) {
  const ms = Date.now() - t0;
  diagnosticRing.record("performance", { label, durationMs: ms });
  log(`[perf] ${label} ${ms}ms`);
  return ms;
}


let mainWindow = null;
const registerIpcHandler = ipcMain.handle.bind(ipcMain);
const approvedLocalPaths = new Map();
const APPROVED_PATH_TTL_MS = 60 * 60 * 1000;
const DANGEROUS_OPEN_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".cpl",
  ".exe",
  ".hta",
  ".lnk",
  ".msi",
  ".msp",
  ".ps1",
  ".reg",
  ".scr",
  ".url",
]);

function approveLocalPath(raw) {
  try {
    const full = normalizeAbsolutePath(raw);
    approvedLocalPaths.set(full, Date.now() + APPROVED_PATH_TTL_MS);
    if (approvedLocalPaths.size > 256) {
      const now = Date.now();
      for (const [entry, expiry] of approvedLocalPaths) {
        if (expiry < now || approvedLocalPaths.size > 224) approvedLocalPaths.delete(entry);
      }
    }
    return full;
  } catch {
    return null;
  }
}

function projectPromptText(text, sessionId, cwd) {
  const body = String(text || "");
  if (!body.trim()) return body;
  let desk = {};
  try {
    desk = settings.readDesktopSettings() || {};
  } catch {
    return body;
  }
  const project = projectForSession({ id: sessionId, cwd: cwd }, desk.projects, desk.sessionProjects);
  if (!project) return body;
  const note = projectAccessNote(project.dirs);
  return note ? note + body : body;
}

function localAccessRoots() {
  const roots = new Set([grokHome(), appConfigDir()]);
  for (const entry of agents.values()) if (entry?.cwd) roots.add(entry.cwd);
  if (activeSessionMeta?.cwd) roots.add(activeSessionMeta.cwd);
  try {
    for (const session of listSessions({ limit: 500 })) if (session?.cwd) roots.add(session.cwd);
  } catch {
    /* cached session roots are best effort */
  }
  try {
    for (const root of skills.skillRoots()) if (root?.dir) roots.add(root.dir);
  } catch {
    /* optional compatibility roots */
  }
  try {
    for (const project of cleanProjects(settings.readDesktopSettings().projects)) {
      for (const dir of project.dirs) if (dir) roots.add(dir);
    }
  } catch {
    /* project directories are optional */
  }
  return [...roots];
}

function assertAllowedLocalPath(raw, { permitExecutable = false, anyExisting = false, hints = [] } = {}) {
  const full = normalizeAbsolutePath(raw);
  const now = Date.now();
  let approved = false;
  for (const [entry, expiry] of approvedLocalPaths) {
    if (expiry < now) {
      approvedLocalPaths.delete(entry);
      continue;
    }
    if (full === entry || isPathInside(entry, full)) approved = true;
  }
  if (!anyExisting && !approved) assertPathInside(full, localAccessRoots());
  let resolved = full;
  if (anyExisting) {
    const found = locateExistingPath(full, hints);
    if (!found) throw new Error("本地路径不存在");
    resolved = found;
  }
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error("本地路径不存在");
  }
  if (!permitExecutable && stat.isFile() && DANGEROUS_OPEN_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new Error("出于安全考虑，不能从消息界面执行这个文件");
  }
  return resolved;
}


function projectSearchDirs() {
  const dirs = [];
  const push = (dir) => {
    const full = typeof dir === "string" ? dir.trim() : "";
    if (!full) return;
    const key = process.platform === "win32" ? full.toLowerCase() : full;
    if (dirs.some((item) => (process.platform === "win32" ? item.toLowerCase() : item) === key)) return;
    dirs.push(full);
  };
  try {
    const desk = settings.readDesktopSettings() || {};
    const session = (activeSessionId && (findSession(activeSessionId) || activeSessionMeta)) || activeSessionMeta;
    const project = projectForSession(
      session ? { id: session.id || activeSessionId, cwd: session.cwd } : { id: activeSessionId },
      desk.projects,
      desk.sessionProjects,
    );
    if (project) for (const dir of project.dirs) push(dir);
  } catch {
    /* project settings are optional */
  }
  push(activeSessionMeta?.cwd);
  push(getAgentEntry(activeSessionId)?.cwd);
  return dirs;
}

async function resolveClickedPath(raw, hints, permitExecutable) {
  const full = normalizeAbsolutePath(raw);
  let found = locateExistingPath(full, hints);
  if (!found) found = await locateDeep(full);
  if (!found) {
    const hits = await locateNamedInDirs(projectSearchDirs(), path.basename(full));
    if (hits.length === 1) found = hits[0];
    else if (hits.length > 1) return { ambiguous: hits };
  }
  if (!found) throw new Error("本地路径不存在");
  return { path: assertAllowedLocalPath(found, { permitExecutable, anyExisting: true }) };
}

function normalizePluginInstallSpec(raw) {
  const spec = boundedString(raw, {
    label: "plugin spec",
    max: 2048,
    allowEmpty: false,
    trim: true,
  });
  if (spec.startsWith("-")) throw new Error("插件标识不能以选项符号开头");
  if (/^file:/i.test(spec)) throw new Error("不接受 file: 插件地址，请选择工作区内的本地目录");
  if (path.isAbsolute(spec)) return assertAllowedLocalPath(spec, { permitExecutable: true });
  if (/^\.{1,2}[\\\/]/.test(spec)) {
    return assertAllowedLocalPath(path.resolve(workspaceCliCwd(), spec), { permitExecutable: true });
  }
  return spec;
}

/** Register IPC with one source check shared by every request. */
function handleIpc(channel, handler) {
  registerIpcHandler(channel, (event, ...args) => {
    const startedAt = Date.now();
    try {
      assertTrustedIpcSender(event, mainWindow?.webContents);
      const safeArgs = validateIpcRequest(channel, args);
      return Promise.resolve(handler(event, ...safeArgs)).then(
        (result) => {
          diagnosticRing.record("ipc:complete", {
            channel,
            durationMs: Date.now() - startedAt,
            ok: true,
          });
          return result;
        },
        (error) => {
          diagnosticRing.record("ipc:complete", {
            channel,
            durationMs: Date.now() - startedAt,
            ok: false,
            errorCode: error?.code || error?.name || "Error",
          });
          throw error;
        },
      );
    } catch (error) {
      diagnosticRing.record("ipc:rejected", {
        channel,
        durationMs: Date.now() - startedAt,
        errorCode: error?.code || error?.name || "Error",
      });
      throw error;
    }
  });
}
/** @type {import('electron').Tray | null} */
let tray = null;
/** When true, the next window close really quits (tray Quit / before-quit). */
let isQuitting = false;
/** Debounce timer for window bounds persistence */
let boundsSaveTimer = null;
/** Busy agent count for tray / taskbar feedback */
let busyAgentCount = 0;
/** @type {Map<string, { client: import('./src/acp').AcpClient, meta: object|null, cwd: string, lastUsed: number }>} */
const agents = new Map();
/** session:open promises still attaching a CLI session. */
const openingAgents = new Map();

function openAgentIds() {
  const ids = [];
  for (const [id, entry] of agents) {
    const client = entry?.client;
    if (client?.started && client.proc && client.sessionId === id && !client.suspended) ids.push(id);
  }
  return ids;
}
/** Currently focused session id (UI active tab). */
let activeSessionId = null;
/** @type {object|null} */
let activeSessionMeta = null;
/** Per-open generation to cancel stale openSession results for a given request. */
let openGeneration = 0;
/** Max parallel agent processes (LRU dispose when exceeded). */
const MAX_AGENTS = 6;

const DESKTOP_VERSION = require("./package.json").version;
const RELEASES_URL = "https://github.com/AvaterXXX/grok-desktop/releases";
const REPO_URL = "https://github.com/AvaterXXX/grok-desktop";

async function openExternalUrl(raw) {
  const url = safeExternalUrl(raw);
  await shell.openExternal(url);
  return url;
}

// Match dark UI on Windows/Linux title bars
try {
  nativeTheme.themeSource = (function(){try{const t=settings.readDesktopSettings().theme;if(t==="light"||t==="dark"||t==="system")return t}catch(e){}return "system"})();
} catch {
  /* ignore */
}

// Windows toast grouping / Start menu identity
if (process.platform === "win32") {
  try {
    app.setAppUserModelId("com.xiaokaige.grok-desktop");
  } catch {
    /* ignore */
  }
}

// Single instance so tray / notifications always target one process
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function readSystemLocale() {
  try {
    return typeof app.getLocale === "function" ? app.getLocale() || "" : "";
  } catch {
    return "";
  }
}

function uiLocale() {
  const systemTag = readSystemLocale();
  try {
    return resolveOpenLocale(settings.readDesktopSettings(), systemTag);
  } catch {
    return resolveOpenLocale(null, systemTag);
  }
}

function L(en, zh) {
  const loc = uiLocale();
  if (loc === "en") return en;
  if (loc === "zh-Hant") return toTraditional(zh);
  return zh;
}

function resolveGrokCli() {
  return plugins.resolveGrokCli();
}

function log(msg) {
  const safe = String(msg ?? "").replace(/…/g, "...").replace(/—/g, "-");
  const line = `[${new Date().toISOString()}] ${safe}`;
  try {
    process.stdout.write(line + "\n", "utf8");
  } catch {
    console.log(line);
  }
  send("log", line);
}

function send(channel, payload) {
  try {
    if (channel === "session:status") {
      const entry = getAgentEntry(payload?.sessionId || payload?.session?.id);
      if (entry) {
        const agentBusy = entry.client.isBusy();
        entry.busy = agentBusy;
        payload = { ...payload, agentBusy };
        if (agentBusy && payload.state === "ready") {
          payload.state = "working";
          payload.detail = "任务运行中…";
        }
      }
    }
    diagnosticRing.record("renderer:event", {
      channel,
      sessionId: payload?.sessionId || payload?.session?.id || null,
      state: payload?.state || payload?.status || null,
    });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch {
    /* ignore */
  }
}

function pathToDataUrl(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    // cap ~8MB for UI
    if (buf.length > 8 * 1024 * 1024) return null;
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".gif"
            ? "image/gif"
            : ext === ".webp"
              ? "image/webp"
              : ext === ".bmp"
                ? "image/bmp"
              : ext === ".avif"
                ? "image/avif"
              : ext === ".svg"
                ? "image/svg+xml"
                : "application/octet-stream";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function mediaForRenderer(media) {
  if (!media) return null;
  if (media.kind === "base64" && media.data) {
    return {
      kind: "dataUrl",
      dataUrl: `data:${media.mimeType || "image/png"};base64,${media.data}`,
      mimeType: media.mimeType,
    };
  }
  if (media.kind === "path" && media.path) {
    const dataUrl = pathToDataUrl(media.path);
    if (!dataUrl) return { kind: "path", path: media.path, mimeType: media.mimeType };
    return { kind: "dataUrl", dataUrl, path: media.path, mimeType: media.mimeType };
  }
  return media;
}

const APP_ICON = path.join(__dirname, "assets", "icon.png");
const UPDATE_CHECK_TIMEOUT_MS = 10_000;
/** macOS menu-bar template (black + alpha; system tints to match bar) */
const APP_TRAY_TEMPLATE = path.join(__dirname, "assets", "iconTemplate.png");
const APP_TRAY_TEMPLATE_2X = path.join(__dirname, "assets", "iconTemplate@2x.png");
const APP_TRAY_TEMPLATE_LG = path.join(__dirname, "assets", "trayTemplate.png");
const APP_TRAY_ICON = path.join(__dirname, "assets", "tray-icon.png");

function selectedAppIconId() {
  try {
    return normalizeAppIcon(settings.readDesktopSettings().appIcon);
  } catch {
    return "new";
  }
}

function appIconFiles() {
  return appIconSet(__dirname, selectedAppIconId());
}

function resolveAppIconPath() {
  return resolveAppIconFile(__dirname, selectedAppIconId(), process.platform);
}

function resolveTrayImage() {
  // macOS: template image — transparent, no black plate; matches light/dark menu bar.
  // The previous mark has no template, so it uses the color icon below.
  if (process.platform === "darwin" && selectedAppIconId() === "new") {
    const macCandidates = [
      APP_TRAY_TEMPLATE_2X,
      APP_TRAY_TEMPLATE,
      APP_TRAY_TEMPLATE_LG,
      APP_TRAY_ICON,
    ];
    for (const p of macCandidates) {
      if (!fs.existsSync(p)) continue;
      try {
        let img = nativeImage.createFromPath(p);
        if (img.isEmpty()) continue;
        // Prefer ~18–22px logical size in the menu bar
        const { width, height } = img.getSize();
        if (width > 22 || height > 22) {
          img = img.resize({ width: 18, height: 18, quality: "best" });
        }
        try {
          img.setTemplateImage(true);
        } catch {
          /* older Electron */
        }
        return img;
      } catch {
        /* try next */
      }
    }
  }

  const files = appIconFiles();
  const candidates =
    process.platform === "win32"
      ? [files.tray, files.png64, files.ico, files.png]
      : [files.tray, files.png64, files.png, files.ico];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        // Windows tray icons look sharper when kept small
        if (process.platform === "win32" && (img.getSize().width > 32 || img.getSize().height > 32)) {
          return img.resize({ width: 16, height: 16 });
        }
        return img;
      }
    } catch {
      /* try next */
    }
  }
  return nativeImage.createEmpty();
}

function installedAppIconFile() {
  const id = selectedAppIconId();
  const src = appIconFiles().ico;
  if (!src || !fs.existsSync(src)) return null;
  try {
    const dir = path.join(appConfigDir(), "icons");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, id + ".ico");
    fs.copyFileSync(src, dest);
    return dest;
  } catch {
    return null;
  }
}

function publishWindowsShortcutIcon() {
  if (process.platform !== "win32") return;
  const icoPath = installedAppIconFile();
  if (!icoPath) return;
  const command = [
    "$icon = $env:GROK_APP_ICON",
    "$sh = New-Object -ComObject WScript.Shell",
    "$dirs = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'))",
    "foreach ($dir in $dirs) {",
    "  if (-not (Test-Path -LiteralPath $dir)) { continue }",
    "  Get-ChildItem -LiteralPath $dir -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {",
    "    $lnk = $sh.CreateShortcut($_.FullName)",
    "    $target = [string]$lnk.TargetPath",
    "    $name = $_.Name",
    "    $use = ($name -eq 'Grok Desktop.lnk') -or ($target.ToLower().EndsWith('\\grok desktop.exe'))",
    "    if ($use) {",
    "      $lnk.IconLocation = $icon + ',0'",
    "      $lnk.Save()",
    "    }",
    "  }",
    "}",
  ].join("\n");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { env: { ...process.env, GROK_APP_ICON: icoPath }, windowsHide: true },
    () => {},
  );
}

function applyAppIcon() {
  const iconPath = resolveAppIconPath();
  if (iconPath && mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.setIcon(iconPath);
    } catch {
      /* ignore */
    }
  }
  const png = appIconFiles().png;
  if (png && fs.existsSync(png) && app.dock?.setIcon) {
    try {
      app.dock.setIcon(png);
    } catch {
      /* ignore */
    }
  }
  if (tray) {
    try {
      const image = resolveTrayImage();
      if (image && !image.isEmpty()) tray.setImage(image);
    } catch {
      /* ignore */
    }
  }
  publishWindowsShortcutIcon();
}

function closeToTrayEnabled() {
  try {
    const ds = settings.readDesktopSettings();
    if (ds.closeToTray === undefined || ds.closeToTray === null) {
      return process.platform !== "darwin";
    }
    return !!ds.closeToTray;
  } catch {
    return process.platform !== "darwin";
  }
}

function minimizeToTrayEnabled() {
  try {
    return !!settings.readDesktopSettings().minimizeToTray;
  } catch {
    return false;
  }
}

function isWindowOccluded() {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  if (!mainWindow.isVisible()) return true;
  if (mainWindow.isMinimized()) return true;
  try {
    return !mainWindow.isFocused();
  } catch {
    return true;
  }
}

function clampWindowBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const width = Math.max(800, Math.round(Number(bounds.width) || 1080));
  const height = Math.max(520, Math.round(Number(bounds.height) || 700));
  let x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : undefined;
  let y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : undefined;
  try {
    const displays = screen.getAllDisplays();
    if (displays.length && x != null && y != null) {
      const visible = displays.some((d) => {
        const b = d.bounds;
        const cx = x + Math.min(80, width / 2);
        const cy = y + Math.min(40, height / 2);
        return cx >= b.x && cy >= b.y && cx < b.x + b.width && cy < b.y + b.height;
      });
      if (!visible) {
        x = undefined;
        y = undefined;
      }
    }
  } catch {
    /* ignore */
  }
  return { x, y, width, height };
}

function readSavedWindowState() {
  try {
    const ds = settings.readDesktopSettings();
    return {
      bounds: clampWindowBounds(ds.windowBounds),
      maximized: !!ds.windowMaximized,
    };
  } catch {
    return { bounds: null, maximized: false };
  }
}

function persistWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || isQuitting) return;
  try {
    const maximized = mainWindow.isMaximized();
    const bounds = mainWindow.getBounds();
    settings.writeDesktopSettings({
      windowMaximized: maximized,
      windowBounds: maximized
        ? settings.readDesktopSettings().windowBounds || bounds
        : bounds,
    });
  } catch {
    /* ignore */
  }
}

function schedulePersistWindowState() {
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    persistWindowState();
  }, 350);
}

function syncLoginItemFromSettings(ds) {
  try {
    if (typeof app.setLoginItemSettings !== "function") return;
    const openAtLogin = !!(ds || settings.readDesktopSettings()).openAtLogin;
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false,
      path: process.execPath,
      args: [],
    });
  } catch (err) {
    log(`login item sync failed: ${err.message}`);
  }
}

function refreshTrayMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(buildTrayMenu());
    updateTrayStatus();
  } catch {
    /* ignore */
  }
}

function updateTrayStatus(busyCount) {
  if (typeof busyCount === "number") busyAgentCount = Math.max(0, busyCount);
  if (!tray) return;
  let tip = "Grok Desktop";
  if (busyAgentCount > 0) {
    tip = L(`Grok Desktop · ${busyAgentCount} running`, `Grok Desktop · ${busyAgentCount} 个任务进行中`);
  }
  try {
    tray.setToolTip(tip);
  } catch {
    /* ignore */
  }
}

function setTaskbarWorking(working) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (working) {
      // Indeterminate progress while agent works
      mainWindow.setProgressBar(2, { mode: "indeterminate" });
    } else {
      mainWindow.setProgressBar(-1);
    }
  } catch {
    /* ignore */
  }
}

function flashTaskbarIfNeeded() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isWindowOccluded()) return;
  try {
    mainWindow.flashFrame(true);
  } catch {
    /* ignore */
  }
}

function showMainWindow(opts = {}) {
  const { sessionId } = opts;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  try {
    mainWindow?.flashFrame?.(false);
  } catch {
    /* ignore */
  }
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.show();
    } catch {
      /* ignore */
    }
  }
  if (sessionId) {
    send("app:open-session", { sessionId });
  }
  return mainWindow;
}

function hideMainWindowToTray({ silent } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.hide();
    } catch {
      /* ignore */
    }
  }
  refreshTrayMenu();
  if (!silent) {
    try {
      const ds = settings.readDesktopSettings();
      if (!ds.trayHintShown) {
        settings.writeDesktopSettings({ trayHintShown: true });
        // Short OS toast so users don't think the app crashed
        if (Notification.isSupported()) {
          const n = new Notification({
            title: L("Grok Desktop is still running", "Grok Desktop 仍在运行"),
            body: L("Minimized to the system tray. Right-click the tray icon to quit.", "已最小化到系统托盘。右键托盘图标可退出。"),
            silent: true,
            icon: resolveAppIconPath() || undefined,
          });
          n.on("click", () => showMainWindow());
          n.show();
        }
        send("app:tray-hint", { locale: uiLocale() });
      }
    } catch {
      /* ignore */
    }
  }
}

function quitApp() {
  isQuitting = true;
  persistWindowState();
  app.quit();
}

function sendAppCommand(command, payload) {
  showMainWindow();
  send("app:command", { command, ...(payload || {}) });
}

function buildTrayMenu() {
  const busyLabel =
    busyAgentCount > 0
      ? L(`Running · ${busyAgentCount}`, `运行中 · ${busyAgentCount}`): L("Idle", "空闲");
  return Menu.buildFromTemplate([
    { label: `Grok Desktop  v${DESKTOP_VERSION}`, enabled: false },
    { label: busyLabel, enabled: false },
    { type: "separator" },
    {
      label: L("Show window", "显示窗口"),
      click: () => showMainWindow(),
    },
    {
      label: L("New session", "新建会话"),
      click: () => sendAppCommand("new-session"),
    },
    {
      label: L("Settings", "设置"),
      click: () => sendAppCommand("open-settings"),
    },
    { type: "separator" },
    {
      label: L("Quit Grok Desktop", "退出 Grok Desktop"),
      click: () => quitApp(),
    },
  ]);
}

function createTray() {
  if (tray) return tray;
  const image = resolveTrayImage();
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  } catch (err) {
    log(`tray create failed: ${err.message}`);
    tray = null;
    return null;
  }
  tray.setToolTip("Grok Desktop");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      showMainWindow();
      return;
    }
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      if (closeToTrayEnabled()) hideMainWindowToTray();
      else mainWindow.minimize();
    } else {
      showMainWindow();
    }
  });
  tray.on("double-click", () => showMainWindow());
  return tray;
}

function destroyTray() {
  if (tray) {
    try {
      tray.destroy();
    } catch {
      /* ignore */
    }
    tray = null;
  }
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const fileMenu = {
    label: L("File", "文件"),
    submenu: [
      {
        label: L("New Session", "新建会话"),
        accelerator: "CmdOrCtrl+N",
        click: () => sendAppCommand("new-session"),
      },
      {
        label: L("Settings", "设置"),
        accelerator: "CmdOrCtrl+,",
        click: () => sendAppCommand("open-settings"),
      },
      { type: "separator" },
      isMac
        ? { role: "close", label: L("Close Window", "关闭窗口")}
        : {
            label: L("Hide to Tray", "隐藏到托盘"),
            accelerator: "CmdOrCtrl+H",
            click: () => {
              if (closeToTrayEnabled()) hideMainWindowToTray();
              else mainWindow?.minimize();
            },
          },
      {
        label: L("Quit", "退出"),
        accelerator: isMac ? "Cmd+Q" : "Ctrl+Q",
        click: () => quitApp(),
      },
    ],
  };
  const editMenu = {
    label: L("Edit", "编辑"),
    submenu: [
      { role: "undo", label: L("Undo", "撤销")},
      { role: "redo", label: L("Redo", "重做")},
      { type: "separator" },
      { role: "cut", label: L("Cut", "剪切")},
      { role: "copy", label: L("Copy", "复制")},
      { role: "paste", label: L("Paste", "粘贴")},
      { role: "selectAll", label: L("Select All", "全选")},
    ],
  };
  const viewMenu = {
    label: L("View", "查看"),
    submenu: [
      {
        label: L("Toggle Plan Panel", "切换计划面板"),
        accelerator: "CmdOrCtrl+P",
        click: () => sendAppCommand("toggle-plan"),
      },
      { type: "separator" },
      { role: "reload", label: L("Reload", "重新加载")},
      { role: "toggleDevTools", label: L("Toggle Developer Tools", "开发者工具")},
      { type: "separator" },
      { role: "resetZoom", label: L("Actual Size", "实际大小")},
      { role: "zoomIn", label: L("Zoom In", "放大")},
      { role: "zoomOut", label: L("Zoom Out", "缩小")},
      { type: "separator" },
      { role: "togglefullscreen", label: L("Toggle Full Screen", "全屏")},
    ],
  };
  const helpMenu = {
    label: L("Help", "帮助"),
    submenu: [
      {
        label: L("Check for Updates", "检查更新"),
        click: () => sendAppCommand("check-update"),
      },
      {
        label: L("Open Releases", "打开发布页"),
        click: () => openExternalUrl(RELEASES_URL).catch((err) => log(`open release link: ${err.message}`)),
      },
      {
        label: L("GitHub Repository", "GitHub 仓库"),
        click: () => openExternalUrl(REPO_URL).catch((err) => log(`open repository link: ${err.message}`)),
      },
      { type: "separator" },
      {
        label: L(`About Grok Desktop ${DESKTOP_VERSION}`, `关于 Grok Desktop ${DESKTOP_VERSION}`),
        click: () => sendAppCommand("open-about"),
      },
    ],
  };
  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: L("About Grok Desktop", "关于 Grok Desktop")},
        { type: "separator" },
        {
          label: L("Settings", "设置"),
          accelerator: "CmdOrCtrl+,",
          click: () => sendAppCommand("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: L("Quit", "退出")},
      ],
    });
  }
  template.push(fileMenu, editMenu, viewMenu, helpMenu);
  return Menu.buildFromTemplate(template);
}

function installAppMenu() {
  try {
    Menu.setApplicationMenu(buildAppMenu());
  } catch (err) {
    log(`menu install failed: ${err.message}`);
  }
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  const saved = readSavedWindowState();
  const b = saved.bounds || {};
  const winOpts = {
    width: b.width || 1080,
    height: b.height || 700,
    minWidth: 800,
    minHeight: 520,
    title: "Grok Desktop",
    icon: iconPath || undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#f5f5f7",
    show: false,
    autoHideMenuBar: process.platform === "win32",
    // macOS: hide native title bar but keep traffic lights; drag via CSS -webkit-app-region
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    backgroundMaterial: process.platform === "win32" ? "none" : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
  if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
    winOpts.x = b.x;
    winOpts.y = b.y;
  }

  mainWindow = new BrowserWindow(winOpts);

  if (process.platform === "win32") {
    try {
      mainWindow.setAutoHideMenuBar(true);
      mainWindow.setMenuBarVisibility(false);
    } catch {
      /* ignore */
    }
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.key === "Alt") {
        event.preventDefault();
        try {
          mainWindow.setMenuBarVisibility(false);
        } catch {
          /* ignore */
        }
      }
    });
    mainWindow.on("focus", () => {
      try {
        mainWindow.setMenuBarVisibility(false);
      } catch {
        /* ignore */
      }
    });
  }

  // Windows 11: prefer dark window controls to match in-app chrome
  if (process.platform === "win32") {
    try {
      if (typeof mainWindow.setTitleBarOverlay === "function") {
        // only applies with hidden title bar; safe no-op otherwise
      }
    } catch {
      /* ignore */
    }
  }

  mainWindow.once("ready-to-show", () => {
    if (saved.maximized) {
      try {
        mainWindow.maximize();
      } catch {
        /* ignore */
      }
    }
    mainWindow.show();
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("resize", schedulePersistWindowState);
  mainWindow.on("move", schedulePersistWindowState);
  mainWindow.on("maximize", schedulePersistWindowState);
  mainWindow.on("unmaximize", schedulePersistWindowState);
  mainWindow.on("focus", () => {
    try {
      mainWindow.flashFrame(false);
    } catch {
      /* ignore */
    }
  });

  mainWindow.on("minimize", (e) => {
    if (isQuitting || !minimizeToTrayEnabled() || !closeToTrayEnabled()) return;
    e.preventDefault();
    hideMainWindowToTray();
  });

  // Close → tray. Real exit only via tray Quit / menu Quit / isQuitting.
  mainWindow.on("close", (e) => {
    if (isQuitting || !closeToTrayEnabled()) {
      persistWindowState();
      return;
    }
    e.preventDefault();
    hideMainWindowToTray();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Any window.open / target=_blank → system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url).catch((err) => log(`blocked external window: ${err.message}`));
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    const current = mainWindow?.webContents?.getURL?.() || "";
    if (url.split("#", 1)[0] === current.split("#", 1)[0]) return;
    e.preventDefault();
    openExternalUrl(url).catch((err) => log(`blocked navigation: ${err.message}`));
  });
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    log("blocked unexpected webview attachment");
  });

  // Native right-click context menu (localized)
  mainWindow.webContents.on("context-menu", (_e, params) => {
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: "undo", label: L("Undo", "撤销")},
        { role: "redo", label: L("Redo", "重做")},
        { type: "separator" },
        { role: "cut", label: L("Cut", "剪切"), enabled: params.editFlags?.canCut !== false },
        { role: "copy", label: L("Copy", "复制"), enabled: params.editFlags?.canCopy !== false },
        { role: "paste", label: L("Paste", "粘贴"), enabled: params.editFlags?.canPaste !== false },
        { role: "selectAll", label: L("Select All", "全选")},
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: "copy", label: L("Copy", "复制")});
      template.push({
        label: L("Copy & paste into composer", "复制并粘贴到输入框"),
        click: () => {
          mainWindow.webContents.send("chat:insert-text", params.selectionText);
        },
      });
    } else {
      template.push({
        label: L("Paste into composer", "粘贴到输入框"),
        click: () => {
          mainWindow.webContents.send("chat:paste-request");
        },
      });
    }
    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });
}

/** Strip heavy file bodies before sending diff to renderer. */
function approveChangedFile(filePath) {
  try {
    if (fs.statSync(filePath).isFile()) {
      approveLocalPath(filePath);
      approveLocalPath(fs.realpathSync(filePath));
    }
  } catch { /* Deleted files still retain their saved diff. */ }
}

function toDiffEvent(change) {
  if (!change) return null;
  approveChangedFile(change.path);
  const { before: _before, after: _after, ...light } = change;
  return light;
}

function getAgentEntry(sessionId) {
  if (!sessionId) return null;
  return agents.get(sessionId) || null;
}

function getAgent(sessionId) {
  return getAgentEntry(sessionId)?.client || null;
}

function activeAgent() {
  return getAgent(activeSessionId);
}

function touchAgent(sessionId) {
  const e = getAgentEntry(sessionId);
  if (e) e.lastUsed = Date.now();
}

/** ACP stdin JSON + session history die on huge screenshots. */
const MAX_ACP_IMAGE_BYTES = Math.floor(3.5 * 1024 * 1024);

function decodedB64Bytes(b64) {
  const s = String(b64 || "");
  if (!s) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

function isDeadCliError(err) {
  const msg = String(err && (err.message || err) || "");
  return /Grok process exited|Grok process not running|EPIPE|write failed/i.test(msg);
}

async function reviveAgent(sessionId) {
  const prev = getAgentEntry(sessionId);
  const selectedModel = prev?.client?.currentModelId;
  const selectedEffort = prev?.client?.currentEffort;
  const found = findSession(sessionId);
  const rawCwd = (prev && prev.cwd) || (found && found.cwd) || "";
  const cwd = rawCwd && fs.existsSync(rawCwd) ? rawCwd : defaultCwd();
  try {
    disposeAgent(sessionId);
  } catch {
    /* already gone */
  }
  const client = await ensureAgent(sessionId, cwd);
  await client.loadSession(sessionId);
  if (selectedModel && selectedModel !== client.currentModelId) await client.setModel(selectedModel);
  if (selectedEffort) await client.setEffort(selectedEffort);
  const s = found || findSession(sessionId);
  const entry = getAgentEntry(sessionId);
  if (entry) entry.meta = s || entry.meta || null;
  if (!activeSessionId || activeSessionId === sessionId) {
    activeSessionId = sessionId;
    activeSessionMeta = s || (entry && entry.meta) || activeSessionMeta;
  }
  send("agents:update", { openIds: openAgentIds(), activeSessionId });
  send("session:status", {
    state: "ready",
    detail: "已重连",
    session: s || (entry && entry.meta) || null,
    sessionId,
  });
  return client;
}

function disposeAgent(sessionId) {
  const e = agents.get(sessionId);
  if (!e) return;
  try {
    e.client.dispose();
  } catch {
    /* ignore */
  }
  agents.delete(sessionId);
  if (activeSessionId === sessionId) {
    activeSessionId = null;
  }
  send("agents:update", { openIds: openAgentIds(), activeSessionId });
  send("session:status", {
    state: "disconnected",
    detail: "助手已关闭",
    sessionId,
  });
}

function disposeAllAgents() {
  for (const id of [...agents.keys()]) disposeAgent(id);
}

function evictLruAgents(keepId) {
  while (agents.size > MAX_AGENTS) {
    let victim = null;
    let oldest = Infinity;
    for (const [id, e] of agents) {
      // Never kill the agent we're opening, the focused one, or one mid-prompt
      if (id === keepId || id === activeSessionId) continue;
      if (e.busy) continue;
      if (e.lastUsed < oldest) {
        oldest = e.lastUsed;
        victim = id;
      }
    }
    if (!victim) {
      // Prefer idle non-active; only as last resort skip busy ones entirely
      for (const id of agents.keys()) {
        if (id === keepId || id === activeSessionId) continue;
        if (agents.get(id)?.busy) continue;
        victim = id;
        break;
      }
    }
    if (!victim) {
      // All slots protected (busy/active) — allow exceeding MAX temporarily
      log(`agent pool full (${agents.size}/${MAX_AGENTS}); all busy/active, skip eviction`);
      break;
    }
    log(`evict agent ${victim.slice(0, 8)} (max ${MAX_AGENTS})`);
    disposeAgent(victim);
  }
}

function wireAcpEvents(client, sessionIdHint) {
  const sid = () => client.sessionId || sessionIdHint || null;

  const withSid = (payload) => ({ ...payload, sessionId: sid() });

  client.on("activity", ({ busy }) => {
    if (getAgent(sid()) !== client) return;
    send("session:status", withSid({
      state: busy ? "working" : "ready",
      detail: busy ? "任务运行中…" : "就绪",
    }));
  });

  client.on("messageChunk", (text) =>
    send("chat:chunk", withSid({ kind: "assistant", text })),
  );
  client.on("thoughtChunk", (text) =>
    send("chat:chunk", withSid({ kind: "thought", text })),
  );
  client.on("toolCall", (payload) => {
    const full = {
      phase: "start",
      ...payload,
      title: payload.title || payload.kind || "tool",
      status: payload.status || "running",
    };
    send("chat:tool", withSid(full));
    // File-change / diff preview for write-like tools (light payload, no full file bodies)
    try {
      const change = buildFileChange(full, client.cwd);
      if (change) send("chat:diff", withSid(toDiffEvent(change)));
    } catch (err) {
      log(`diff build failed: ${err.message}`);
    }
  });
  client.on("toolCallUpdate", (payload) => {
    const full = {
      phase: "update",
      ...payload,
      status: payload.status || "updated",
    };
    send("chat:tool", withSid(full));
    try {
      const change = buildFileChange(full, client.cwd);
      if (change) send("chat:diff", withSid({ ...toDiffEvent(change), status: full.status }));
    } catch {
      /* ignore */
    }
  });
  client.on("subagentLifecycle", (update, meta) => {
    send("chat:subagent", withSid({ kind: "lifecycle", update: update || {}, meta: meta || null }));
  });
  client.on("childStream", (info) => {
    send("chat:subagent", withSid({ kind: "child", ...(info || {}) }));
  });
  client.on("codebase", (info) => {
    send("chat:codebase", withSid(info || {}));
  });
  client.on("permissionRequest", (req) => send("chat:permission", withSid(req)));
  client.on("mediaContent", (media) => {
    const m = mediaForRenderer(media);
    if (m) send("chat:media", withSid(m));
  });
  client.on("commands", (list) => {
    send("commands:update", withSid({ commands: commandsForRenderer(list) }));
  });
  client.on("mode", (mode) => send("session:mode", withSid({ mode })));
  client.on("model", (modelId) => send("session:model", withSid({ modelId })));
  client.on("plan", (update) => {
    const payload = withSid(update || {});
    try {
      const s = findSession(sid());
      if (s?.dir) saveSessionPlan(s.dir, payload);
    } catch {
      /* ignore */
    }
    send("session:plan", payload);
  });
  client.on("goal", (update) => {
    const goal = normalizeGoalState(update);
    if (!goal) return;
    const payload = withSid(goal);
    try {
      const s = findSession(sid());
      if (s?.dir) {
        if (goal.completed) {
          clearSessionGoal(s.dir, {
            terminalGoal: goal,
            clearPlan: isGoalCleared(goal),
          });
        }
        else saveSessionGoal(s.dir, goal);
      }
    } catch {
      /* renderer still receives the live state */
    }
    send("session:goal", payload);
  });
  client.on("usage", (usage) => {
    const modelId =
      usage?.modelId || usage?.model ||
      (!client.hydrateMode && client.requestModelId) || client.currentModelId || "";
    const payload = { ...(usage || {}), modelId };
    try {
      noteDailyFromUsage(payload, sid());
    } catch {
      /* ignore */
    }
    send("session:usage", withSid(payload));
  });
  client.on("exit", (code) => {
    const id = sid();
    if (client.disposing || getAgent(id) !== client) return;
    send(
      "session:status",
      withSid({ state: "disconnected", detail: `agent 已退出 (${code})` }),
    );
    if (id) agents.delete(id);
    send("agents:update", { openIds: openAgentIds(), activeSessionId });
  });
  client.on("error", (err) =>
    send("session:status", withSid({ state: "error", detail: err.message })),
  );
  client.on("compact", () =>
    send("session:status", withSid({ state: "working", detail: "正在压缩上下文", compact: true })),
  );
}

/**
 * Create a fresh ACP client for cwd (not yet mapped to a session id).
 */
async function createClient(cwd) {
  const _t = Date.now();
  const desk = settings.readDesktopSettings();
  applyProxyEnv(desk.proxyUrl, desk.proxyEnabled !== false);
  log(`[perf] createClient start cwd=${cwd || ""}`);
  const env = { ...process.env };
  if (memory.isEnabledInConfig()) env.GROK_MEMORY = "1";
  /* desk already read */
  const cliPath = resolveGrokCli();
  if (!commandExists(cliPath)) {
    throw new Error(
      `未找到 Grok CLI：${cliPath}。请先安装并登录官方 Grok CLI，或设置 GROK_CLI 为完整路径。`,
    );
  }
  const client = new AcpClient({
    cliPath,
    cwd,
    env,
    log,
    experimentalMemory: memory.isEnabledInConfig(),
  });
  client.setAutoApprove(desk.autoApprove !== false);
  perf("createClient spawn", _t);
  await client.start();
  return client;
}

/**
 * Ensure an agent process exists for sessionId (reuses if still alive).
 */
async function ensureAgent(sessionId, cwd) {
  const existing = getAgentEntry(sessionId);
  const live = existing?.client;
  // A process can be up before session/load assigns sessionId. Reuse it.
  // Disposing here used to race the in-flight load and leave nothing to send to.
  if (live?.started && live.proc && !live.disposing && !live.suspended) {
    if (!live.sessionId || live.sessionId === sessionId) {
      touchAgent(sessionId);
      return live;
    }
  }
  if (existing) disposeAgent(sessionId);

  evictLruAgents(sessionId);
  const client = await createClient(cwd);
  wireAcpEvents(client, sessionId);
  agents.set(sessionId, {
    client,
    meta: null,
    cwd,
    lastUsed: Date.now(),
    busy: false,
  });
  send("agents:update", { openIds: openAgentIds(), activeSessionId });
  return client;
}

function registerAgent(sessionId, client, cwd, meta) {
  // if another entry held this client under a temp key, clean up
  for (const [id, e] of agents) {
    if (e.client === client && id !== sessionId) agents.delete(id);
  }
  agents.set(sessionId, {
    client,
    meta: meta || null,
    cwd,
    lastUsed: Date.now(),
    busy: false,
  });
  send("agents:update", { openIds: openAgentIds(), activeSessionId });
}

// Linux taskbar / .desktop StartupWMClass friendliness
try { const d = settings.readDesktopSettings(); applyProxyEnv(d.proxyUrl, d.proxyEnabled !== false); } catch { /* ignore */ }
app.setName("Grok Desktop");
if (process.platform === "linux" && fs.existsSync(APP_ICON)) {
  // Helps some desktops associate the running window with our icon
  app.whenReady().then(() => {
    try {
      if (app.dock?.setIcon) app.dock.setIcon(APP_ICON);
    } catch {
      /* ignore */
    }
  });
}

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    installAppMenu();
    syncLoginItemFromSettings();
    createTray();
    createWindow();
    applyAppIcon();
    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
      else showMainWindow();
    });
  });

  // With tray + close-to-tray, an empty window list means we are hidden, not done.
  app.on("window-all-closed", () => {
    if (isQuitting) {
      disposeAllAgents();
      return;
    }
    if (closeToTrayEnabled() && tray) {
      return;
    }
    disposeAllAgents();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    persistWindowState();
    disposeAllAgents();
    destroyTray();
  });
}

// ── Sessions ───────────────────────────────────────────

handleIpc("sessions:list", async (_e, { limit } = {}) => {
  try {
    const _t = Date.now();
    const rows = await listSessionsAsync({ limit: limit || 200 });
    perf("sessions:list n=" + (rows?.length || 0), _t);
    return rows;
  } catch (err) {
    log(`sessions:list ${err.message}`);
    return [];
  }
});

handleIpc("sessions:rename", async (_e, { sessionId, title }) => {
  return renameSession(sessionId, title);
});

/** 会话本地目录（供「在文件夹中显示」） */
handleIpc("sessions:path", async (_e, { sessionId } = {}) => {
  const s = findSession(sessionId);
  if (!s?.dir) return { ok: false, error: "会话目录不存在" };
  return { ok: true, path: s.dir, id: s.id, cwd: s.cwd || null, title: s.title || null };
});

handleIpc("sessions:usage", async (_e, { sessionId } = {}) => {
  const s = findSession(sessionId);
  if (!s?.dir) return { ok: false };
  let speed = null;
  try {
    // Each session's update stream records model time per finished turn.
    speed = sessionSpeedFromUpdates(
      readLogTail(path.join(s.dir, "updates.jsonl"), 24_000_000),
    );
  } catch {
    speed = null;
  }
  try {
    const raw = JSON.parse(require("fs").readFileSync(require("path").join(s.dir, "signals.json"), "utf8"));
    const usage = contextUsageFromPayload(raw);
    if (usage) return { ok: true, ...usage, speed };
    return { ok: Boolean(speed?.calls), speed };
  } catch {
    return speed?.calls ? { ok: false, speed } : { ok: false };
  }
});

handleIpc("sessions:delete", async (_e, { sessionId }) => {
  disposeAgent(sessionId);
  // Local dir only. `grok sessions delete` spawns the CLI (~seconds) per row.
  return deleteSessionDir(sessionId);
});

handleIpc("sessions:rewind", async (_e, { sessionId } = {}) => {
  const sid = sessionId || activeSessionId;
  if (!sid) return { ok: false, error: "no session" };
  const s = findSession(sid);
  const cwd = s?.cwd && fs.existsSync(s.cwd) ? s.cwd : defaultCwd();
  try {
    getAgent(sid)?.cancel();
  } catch {
    /* ignore */
  }
  const entry = getAgentEntry(sid);
  if (entry) entry.busy = false;
  try {
    disposeAgent(sid);
  } catch {
    /* ignore */
  }
  const cut = rewindLastUserTurn(sid);
  if (!cut?.ok) return cut || { ok: false, error: "rewind failed" };
  try {
    const client = await ensureAgent(sid, cwd);
    await client.loadSession(sid);
    activeSessionId = sid;
    activeSessionMeta = s || findSession(sid);
    const e2 = getAgentEntry(sid);
    if (e2) e2.meta = activeSessionMeta;
    send("session:status", {
      state: "ready",
      detail: "已撤回",
      session: activeSessionMeta,
      sessionId: sid,
    });
    send("agents:update", { openIds: openAgentIds(), activeSessionId });
    return { ok: true, dropped: cut.dropped, reloaded: true, sessionId: sid };
  } catch (err) {
    log(`sessions:rewind reload ${err.message}`);
    return { ok: true, dropped: cut.dropped, reloaded: false, error: err.message, sessionId: sid };
  }
});

handleIpc("sessions:searchContent", async (_e, { query, limit } = {}) => {
  try {
    return await searchSessions(query, { limit: limit || 40 });
  } catch (err) {
    log(`sessions:searchContent ${err.message}`);
    return [];
  }
});

handleIpc("agents:list", async () => ({
  openIds: openAgentIds(),
  activeSessionId,
}));

handleIpc("agents:close", async (_e, { sessionId } = {}) => {
  if (sessionId) disposeAgent(sessionId);
  return { ok: true, openIds: openAgentIds() };
});

handleIpc("sessions:saveUi", async (_e, { sessionId, ui } = {}) => {
  try {
    const s = findSession(sessionId);
    if (!s?.dir) return { ok: false };
    saveSessionUi(s.dir, ui || {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handleIpc("sessions:saveGoal", async (_e, { sessionId, goal } = {}) => {
  try {
    const s = findSession(sessionId);
    if (!s?.dir) return { ok: false };
    if (!goal) {
      clearSessionGoal(s.dir);
      return { ok: true };
    }
    saveSessionGoal(s.dir, goal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handleIpc("sessions:history", async (_e, { sessionId }) => {
  try {
    const s = findSession(sessionId);
    if (!s) return { error: "not found", session: null, messages: [], assets: [] };
    // Async parse: a large updates.jsonl used to be read and JSON-parsed on the
    // main thread, freezing every other IPC (and the renderer's input) for
    // hundreds of milliseconds each time a big session was opened.
    const messages = await loadHistoryPreviewAsync(s.dir, { maxChars: 200000 });
    for (const message of messages) {
      if (message.role !== "tool") continue;
      const change = buildHistoryFileChange(message, s.cwd);
      if (change) {
        message.fileChange = change;
        // Tools can edit explicit files outside cwd (for example temp scripts).
        // Grant that exact saved file, never its containing directory.
        approveChangedFile(change.path);
      }
    }
    // Return image metadata only. The renderer fetches bytes when an image is
    // close to the viewport, keeping history IPC fast and memory bounded.
    const assets = [];
    const seenPaths = new Set();
    const pushImg = async (full, name) => {
      if (seenPaths.has(full)) return;
      if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) return;
      try {
        const st = await fs.promises.stat(full);
        if (!st.isFile() || st.size < 32 || st.size > 12_000_000) return;
        seenPaths.add(full);
        assets.push({
          name,
          path: full,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* skip */
      }
    };
    const scans = [];
    for (const sub of ["assets", "images"]) {
      const dir = path.join(s.dir, sub);
      let names = [];
      try {
        names = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.slice(0, 60)) {
        scans.push(pushImg(path.join(dir, name), name));
      }
    }
    await Promise.all(scans);
    assets.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
    let plan = loadSessionPlan(s.dir);
    let goal = loadSessionGoal(s.dir);
    if (goal?.completed) {
      clearSessionGoal(s.dir, { terminalGoal: goal });
      goal = null;
      plan = null;
    }
    const ui = loadSessionUi(s.dir);
    return { session: s, messages, assets, plan, goal, ui };
  } catch (err) {
    return { error: err.message, session: null, messages: [], assets: [], plan: null, goal: null };
  }
});

/**
 * Focus an already-live agent without reconnect noise.
 * soft: true → no "connecting" status (instant tab switch).
 */
handleIpc("session:activate", async (_e, { sessionId } = {}) => {
  if (!sessionId) return { ok: false, error: "no sessionId" };
  const live = getAgent(sessionId);
  if (!(live?.started && live.proc && live.sessionId === sessionId)) {
    return { ok: false, live: false };
  }
  let s = findSession(sessionId) || getAgentEntry(sessionId)?.meta || null;
  activeSessionId = sessionId;
  activeSessionMeta = s;
  touchAgent(sessionId);
  const models =
    extractModels(live.lastSessionMeta, live) ||
    extractModels({ models: live.lastModels }, live);
  send("agents:update", { openIds: openAgentIds(), activeSessionId });
  const commands = commandsForRenderer(live.availableCommands);
  return {
    ok: true,
    live: true,
    session: s,
    commands,
    models,
    openIds: openAgentIds(),
    currentModelId: live.currentModelId || models?.currentModelId || null,
  };
});

handleIpc("session:open", async (_e, { sessionId, soft } = {}) => {
  const gen = ++openGeneration;
  let settleOpen = () => {};
  const openGate = new Promise((resolve) => { settleOpen = resolve; });
  if (sessionId) openingAgents.set(sessionId, openGate);
  try {
  if (activeSessionId && activeSessionId !== sessionId) {
    const prev = getAgent(activeSessionId);
    if (!(prev?.started && prev.proc && prev.sessionId === activeSessionId)) {
      try { disposeAgent(activeSessionId); } catch { /* ignore */ }
    }
  }
  let s = findSession(sessionId);
  // retry once — summary may appear slightly after create
  if (!s) {
    await new Promise((r) => setTimeout(r, 250));
    s = findSession(sessionId);
  }
  if (!s) throw new Error("磁盘上找不到该会话（可点刷新后再试）");
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : defaultCwd();
  log(`open session ${sessionId} cwd=${cwd} soft=${!!soft}`);
  activeSessionId = sessionId;
  activeSessionMeta = s;

  // Fast path: agent already live — never emit "connecting" (kills product feel on tab switch)
  const live = getAgent(sessionId);
  if (live?.started && live.proc && live.sessionId === sessionId) {
    touchAgent(sessionId);
    const entry = getAgentEntry(sessionId);
    if (entry) entry.meta = s;
    // Always localize — soft tab switch uses this return payload for slash catalog
    const commands = commandsForRenderer(live.availableCommands);
    if (commands.length) {
      send("commands:update", {
        sessionId,
        commands,
      });
    }
    const models =
      extractModels(live.lastSessionMeta, live) ||
      extractModels({ models: live.lastModels }, live);
    if (models && !soft) send("session:models", { ...models, sessionId });
    // Only broadcast ready when not soft — soft switches stay silent
    if (!soft) {
      send("session:status", {
        state: "ready",
        detail: "已连接",
        session: s,
        sessionId,
      });
    }
    send("agents:update", { openIds: openAgentIds(), activeSessionId });
    return {
      ok: true,
      session: s,
      reused: true,
      commands,
      models,
      openIds: openAgentIds(),
    };
  }

  send("session:status", {
    state: "connecting",
    detail: "连接助手…",
    session: s,
    sessionId,
  });

  try {
    const client = await ensureAgent(sessionId, cwd);
    if (gen !== openGeneration) return { ok: false, cancelled: true };
    const loaded = await client.loadSession(sessionId);
    if (gen !== openGeneration) return { ok: false, cancelled: true };
    try { await restorePreferredModel(client, settings.readGrokConfigSummary().defaultModel); }
    catch (err) { log(`restore preferred model failed: ${err.message}`); }
    try { await client.setEffort("xhigh"); } catch { /* keep supported CLI effort */ }
    const entry = getAgentEntry(sessionId);
    if (entry) entry.meta = s;
    activeSessionId = sessionId;
    activeSessionMeta = s;
    const commands = commandsForRenderer(client.availableCommands);
    if (commands.length) {
      send("commands:update", {
        sessionId,
        commands,
      });
    }
    const models = extractModels(loaded, client) || extractModels(client.lastSessionMeta, client);
    if (models) send("session:models", { ...models, sessionId });
    send("session:status", {
      state: "ready",
      detail: "已恢复",
      session: s,
      sessionId,
    });
    send("agents:update", { openIds: openAgentIds(), activeSessionId });
    return {
      ok: true,
      session: s,
      commands,
      models,
      openIds: openAgentIds(),
    };
  } catch (err) {
    log(`session:open failed: ${err.message}`);
    // one reconnect retry
    try {
      disposeAgent(sessionId);
      const client = await ensureAgent(sessionId, cwd);
      if (gen !== openGeneration) return { ok: false, cancelled: true };
      await client.loadSession(sessionId);
      activeSessionMeta = s;
      activeSessionId = sessionId;
      send("session:status", {
        state: "ready",
        detail: "已恢复（重试）",
        session: s,
        sessionId,
      });
      send("agents:update", { openIds: openAgentIds(), activeSessionId });
      return { ok: true, session: s, retried: true, openIds: openAgentIds() };
    } catch (err2) {
      try { disposeAgent(sessionId); } catch { /* drop the half-open client */ }
      send("session:status", {
        state: "error",
        detail: err2.message,
        session: s,
        sessionId,
      });
      throw err2;
    }
  }
  } finally {
    settleOpen();
    if (sessionId && openingAgents.get(sessionId) === openGate) openingAgents.delete(sessionId);
  }
});

handleIpc("session:new", async (_e, { cwd } = {}) => {
  const workDir = cwd && fs.existsSync(cwd) ? cwd : defaultCwd();
  log(`new session cwd=${workDir}`);
  send("session:status", { state: "connecting", detail: "创建会话…" });
  try {
    evictLruAgents(null);
    const client = await createClient(workDir);
    const res = await client.newSession();
    const sid = res.sessionId;
    wireAcpEvents(client, sid);
    // Immediately index so it shows in the sidebar
    activeSessionMeta = ensureSessionSummary({
      id: sid,
      cwd: workDir,
      title: "新对话",
    });
    activeSessionId = sid;
    registerAgent(sid, client, workDir, activeSessionMeta);
    try { await restorePreferredModel(client, settings.readGrokConfigSummary().defaultModel); }
    catch (err) { log(`restore preferred model failed: ${err.message}`); }
    try { await client.setEffort("xhigh"); } catch { /* keep supported CLI effort */ }
    const models = extractModels(res, client);
    if (models) send("session:models", { ...models, sessionId: sid });
    send("session:status", {
      state: "ready",
      detail: "新对话",
      session: activeSessionMeta,
    });
    send("agents:update", { openIds: openAgentIds(), activeSessionId });
    return {
      ok: true,
      session: activeSessionMeta,
      models,
      openIds: openAgentIds(),
    };
  } catch (err) {
    send("session:status", { state: "error", detail: err.message });
    throw err;
  }
});

async function ensurePromptAgent(sessionId) {
  if (!sessionId) throw new Error("没有活动会话");
  let guard = 0;
  while (openingAgents.has(sessionId) && guard < 4) {
    guard += 1;
    const pending = openingAgents.get(sessionId);
    try { await pending; } catch { /* the open reports its own failure */ }
    if (openingAgents.get(sessionId) === pending) break;
  }
  let client = getAgent(sessionId);
  if (client?.suspended) client = await reviveAgent(sessionId);
  if (client?.started && client.proc && client.sessionId === sessionId) return client;
  const found = findSession(sessionId);
  if (!found) throw new Error("没有活动会话");
  const cwd = found.cwd && fs.existsSync(found.cwd) ? found.cwd : defaultCwd();
  client = await ensureAgent(sessionId, cwd);
  try {
    await client.loadSession(sessionId);
  } catch (err) {
    try { disposeAgent(sessionId); } catch { /* drop the half-open client */ }
    throw err;
  }
  const entry = getAgentEntry(sessionId);
  if (entry) entry.meta = found;
  if (!activeSessionId || activeSessionId === sessionId) {
    activeSessionId = sessionId;
    activeSessionMeta = found;
  }
  send("agents:update", { openIds: openAgentIds(), activeSessionId });
  return client;
}

/**
 * prompt: { text?: string, images?: [{ mimeType, dataBase64 }], sessionId?: string }
 */
handleIpc("session:prompt", async (_e, payload = {}) => {
  const sid = payload.sessionId || activeSessionId;
  let client = getAgent(sid);
  if (client?.suspended) client = await reviveAgent(sid);
  if (!client || !client.sessionId) client = await ensurePromptAgent(sid);
  const entry = getAgentEntry(sid);
  if (entry?.busy || client.isBusy()) {
    throw new Error("该会话仍在处理上一轮，请稍候或使用队列");
  }
  touchAgent(sid);
  const text = projectPromptText(payload.text || "", sid, (entry && entry.cwd) || client.cwd);
  const images = Array.isArray(payload.images) ? payload.images : [];
  const blocks = [];
  let omittedImages = 0;
  for (const img of images) {
    if (!img?.dataBase64) continue;
    const bytes = decodedB64Bytes(img.dataBase64);
    if (bytes > MAX_ACP_IMAGE_BYTES) {
      omittedImages += 1;
      log(`[prompt] omit oversized image ~${Math.round(bytes / 1024)}KB`);
      continue;
    }
    blocks.push({
      type: "image",
      mimeType: img.mimeType || "image/png",
      data: img.dataBase64,
    });
  }
  if (text) blocks.push({ type: "text", text });
  if (!blocks.length) {
    throw new Error(omittedImages ? "图片太大，CLI 吃不下。请换小图或只发文字。" : "消息为空");
  }

  const meta = entry?.meta || (sid === activeSessionId ? activeSessionMeta : null);
  if (entry) entry.busy = true;
  send("session:status", {
    state: "working",
    detail: "思考中…",
    session: meta,
    sessionId: sid,
  });
  try {
    const promptRes = await client.prompt(blocks);
    if (promptRes && client.maybeEmitUsage) client.maybeEmitUsage(promptRes);
    if (entry) entry.busy = false;
    send("session:status", {
      state: "ready",
      detail: "就绪",
      session: meta,
      sessionId: sid,
    });
    return { ok: true, sessionId: sid };
  } catch (err) {
    if (client.suspended || getAgent(sid) !== client) return { ok: true, sessionId: sid, cancelled: true };
    if (entry) entry.busy = false;
    if (!isDeadCliError(err)) {
      const wrapped = err instanceof Error
        ? err
        : new Error(err?.data?.message || err?.message || String(err));
      send("session:status", {
        state: "error",
        detail: wrapped.message,
        session: meta,
        sessionId: sid,
      });
      throw wrapped;
    }
    const hadStream = !!(client && client._promptHadStream);
    let fresh;
    try {
      fresh = await reviveAgent(sid);
    } catch (reviveErr) {
      const e = new Error(`CLI 进程退出且重连失败：${reviveErr.message || reviveErr}`);
      send("session:status", {
        state: "error",
        detail: e.message,
        session: meta,
        sessionId: sid,
      });
      throw e;
    }
    if (hadStream) {
      const e = new Error("CLI 进程意外退出。已自动重连，请再发一次。");
      send("session:status", {
        state: "ready",
        detail: "已重连",
        session: meta,
        sessionId: sid,
      });
      throw e;
    }
    const entry2 = getAgentEntry(sid);
    if (entry2) entry2.busy = true;
    try {
      const promptRes = await fresh.prompt(blocks);
      if (promptRes && fresh.maybeEmitUsage) fresh.maybeEmitUsage(promptRes);
      if (entry2) entry2.busy = false;
      send("session:status", {
        state: "ready",
        detail: "就绪",
        session: meta,
        sessionId: sid,
      });
      return { ok: true, sessionId: sid, retried: true };
    } catch (err2) {
      if (entry2) entry2.busy = false;
      const wrapped = err2 instanceof Error ? err2 : new Error(String(err2));
      send("session:status", {
        state: "error",
        detail: wrapped.message,
        session: meta,
        sessionId: sid,
      });
      throw wrapped;
    }
  }
});

handleIpc("session:cancel", async (_e, { sessionId } = {}) => {
  const sid = sessionId || activeSessionId;
  const entry = getAgentEntry(sid);
  getAgent(sid)?.suspend();
  // 停止后必须清 busy，否则插话/发送会被「仍在处理」卡住
  if (entry) entry.busy = false;
  const meta = entry?.meta || null;
  send("session:status", {
    state: "ready",
    detail: "已停止",
    session: meta,
    sessionId: sid,
  });
  return { ok: true, sessionId: sid };
});

// ── Dialogs / files ────────────────────────────────────

handleIpc("dialog:pickDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  return approveLocalPath(result.filePaths[0]);
});

handleIpc("dialog:pickFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  const out = [];
  for (const p of result.filePaths) {
    approveLocalPath(p);
    let preview = "";
    let size = 0;
    try {
      const st = fs.statSync(p);
      size = st.size;
      if (st.size < 200_000) {
        const buf = fs.readFileSync(p);
        // only text-ish
        const sample = buf.slice(0, 4000).toString("utf8");
        if (!sample.includes("\u0000")) preview = sample;
      }
    } catch {
      /* ignore */
    }
    out.push({
      path: p,
      name: path.basename(p),
      size,
      preview,
    });
  }
  return out;
});

handleIpc("file:describePaths", async (_e, paths) => {
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = typeof raw === "string" ? raw : "";
    if (!p) continue;
    try {
      const st = fs.statSync(p);
      approveLocalPath(p);
      const isDirectory = st.isDirectory();
      let preview = "";
      if (!isDirectory && st.size < 200_000) {
        const buf = fs.readFileSync(p);
        const sample = buf.slice(0, 4000).toString("utf8");
        if (!sample.includes("\u0000")) preview = sample;
      }
      out.push({
        path: p,
        name: path.basename(p),
        size: isDirectory ? 0 : st.size,
        preview,
        isDirectory,
        isImage: !isDirectory && /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(p),
      });
    } catch {
      // The path may disappear while dragging; ignore it rather than failing the drop.
    }
  }
  return out;
});

handleIpc("permission:respond", async (_e, { id, optionId, sessionId } = {}) => {
  // Prefer hinted session, then active, then any agent that has this request pending
  let client = getAgent(sessionId || activeSessionId);
  if (!client) {
    for (const e of agents.values()) {
      if (e.client.pendingPermissions?.has?.(id)) {
        client = e.client;
        break;
      }
    }
  }
  if (!client) return { ok: false };
  const ok = client.respondPermission(id, optionId);
  return { ok };
});

handleIpc("permission:setAutoApprove", async (_e, on) => {
  for (const e of agents.values()) {
    e.client.setAutoApprove(!!on);
  }
  try {
    settings.writeDesktopSettings({ autoApprove: !!on });
  } catch {
    /* ignore */
  }
  return { ok: true };
});

handleIpc("dialog:pickImages", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
  });
  if (result.canceled) return [];
  const out = [];
  for (const p of result.filePaths) {
    approveLocalPath(p);
    const dataUrl = pathToDataUrl(p);
    if (!dataUrl) continue;
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    out.push({
      path: p,
      name: path.basename(p),
      mimeType: m?.[1] || "image/png",
      dataBase64: m?.[2] || "",
      dataUrl,
    });
  }
  return out;
});

handleIpc("clipboard:readImage", async () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) return { ok: false };
    let mimeType = "image/png";
    let name = "paste.png";
    let buf = Buffer.from(img.toPNG());
    if (buf.length > MAX_ACP_IMAGE_BYTES) {
      try {
        buf = Buffer.from(img.toJPEG(78));
        mimeType = "image/jpeg";
        name = "paste.jpg";
      } catch {
        /* keep png */
      }
    }
    if (buf.length > MAX_ACP_IMAGE_BYTES) {
      return { ok: false, error: "图片太大，CLI 吃不下。请换小图或只发文字。" };
    }
    const dataBase64 = buf.toString("base64");
    return {
      ok: true,
      mimeType,
      dataBase64,
      dataUrl: `data:${mimeType};base64,${dataBase64}`,
      name,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handleIpc("file:readImage", async (_e, filePath, hints) => {
  // A clicked message image often sits outside the session folder.
  let full = normalizeAbsolutePath(filePath);
  if (!isSafeImagePath(full)) throw new Error("不支持的图片格式");
  let found = locateExistingPath(full, hints);
  if (!found) found = await locateDeep(full);
  if (!found || !isSafeImagePath(found)) throw new Error("本地路径不存在");
  full = found;
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    throw new Error("本地路径不存在");
  }
  if (!stat.isFile()) throw new Error("本地路径不存在");
  if (stat.size > 8 * 1024 * 1024) throw new Error("图片超过 8MB，请用默认程序打开");
  const dataUrl = pathToDataUrl(full);
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return {
    path: full,
    name: path.basename(full),
    mimeType: m?.[1] || "image/png",
    dataBase64: m?.[2] || "",
    dataUrl,
  };
});

function ambiguousFileError(hits) {
  const labels = hits.slice(0, 8).map((file) => `${path.basename(path.dirname(file))}\\${path.basename(file)}`);
  return new Error(`项目里有多份同名文件：${labels.join("、")}`);
}

handleIpc("file:preview", async (_e, p, hints) => {
  const resolved = await resolveClickedPath(p, hints, true);
  if (resolved.ambiguous) return { kind: "ambiguous", paths: resolved.ambiguous, path: p };
  const full = resolved.path;
  const real = await fs.promises.realpath(full);
  assertAllowedLocalPath(real, { permitExecutable: true, anyExisting: true });
  const preview = await readFilePreview(real);
  return { ...preview, path: real };
});

handleIpc("shell:openPath", async (_e, p, hints) => {
  const resolved = await resolveClickedPath(p, hints, false);
  if (resolved.ambiguous) throw ambiguousFileError(resolved.ambiguous);
  return shell.openPath(resolved.path);
});

handleIpc("shell:showItem", async (_e, p, hints) => {
  const resolved = await resolveClickedPath(p, hints, true);
  if (resolved.ambiguous) throw ambiguousFileError(resolved.ambiguous);
  shell.showItemInFolder(resolved.path);
  return { ok: true };
});

function workspaceCliCwd() {
  const fromActive = activeSessionMeta?.cwd || findSession(activeSessionId)?.cwd;
  if (fromActive && fs.existsSync(fromActive)) return fromActive;
  const live = getAgentEntry(activeSessionId);
  if (live?.cwd && fs.existsSync(live.cwd)) return live.cwd;
  if (live?.client?.cwd && fs.existsSync(live.client.cwd)) return live.client.cwd;
  return process.cwd();
}

function workspaceCliEnv() {
  const desk = settings.readDesktopSettings();
  const raw = desk.proxyUrl || "";
  const enabled = desk.proxyEnabled === true;
  const url = typeof settings.normalizeProxyUrl === "function"
    ? settings.normalizeProxyUrl(raw)
    : String(raw || "").trim();
  const on = enabled && !!url;
  const env = { ...process.env };
  const keys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
  for (const k of keys) delete env[k];
  if (on) {
    env.HTTP_PROXY = url;
    env.HTTPS_PROXY = url;
    env.http_proxy = url;
    env.https_proxy = url;
  }
  return { env, proxyOn: on };
}

handleIpc("shell:openWorkspaceCli", async () => {
  const cwd = workspaceCliCwd();
  const { env, proxyOn } = workspaceCliEnv();
  if (process.platform === "win32") {
    const hint = proxyOn
      ? "echo GitHub CLI 已带 HTTP/HTTPS 代理 && gh --version"
      : "echo GitHub CLI（未配置代理） && gh --version";
    spawn("cmd.exe", ["/c", "start", "GitHub CLI", "cmd.exe", "/k", hint], {
      cwd,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
    return { ok: true, cwd, proxyOn };
  }
  if (process.platform === "darwin") {
    spawn("open", ["-a", "Terminal", cwd], { env, detached: true, stdio: "ignore" }).unref();
    return { ok: true, cwd, proxyOn };
  }
  const term = process.env.TERMINAL || "x-terminal-emulator";
  spawn(term, [], { cwd, env, detached: true, stdio: "ignore" }).unref();
  return { ok: true, cwd, proxyOn };
});

// ── Settings / models ──────────────────────────────────


function anyLiveAgent() {
  const active = getAgent(activeSessionId);
  if (active) return active;
  for (const e of agents.values()) {
    if (e?.client) return e.client;
  }
  return null;
}




function readUnifiedLog(maxBytes = 2_000_000) {
  return readLogTail(path.join(grokHome(), "logs", "unified.jsonl"), maxBytes);
}

/**
 * One read of the unified log, reused by every consumer in a single request.
 *
 * `account:usage` used to re-read and re-parse the same multi-megabyte tail
 * three times per call (daily history, week window, speed), and it is called
 * after every turn plus on a timer. Reading once keeps a usage refresh cheap
 * enough that it never competes with the turn it reports on.
 */
const LOG_SCAN_BYTES = 12_000_000;
let logScanCache = { key: "", text: "" };

function unifiedLogSnapshot() {
  let stamp = "";
  try {
    const st = fs.statSync(path.join(grokHome(), "logs", "unified.jsonl"));
    // Size + mtime identify the exact tail, so repeated calls in one turn reuse
    // the read while a newly appended line forces a fresh one.
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch {
    stamp = "";
  }
  if (stamp && logScanCache.key === stamp && logScanCache.text) return logScanCache.text;
  const text = readUnifiedLog(LOG_SCAN_BYTES);
  logScanCache = { key: stamp, text };
  return text;
}



















const lastUsageTurn = new Map();

function noteDailyFromUsage(usage, sessionId) {
  const family = modelFamilyOf(usage?.modelId || usage?.model || getAgent(sessionId)?.currentModelId || "");
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  const reasoning = Number(usage?.reasoningTokens) || 0;
  const cache = Number(usage?.cacheReadTokens) || 0;
  const n = input + output + reasoning;
  if (n <= 0 && cache <= 0) return;
  const key = sessionId || "_";
  const prev = lastUsageTurn.get(key);
  if (prev?.family === family && Date.now() - prev.t < 10000 && prev.n === n && prev.cache === cache) return;
  let dIn = input;
  let dOut = output;
  let dRea = reasoning;
  let dCache = cache;
  if (prev?.family === family && Date.now() - prev.t < 120000 && n >= prev.n && input >= (prev.input || 0)) {
    dIn = Math.max(0, input - (prev.input || 0));
    dOut = Math.max(0, output - (prev.output || 0));
    dRea = Math.max(0, reasoning - (prev.reasoning || 0));
    dCache = Math.max(0, cache - (prev.cache || 0));
  }
  lastUsageTurn.set(key, { n, input, output, reasoning, cache, family, t: Date.now() });
  if (dIn + dOut + dRea + dCache <= 0) return;
  try {
    const today = shanghaiDate();
    const desk = settings.readDesktopSettings();
    const cur = desk.dailyUsage?.date === today ? { ...emptyDaily(), ...desk.dailyUsage } : emptyDaily();
    const parts = { total: dIn + dOut + dRea, input: dIn, output: dOut, reasoning: dRea, cache: dCache };
    addTokenParts(cur, parts);
    addByModel(cur, family, parts);
    const history = { ...(desk.dailyHistory || {}) };
    history[today] = mergeDayMax(history[today], cur);
    const weekStart = weekStartDate(desk.lastBilling);
    const weekKey = weekStart ? weekStart.toISOString() : "";
    const wcur = desk.weekUsage?.from === weekKey && weekKey
      ? { ...emptyDaily(), ...desk.weekUsage }
      : emptyDaily();
    if (!weekStart || Date.now() >= weekStart.getTime()) {
      addTokenParts(wcur, parts);
      addByModel(wcur, family, parts);
    }
    settings.writeDesktopSettings({
      dailyUsage: {
        date: today,
        tokens: cur.tokens,
        input: cur.input,
        output: cur.output,
        reasoning: cur.reasoning,
        cache: cur.cache,
        byModel: cur.byModel || {},
      },
      dailyHistory: pruneHistory(history),
      weekUsage: {
        from: weekKey,
        tokens: wcur.tokens,
        input: wcur.input,
        output: wcur.output,
        reasoning: wcur.reasoning,
        cache: wcur.cache,
        byModel: wcur.byModel || {},
      },
    });
  } catch {
    /* ignore */
  }
}

handleIpc("account:usage", async (_e, extra = {}) => {
  const _t = Date.now();
  try {
    const desk = settings.readDesktopSettings();
    applyProxyEnv(desk.proxyUrl, desk.proxyEnabled !== false);
    const today = shanghaiDate();
    const stored = desk.dailyUsage?.date === today ? desk.dailyUsage : emptyDaily();
    let daily = {
      tokens: Number(stored.tokens) || 0,
      input: Number(stored.input) || 0,
      output: Number(stored.output) || 0,
      reasoning: Number(stored.reasoning) || 0,
      cache: Number(stored.cache) || 0,
      byModel: stored.byModel && typeof stored.byModel === "object" ? stored.byModel : {},
    };
    const add = Number(extra?.addTokens) || 0;
    if (add > 0) daily.tokens += add;

    let billing = null;
    let source = "cache";
    const client = anyLiveAgent();
    if (client?.getBilling) {
      try {
        const raw = await Promise.race([
          client.getBilling(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("billing timeout")), 4000)),
        ]);
        billing = parseBillingPayload(raw);
        if (billing) source = "acp";
      } catch (err) {
        log(`[perf] account:usage acp fail ${err.message || err}`);
      }
    }
    const logText = unifiedLogSnapshot();
    if (!billing) {
      billing = billingFromLog(logText);
      if (billing) source = "log";
    }
    if (!billing && desk.lastBilling) {
      billing = desk.lastBilling;
      source = "cache";
    }
    const logDays = dailyHistoryFromLog(logText);
    const logDaily = logDays[today] || emptyDaily();
    if ((logDaily.tokens || 0) > daily.tokens) {
      daily = {
        ...emptyDaily(),
        ...logDaily,
        byModel: mergeByModelMax(logDaily.byModel, daily.byModel),
      };
    } else {
      if ((logDaily.input || 0) > daily.input) daily.input = logDaily.input;
      if ((logDaily.output || 0) > daily.output) daily.output = logDaily.output;
      if ((logDaily.cache || 0) > daily.cache) daily.cache = logDaily.cache;
      if ((logDaily.reasoning || 0) > daily.reasoning) daily.reasoning = logDaily.reasoning;
      daily.byModel = mergeByModelMax(daily.byModel, logDaily.byModel);
    }
    const history = { ...(desk.dailyHistory || {}) };
    for (const [d, slot] of Object.entries(logDays)) {
      history[d] = mergeDayMax(history[d], slot);
    }
    history[today] = mergeDayMax(history[today], daily);
    const pruned = pruneHistory(history);

    const weekStart = weekStartDate(billing);
    let weekFrom = weekStart ? shanghaiDate(weekStart) : "";
    if (!weekFrom) {
      const [yy, mm, dd] = today.split("-").map(Number);
      const base = new Date(Date.UTC(yy, mm - 1, dd));
      base.setUTCDate(base.getUTCDate() - 6);
      weekFrom = base.toISOString().slice(0, 10);
    }
    const logWeek = weekStart ? usageSinceFromLog(logText, weekStart.getTime()) : emptyDaily();
    const weekKey = weekStart ? weekStart.toISOString() : "";
    // An undated cache cannot be tied to the rolling fallback range.
    const storedWeek = weekKey && desk.weekUsage?.from === weekKey ? desk.weekUsage : null;
    let week = mergeUsageSnapshots(logWeek, storedWeek);
    if (week.tokens <= 0 && week.cache <= 0) {
      const historyWeek = emptyDaily();
      for (const [d, slot] of Object.entries(pruned)) {
        if (weekStart && d <= weekFrom) continue;
        if (d < weekFrom || d > today) continue;
        historyWeek.tokens += Number(slot.tokens) || 0;
        historyWeek.input += Number(slot.input) || 0;
        historyWeek.output += Number(slot.output) || 0;
        historyWeek.reasoning += Number(slot.reasoning) || 0;
        historyWeek.cache += Number(slot.cache) || 0;
        for (const [model, parts] of Object.entries(slot.byModel || {})) {
          addByModel(historyWeek, modelFamilyOf(model), { ...parts, total: parts.tokens });
        }
      }
      week = mergeUsageSnapshots(historyWeek, null);
    }

    // Speed is measured over the same log text as the totals above, so the
    // header average describes the conversations whose tokens it counts.
    let speed = emptySpeed();
    try {
      speed = speedStatsFromLog(logText);
    } catch {
      /* a missing or truncated log only means no average to show */
    }

    // One atomic write per refresh: the daily/weekly snapshots and the billing
    // stamp always describe the same read of the log.
    try {
      settings.writeDesktopSettings({
        ...(billing ? { lastBilling: { ...billing, fetchedAt: Date.now() } } : {}),
        dailyUsage: { date: today, ...daily },
        dailyHistory: pruned,
        weekUsage: {
          from: weekKey,
          tokens: week.tokens,
          input: week.input,
          output: week.output,
          reasoning: week.reasoning,
          cache: week.cache,
          byModel: week.byModel || {},
        },
      });
    } catch { /* ignore */ }

    const result = {
      ok: !!(billing || daily.tokens || week.tokens),
      percent: billing?.percent ?? null,
      reset: billing?.reset || "",
      resetAt: billing?.resetAt || "",
      weekTokens: week.tokens,
      weekInput: week.input,
      weekOutput: week.output,
      weekCache: week.cache,
      weekReasoning: week.reasoning,
      weekByModel: week.byModel || {},
      dailyTokens: daily.tokens,
      dailyInput: daily.input,
      dailyOutput: daily.output,
      dailyCache: daily.cache,
      dailyReasoning: daily.reasoning,
      dailyByModel: daily.byModel || {},
      history: pruned,
      speed,
      turn: add || lastUsageTurn.get(activeSessionId)?.n || null,
      subscriptionTier: billing?.subscriptionTier || "",
      raw: billing?.raw || "",
      source,
    };
    perf(`account:usage source=${source} percent=${result.percent} daily=${daily.tokens}`, _t);
    return result;
  } catch (err) {
    perf("account:usage fail", _t);
    return { ok: false, error: err.message || String(err) };
  }
});

handleIpc("settings:get", async (_e, { cachedModels = false } = {}) => {
  const _t = Date.now();
  const all = settings.getAllSettings();
  perf("settings:get disk", _t);
  const tModels = Date.now();
  const models = cachedModels ? settings.cachedModels() : await settings.listModels();
  perf(cachedModels ? "settings:get cached models" : "settings:get grok models", tModels);
  perf("settings:get total", _t);
  let systemLocale = null;
  try {
    systemLocale = app.getLocale?.() || null;
  } catch {
    systemLocale = null;
  }
  return { ...all, models, systemLocale };
});

function readAccountProfile() {
  const home = grokHome();
  const authPath = path.join(home, "auth.json");
  let loggedIn = false;
  let email = "";
  let name = "";
  let userId = "";
  try {
    if (fs.existsSync(authPath) && fs.statSync(authPath).size > 20) {
      loggedIn = true;
      const raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const walk = (obj, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 5) return;
        for (const [k, v] of Object.entries(obj)) {
          const lk = String(k).toLowerCase();
          if (/(token|secret|password|refresh|access|id_token|jwt|api[_-]?key)/i.test(lk)) continue;
          if (typeof v === "string") {
            const s = v.trim();
            if (!s || s.length > 120) continue;
            if (!email && /email/.test(lk) && s.includes("@")) email = s;
            if (!name && /^(name|display_name|displayname|username|user_name|preferred_username)$/i.test(k)) name = s;
            if (!userId && /^(user_id|userid|sub)$/i.test(k)) userId = s;
          } else if (v && typeof v === "object") walk(v, depth + 1);
        }
      };
      walk(raw);
    }
  } catch {
    /* ignore */
  }
  const desk = settings.readDesktopSettings();
  const billing = desk.lastBilling || {};
  return {
    loggedIn,
    email,
    name,
    userId,
    subscriptionTier: billing.subscriptionTier || billing.tier || "",
    reset: billing.reset || billing.resetAt || "",
  };
}

handleIpc("account:profile", async () => {
  try {
    return { ok: true, ...readAccountProfile() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handleIpc("profile:setAvatar", async (_e, { dataBase64, mimeType } = {}) => {
  if (!dataBase64) throw new Error("empty avatar");
  const ext = /jpe?g/i.test(mimeType || "") ? ".jpg" : /webp/i.test(mimeType || "") ? ".webp" : ".png";
  const dest = path.join(appConfigDir(), "profile-avatar" + ext);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  atomicWriteFileSync(dest, Buffer.from(dataBase64, "base64"), undefined);
  return settings.writeDesktopSettings({ profileAvatar: dest });
});

handleIpc("profile:clearAvatar", async () => {
  const cur = settings.readDesktopSettings().profileAvatar;
  if (cur) {
    try { fs.unlinkSync(cur); } catch { /* ignore */ }
  }
  return settings.writeDesktopSettings({ profileAvatar: "" });
});

handleIpc("settings:saveDesktop", async (_e, partial) => {
  const next = settings.writeDesktopSettings(partial || {});
  // Keep OS + chrome in sync when desktop prefs change
  if (
    partial &&
    ("openAtLogin" in partial ||
      "locale" in partial ||
      "closeToTray" in partial ||
      "minimizeToTray" in partial || "theme" in partial || "proxyUrl" in partial || "proxyEnabled" in partial ||
      "appIcon" in partial)
  ) {
    if ("proxyUrl" in partial || "proxyEnabled" in partial) {
      applyProxyEnv(next.proxyUrl, next.proxyEnabled !== false);
      disposeAllAgents();
    }
    if ("theme" in partial) {
      try {
        const t = next.theme;
        nativeTheme.themeSource = t === "light" || t === "dark" || t === "system" ? t : "system";
        if (mainWindow && !mainWindow.isDestroyed()) {
          const light = nativeTheme.themeSource === "light" || (nativeTheme.themeSource === "system" && !nativeTheme.shouldUseDarkColors);
          mainWindow.setBackgroundColor(light ? "#f5f5f7" : "#0b0b0c");
        }
      } catch {
        /* ignore */
      }
    }
    if ("appIcon" in partial) applyAppIcon();
    if ("openAtLogin" in partial) syncLoginItemFromSettings(next);
    if ("locale" in partial) {
      installAppMenu();
      refreshTrayMenu();
    } else {
      refreshTrayMenu();
    }
  }
  return next;
});

/** 内置壁纸绝对路径（打包后在 app 目录 assets/wallpapers） */
handleIpc("wallpaper:list", async () => {
  const dir = path.join(__dirname, "assets", "wallpapers");
  const presets = [
    { id: "xmark", name: "X 标志", file: "wp-x-mark.jpg" },
    { id: "rocket", name: "火箭", file: "wp-rocket.jpg" },
    { id: "orbit", name: "轨道", file: "wp-orbit.jpg" },
    { id: "space", name: "SPACE", file: "wp-space-type.jpg" },
    { id: "stack", name: "多级箭体", file: "wp-stack.jpg" },
  ];
  return presets.map((p) => {
    const full = path.join(dir, p.file);
    const thumb = path.join(dir, p.file.replace(/\.jpg$/i, "-thumb.jpg"));
    return {
      id: p.id,
      name: p.name,
      path: fs.existsSync(full) ? full : null,
      thumbPath: fs.existsSync(thumb) ? thumb : fs.existsSync(full) ? full : null,
    };
  });
});

handleIpc("settings:saveGrok", async (_e, partial) => {
  return settings.updateGrokConfig(partial || {});
});

// ── Plugins ────────────────────────────────────────────

handleIpc("plugins:listInstalled", async () => plugins.listInstalled());
handleIpc("plugins:listAvailable", async () => {
  const r = await plugins.listAvailable();
  return Array.isArray(r) ? r : r;
});
handleIpc("plugins:install", async (_e, spec) => plugins.installPlugin(normalizePluginInstallSpec(spec)));
handleIpc("plugins:uninstall", async (_e, name) => plugins.uninstallPlugin(name));
handleIpc("plugins:enable", async (_e, name) => plugins.enablePlugin(name));
handleIpc("plugins:disable", async (_e, name) => plugins.disablePlugin(name));
handleIpc("plugins:details", async (_e, name) => plugins.pluginDetails(name));

// ── Skills ─────────────────────────────────────────────

handleIpc("skills:list", async (_e, opts) => skills.listSkills(opts?.cwd));
handleIpc("skills:read", async (_e, name) => skills.readSkill(name));
handleIpc("skills:create", async (_e, payload) => skills.createSkill(payload || {}));
handleIpc("skills:write", async (_e, { name, markdown }) => skills.writeSkill(name, markdown));
handleIpc("skills:open", async (_e, skillPath) => {
  const roots = skills.skillRoots().map((entry) => entry.dir);
  for (const skill of skills.listSkills()) if (skill?.path) roots.push(skill.path);
  const full = assertPathInside(skillPath, roots);
  return shell.openPath(full);
});

// ── Memory ─────────────────────────────────────────────

handleIpc("memory:list", async () => memory.listMemoryFiles());
// UI always lists all entries (so you can manage experience even when the switch is off).
// Agent retrieval uses memory:agentContext, which respects experienceMemory.
handleIpc("memory:listEntries", async (_e, opts) =>
  memory.listEntries({ ...(opts || {}), includeExperience: true }),
);
handleIpc("memory:getEntry", async (_e, id) => memory.getEntry(id));
handleIpc("memory:upsertEntry", async (_e, payload) => memory.upsertEntry(payload || {}));
handleIpc("memory:deleteEntry", async (_e, id) => memory.deleteEntry(id));
handleIpc("memory:read", async (_e, filePath) => memory.readMemoryFile(filePath));
handleIpc("memory:write", async (_e, { path: filePath, content }) =>
  memory.writeMemoryFile(filePath, content),
);
handleIpc("memory:append", async (_e, payload) => memory.appendNote(payload || {}));
handleIpc("memory:setEnabled", async (_e, enabled) => memory.setEnabled(!!enabled));
handleIpc("memory:clear", async () => memory.clearMemory());
handleIpc("memory:agentContext", async (_e, opts) => {
  const desk = settings.readDesktopSettings();
  return memory.listEntriesForAgent({
    experienceEnabled: desk.experienceMemory !== false,
    type: opts?.type,
    category: opts?.category,
  });
});

handleIpc("commands:list", async (_e, { sessionId } = {}) => {
  const client = getAgent(sessionId || activeSessionId);
  return { commands: commandsForRenderer(client?.availableCommands) };
});

/**
 * Copy a session transcript to the system clipboard as Markdown.
 *
 * `grok export` already renders the canonical Markdown, so this spawns it once
 * with no output path (stdout) and puts that text on the clipboard. Using the
 * CLI instead of a renderer-side formatter keeps the copied transcript
 * identical to the one `grok export` writes to a file.
 */
handleIpc("session:copyMarkdown", async (_e, { sessionId } = {}) => {
  const id = sessionId || activeSessionMeta?.id || activeSessionId || activeAgent()?.sessionId;
  if (!id) throw new Error("没有可复制的会话");
  const text = await new Promise((resolve, reject) => {
    const child = spawnCli(resolveGrokCli(), ["export", id], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (d) => {
      // Keep it bounded: a runaway export must not exhaust memory unnoticed.
      if (size < 32_000_000) {
        chunks.push(d);
        size += d.length;
      }
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(new Error(err.trim() || `export exit ${code}`)),
    );
    child.on("error", reject);
  });
  if (!text.trim()) return { ok: false, error: "这个会话还没有可复制的内容" };
  clipboard.writeText(text);
  return { ok: true, sessionId: id, chars: text.length };
});

handleIpc("session:export", async (_e, { sessionId } = {}) => {
  const id = sessionId || activeSessionMeta?.id || activeSessionId || activeAgent()?.sessionId;
  if (!id) throw new Error("没有可导出的会话");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "导出会话",
    defaultPath: `grok-session-${id.slice(0, 8)}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  await new Promise((resolve, reject) => {
    const child = spawnCli(resolveGrokCli(), ["export", id, result.filePath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim() || `export exit ${code}`)),
    );
    child.on("error", reject);
  });
  return { ok: true, path: result.filePath };
});

handleIpc("session:run-slash", async (_e, { command, args, sessionId } = {}) => {
  const sid = sessionId || activeSessionId;
  let client = getAgent(sid);
  if (client?.suspended) client = await reviveAgent(sid);
  if (!client || !client.sessionId) throw new Error("请先打开会话");
  const cmd = String(command || "").replace(/^\//, "");
  if (!cmd) throw new Error("空命令");
  const local = new Set([
    "usage", "usages", "cost", "context", "session-info", "info", "help", "docs", "status",
    "effort", "model", "always-approve", "auto",
  ]);
  const key = cmd.toLowerCase();
  if (local.has(key)) {
    if (key === "effort" && args) {
      try { await client.setEffort(String(args).trim()); } catch { /* local chip still updates */ }
    }
    return { ok: true, handled: "desktop", command: key === "usages" ? "usage" : key, args: args || "" };
  }
  const text = args ? `/${cmd} ${args}` : `/${cmd}`;
  const meta = getAgentEntry(sid)?.meta || activeSessionMeta;
  const goalControl =
    key === "goal" && /^(?:status|resume|clear)?$/i.test(String(args || "").trim());
  const stopGoal = key === "goal" && /^(?:clear|pause)$/i.test(String(args || "").trim());
  if (client.isBusy() && !stopGoal && !(goalControl && /^(?:status)?$/i.test(String(args || "").trim()))) {
    throw new Error("该会话仍在处理上一轮，请稍候或使用队列");
  }
  if (stopGoal) client.cancel();
  let goalReply = "";
  const captureGoalReply = (chunk) => {
    goalReply = (goalReply + String(chunk || "")).slice(-8192);
  };
  if (goalControl) client.on("messageChunk", captureGoalReply);
  send("session:status", {
    state: "working",
    detail: `/${cmd}…`,
    session: meta,
    sessionId: sid,
  });
  try {
    await client.prompt(text);
    if (goalControl && isGoalAbsentReply(goalReply)) {
      const terminalGoal = normalizeGoalState({
        status: "cleared",
        completed: true,
        lastEvent: "goal_cleared",
        savedAt: Date.now(),
      });
      const session = findSession(sid);
      if (session?.dir) clearSessionGoal(session.dir, { terminalGoal });
      send("session:goal", { ...terminalGoal, sessionId: sid });
    }
    if (stopGoal) client.suspend();
    send("session:status", {
      state: "ready",
      detail: "就绪",
      session: meta,
      sessionId: sid,
    });
    return { ok: true };
  } catch (err) {
    if (client.suspended || getAgent(sid) !== client) return { ok: true, cancelled: true };
    if (stopGoal) client.suspend();
    send("session:status", {
      state: "error",
      detail: err.message,
      session: meta,
      sessionId: sid,
    });
    throw err;
  } finally {
    if (stopGoal && !client.suspended) client.suspend();
    if (goalControl) client.off("messageChunk", captureGoalReply);
  }
});

handleIpc("mcp:list", async () => mcp.listMcp());
handleIpc("mcp:remove", async (_e, name) => mcp.removeMcp(name));
handleIpc("mcp:doctor", async () => mcp.doctorMcp());
handleIpc("hooks:list", async (_e, { cwd } = {}) => {
  const sessionCwd =
    cwd ||
    activeSessionMeta?.cwd ||
    findSession(activeSessionId)?.cwd ||
    null;
  return hooks.listHooks({ cwd: sessionCwd });
});
handleIpc("mcp:add", async (_e, { name, command, args }) =>
  mcp.addMcp(name, command, args || []),
);

function withCacheMeta(m) {
  const id = m.modelId || m.id;
  const meta = typeof settings.attachCacheMeta === "function"
    ? settings.attachCacheMeta(id, m._meta || null)
    : (m._meta || null);
  return {
    modelId: id,
    name: m.name || m.modelId || m.id,
    description: m.description || "",
    _meta: meta,
  };
}

function extractModels(payload, client) {
  if (!payload) return null;
  const models = payload.models || payload;
  const available = models.availableModels || models.available || [];
  if (!available.length && !models.currentModelId) return null;
  return {
    currentModelId:
      client?.currentModelId || models.currentModelId || null,
    availableModels: available.map(withCacheMeta),
  };
}

handleIpc("models:list", async (_e, { sessionId } = {}) => {
  const client = getAgent(sessionId || activeSessionId);
  // Prefer live session models; fall back to `grok models`
  if (client?.sessionId) {
    const live = client.lastModels?.availableModels;

    if (live?.length) {
      return {
        currentModelId:
          client.currentModelId || client.lastModels?.currentModelId || null,
        availableModels: live.map(withCacheMeta),
      };
    }
    const fromCli = await settings.listModels();
    return {
      currentModelId: client.currentModelId || fromCli.defaultModel,
      availableModels: fromCli.models.map((m) => withCacheMeta({ id: m.id, name: m.id, description: "" })),
    };
  }
  const fromCli = await settings.listModels();
  return {
    currentModelId: fromCli.defaultModel,
    availableModels: fromCli.models.map((m) => withCacheMeta({ id: m.id, name: m.id, description: "" })),
  };
});

handleIpc("session:set-effort", async (_e, { effort, sessionId } = {}) => {
  const client = getAgent(sessionId || activeSessionId);
  if (!client || !client.sessionId) throw new Error("请先打开一个会话");
  const res = await client.setEffort(effort);
  return { ok: true, effort, result: res };
});

handleIpc("models:set", async (_e, modelId, sessionId) => {
  // support both (modelId) and ({ modelId, sessionId })
  let mid = modelId;
  let sid = sessionId;
  if (modelId && typeof modelId === "object") {
    mid = modelId.modelId;
    sid = modelId.sessionId;
  }
  const client = getAgent(sid || activeSessionId);
  if (!client || !client.sessionId) throw new Error("请先打开一个会话");
  if (!mid) throw new Error("缺少 modelId");
  const res = await client.setModel(mid);
  // persist default for next sessions
  try {
    settings.updateGrokConfig({ defaultModel: mid });
  } catch (err) {
    throw new Error(`模型已切换，但默认模型保存失败：${err.message}`, { cause: err });
  }
  send("session:model", { modelId: mid, sessionId: client.sessionId });
  return { ok: true, modelId: mid, result: res };
});

handleIpc("app:info", async () => ({
  grokHome: grokHome(),
  grokCli: resolveGrokCli(),
  version: app.getVersion(),
  desktopVersion: DESKTOP_VERSION,
  memoryEnabled: memory.isEnabledInConfig(),
  openAgents: agents.size,
  platform: process.platform,
  closeToTray: closeToTrayEnabled(),
  openAtLogin: !!settings.readDesktopSettings().openAtLogin,
}));

/** Whether the main window is unfocused / hidden (for completion notify) */
handleIpc("app:isOccluded", async () => isWindowOccluded());

/** Taskbar / tray busy indicator from renderer */
handleIpc("app:setBusyCount", async (_e, count) => {
  const n = Math.max(0, Number(count) || 0);
  updateTrayStatus(n);
  setTaskbarWorking(n > 0);
  return { ok: true, count: n };
});

/** Flash taskbar when work finishes in background */
handleIpc("app:flashFrame", async (_e, on = true) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  try {
    if (on) flashTaskbarIfNeeded();
    else mainWindow.flashFrame(false);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

function buildDiagnosticReport() {
  let sessionCount = null;
  try {
    sessionCount = listSessions({ limit: 500 }).length;
  } catch {
    sessionCount = null;
  }
  const desktop = settings.readDesktopSettings();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    privacy: {
      messageBodiesIncluded: false,
      credentialsIncluded: false,
      localPathsIncluded: false,
    },
    app: {
      version: DESKTOP_VERSION,
      electron: process.versions.electron || null,
      chrome: process.versions.chrome || null,
      node: process.versions.node || null,
      sandbox: true,
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      locale: app.getLocale?.() || null,
    },
    runtime: {
      openAgents: agents.size,
      busyAgents: [...agents.values()].filter((entry) => entry?.busy).length,
      sessionCount,
      windowVisible: !!mainWindow?.isVisible?.(),
      windowFocused: !!mainWindow?.isFocused?.(),
    },
    settings: {
      theme: desktop.theme,
      density: desktop.density,
      locale: desktop.locale,
      accessMode: desktop.accessMode,
      showThinking: desktop.showThinking !== false,
      closeToTray: desktop.closeToTray !== false,
      minimizeToTray: desktop.minimizeToTray === true,
      proxyEnabled: desktop.proxyEnabled === true,
      checkUpdates: desktop.checkUpdates !== false,
    },
    events: diagnosticRing.snapshot(),
  };
}

handleIpc("app:exportDiagnostics", async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const result = await dialog.showSaveDialog(mainWindow, {
    title: L("Export diagnostics", "导出诊断包"),
    defaultPath: `grok-desktop-diagnostics-${stamp}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  atomicWriteFileSync(result.filePath, `${JSON.stringify(buildDiagnosticReport(), null, 2)}\n`, "utf8");
  approveLocalPath(result.filePath);
  diagnosticRing.record("diagnostics:exported", { ok: true });
  return { ok: true, path: result.filePath };
});

/** 环境诊断：CLI 是否存在、是否像已登录 */
handleIpc("app:diagnose", async () => {
  const cli = resolveGrokCli();
  const cliExists = commandExists(cli);
  const home = grokHome();
  const authPath = path.join(home, "auth.json");
  let loggedIn = false;
  let authHint = "未找到登录凭据";
  try {
    if (fs.existsSync(authPath)) {
      const st = fs.statSync(authPath);
      if (st.size > 20) {
        loggedIn = true;
        authHint = "已检测到登录凭据";
      }
    }
  } catch {
    authHint = "无法读取登录状态";
  }
  let cliVersion = null;
  if (cliExists) {
    try {
      cliVersion = await new Promise((resolve) => {
        const child = spawnCli(cli, ["--version"], {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout?.on("data", (d) => {
          out += d.toString();
        });
        child.stderr?.on("data", (d) => {
          out += d.toString();
        });
        const t = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          resolve(out.trim() || null);
        }, 4000);
        child.on("close", () => {
          clearTimeout(t);
          resolve((out || "").trim().split("\n")[0] || null);
        });
      });
    } catch {
      cliVersion = null;
    }
  }
  return {
    ok: cliExists && loggedIn,
    cli,
    cliExists,
    cliVersion,
    grokHome: home,
    authPath,
    loggedIn,
    authHint,
    desktopVersion: DESKTOP_VERSION,
    installHint: cliExists
      ? null
      : "请先安装官方 Grok CLI：curl -fsSL https://x.ai/cli/install.sh | bash",
    loginHint: loggedIn ? null : "在终端执行：grok login  （或 grok login --oauth）",
  };
});

/** 打开外部链接 / 路径 */
handleIpc("shell:openExternal", async (_e, url) => {
  const opened = await openExternalUrl(url);
  return { ok: true, url: opened };
});

/** 系统通知（后台会话完成等） */
handleIpc("app:notify", async (_e, { title, body, sessionId } = {}) => {
  try {
    if (!Notification.isSupported()) return { ok: false, reason: "unsupported" };
    const iconPath = resolveAppIconPath();
    const n = new Notification({
      title: title || "Grok Desktop",
      body: body || "",
      silent: false,
      icon: iconPath || undefined,
    });
    n.on("click", () => {
      showMainWindow(sessionId ? { sessionId } : {});
    });
    n.show();
    flashTaskbarIfNeeded();
    if (tray) {
      try {
        tray.setToolTip(`${title || "Grok Desktop"}${body ? ` — ${body}` : ""}`);
        setTimeout(() => updateTrayStatus(), 8000);
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

/**
 * 检查 GitHub 是否有更新（对比 tag / name 中的版本号）
 */
handleIpc("app:checkUpdate", async () => {
  const current = DESKTOP_VERSION;
  const api =
    "https://api.github.com/repos/AvaterXXX/grok-desktop/releases/latest";
  try {
    const data = await new Promise((resolve, reject) => {
      const req = net.request({ url: api, method: "GET" });
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callback(value);
      };
      req.setHeader("User-Agent", "grok-desktop");
      req.setHeader("Accept", "application/vnd.github+json");
      let body = "";
      req.on("response", (res) => {
        res.on("data", (chunk) => {
          body += chunk.toString();
        });
        res.on("error", (err) => finish(reject, err));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            finish(reject, new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            finish(resolve, JSON.parse(body));
          } catch (e) {
            finish(reject, e);
          }
        });
      });
      req.on("error", (err) => finish(reject, err));
      timer = setTimeout(() => {
        const err = new Error("update check timed out");
        err.code = "UPDATE_CHECK_TIMEOUT";
        finish(reject, err);
        try {
          req.abort();
        } catch {
          /* request already closed */
        }
      }, UPDATE_CHECK_TIMEOUT_MS);
      req.end();
    });
    const tag = String(data.tag_name || data.name || "").replace(/^v/i, "");
    const newer = tag && compareSemver(tag, current) > 0;
    return {
      ok: true,
      current,
      latest: tag || null,
      hasUpdate: !!newer,
      url: data.html_url || "https://github.com/AvaterXXX/grok-desktop/releases",
      name: data.name || tag,
    };
  } catch (err) {
    return {
      ok: false,
      current,
      latest: null,
      hasUpdate: false,
      error: err.message || String(err),
      errorCode: err.code === "UPDATE_CHECK_TIMEOUT" ? "timeout" : "network",
      url: "https://github.com/AvaterXXX/grok-desktop/releases",
    };
  }
});

function compareSemver(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const CLI_UPDATE_CHECK_TIMEOUT_MS = 45000;
const CLI_UPDATE_APPLY_TIMEOUT_MS = 10 * 60 * 1000;
let cliUpdateBusy = false;

function runCaptured(command, args, timeoutMs, shell) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      const options = {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      };
      if (shell) options.shell = true;
      child = spawnCli(command, args, options);
    } catch (err) {
      finish({ code: -1, stdout: "", stderr: err.message || String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const take = (prev, chunk) => (prev + chunk.toString()).slice(-65536);
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout = take(stdout, chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr = take(stderr, chunk);
      });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: -1, stdout, stderr: stderr || "timeout" });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: err.message || String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

async function readCliUpdate(cliPath) {
  const result = await runCaptured(
    cliPath,
    ["update", "--check", "--json"],
    CLI_UPDATE_CHECK_TIMEOUT_MS,
    false,
  );
  const parsed = parseCliUpdateCheck(result.stdout);
  if (result.code !== 0 && !parsed.current) {
    return {
      ...parsed,
      ok: false,
      hasUpdate: false,
      error: parsed.error || (result.stderr || "").trim() || "check failed",
    };
  }
  return parsed;
}

async function stopAgentsForCliUpdate() {
  const procs = [];
  for (const entry of agents.values()) {
    const proc = entry && entry.client && entry.client.proc;
    if (proc) procs.push(proc);
  }
  disposeAllAgents();
  await new Promise((resolve) => {
    const live = procs.filter((proc) => proc.exitCode == null && proc.signalCode == null);
    if (!live.length) {
      resolve();
      return;
    }
    let pending = live.length;
    const timer = setTimeout(resolve, 4000);
    for (const proc of live) {
      proc.once("exit", () => {
        pending -= 1;
        if (pending <= 0) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  });
}

function relaunchAfterCliUpdate() {
  app.relaunch();
  quitApp();
}

async function offerCliUpdate() {
  const cliPath = resolveGrokCli();
  if (!commandExists(cliPath)) {
    return { ok: false, error: "missing", hasUpdate: false, updated: false };
  }
  const check = await readCliUpdate(cliPath);
  log(
    "[cli-update] current=" +
      (check.current || "") +
      " latest=" +
      (check.latest || "") +
      " hasUpdate=" +
      check.hasUpdate,
  );
  if (!check.ok || !check.hasUpdate) {
    return {
      ok: check.ok,
      hasUpdate: false,
      current: check.current,
      latest: check.latest,
      updated: false,
      error: check.error || null,
    };
  }
  showMainWindow();
  const copy = cliUpdatePrompt(check, uiLocale());
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const choice = await dialog.showMessageBox(parent, {
    type: "question",
    buttons: [copy.confirm, copy.cancel],
    defaultId: 0,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  });
  if (choice.response !== 0) {
    return {
      ok: true,
      hasUpdate: true,
      updated: false,
      declined: true,
      current: check.current,
      latest: check.latest,
    };
  }
  send("session:status", {
    state: "working",
    detail: L("Updating Grok CLI", "正在更新 Grok CLI"),
  });
  await stopAgentsForCliUpdate();
  const spec = cliUpdateSpawnSpec(check.installer, cliPath);
  const applied = await runCaptured(
    spec.command,
    spec.args,
    CLI_UPDATE_APPLY_TIMEOUT_MS,
    spec.shell,
  );
  const output = (applied.stdout || "") + "\n" + (applied.stderr || "");
  const after = await readCliUpdate(cliPath);
  const restart = cliUpdateShouldRestart({
    installer: check.installer,
    exitCode: applied.code,
    before: check,
    after,
    output,
  });
  if (!restart) {
    const failure = cliUpdateFailureCopy(uiLocale(), output.trim().slice(-800));
    send("session:status", { state: "ready", detail: failure.message });
    await dialog.showMessageBox(parent, {
      type: "error",
      buttons: [failure.confirm],
      title: failure.title,
      message: failure.message,
      detail: failure.detail,
      noLink: true,
    });
    return { ok: false, hasUpdate: true, updated: false, error: failure.detail };
  }
  relaunchAfterCliUpdate();
  return {
    ok: true,
    hasUpdate: true,
    updated: true,
    current: after.current || check.latest,
    latest: check.latest,
  };
}

handleIpc("app:offerCliUpdate", async () => {
  if (cliUpdateBusy) return { ok: true, skipped: true, hasUpdate: false, updated: false };
  cliUpdateBusy = true;
  try {
    return await offerCliUpdate();
  } catch (err) {
    log("[cli-update] " + (err && err.message ? err.message : err));
    return { ok: false, hasUpdate: false, updated: false, error: err.message || String(err) };
  } finally {
    cliUpdateBusy = false;
  }
});


