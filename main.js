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
  loadHistoryPreview,
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
} = require("./src/sessions");
const { AcpClient } = require("./src/acp");
const { buildFileChange } = require("./src/diff");
const { searchSessions } = require("./src/search");
const plugins = require("./src/plugins");
const skills = require("./src/skills");
const settings = require("./src/settings");
const memory = require("./src/memory");
const mcp = require("./src/mcp");
const hooks = require("./src/hooks");
const { commandExists, defaultCwd, spawnCli, appConfigDir } = require("./src/platform");
const { commandsForRenderer } = require("./src/commands-zh");
const { execSync, spawn } = require("child_process");

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
  if (u && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = "http://" + u;
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
  log(`[perf] ${label} ${ms}ms`);
  return ms;
}


let mainWindow = null;
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

function uiLocale() {
  try {
    return settings.readDesktopSettings().locale === "en" ? "en" : "zh";
  } catch {
    return "zh";
  }
}

function isZh() {
  return uiLocale() !== "en";
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
const APP_ICON_ICO = path.join(__dirname, "assets", "icon.ico");
const APP_ICON_64 = path.join(__dirname, "assets", "icon-64.png");
/** macOS menu-bar template (black + alpha; system tints to match bar) */
const APP_TRAY_TEMPLATE = path.join(__dirname, "assets", "iconTemplate.png");
const APP_TRAY_TEMPLATE_2X = path.join(__dirname, "assets", "iconTemplate@2x.png");
const APP_TRAY_TEMPLATE_LG = path.join(__dirname, "assets", "trayTemplate.png");
const APP_TRAY_ICON = path.join(__dirname, "assets", "tray-icon.png");

function resolveAppIconPath() {
  if (process.platform === "win32" && fs.existsSync(APP_ICON_ICO)) return APP_ICON_ICO;
  if (fs.existsSync(APP_ICON)) return APP_ICON;
  if (fs.existsSync(APP_ICON_64)) return APP_ICON_64;
  return null;
}

function resolveTrayImage() {
  // macOS: template image — transparent, no black plate; matches light/dark menu bar
  if (process.platform === "darwin") {
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

  const candidates =
    process.platform === "win32"
      ? [APP_ICON_ICO, APP_TRAY_ICON, APP_ICON_64, APP_ICON]
      : [APP_TRAY_ICON, APP_ICON_64, APP_ICON, APP_ICON_ICO];
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
  const zh = isZh();
  let tip = "Grok Desktop";
  if (busyAgentCount > 0) {
    tip = zh
      ? `Grok Desktop · ${busyAgentCount} 个任务进行中`
      : `Grok Desktop · ${busyAgentCount} running`;
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
        const zh = isZh();
        // Short OS toast so users don't think the app crashed
        if (Notification.isSupported()) {
          const n = new Notification({
            title: zh ? "Grok Desktop 仍在运行" : "Grok Desktop is still running",
            body: zh
              ? "已最小化到系统托盘。右键托盘图标可退出。"
              : "Minimized to the system tray. Right-click the tray icon to quit.",
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
  const zh = isZh();
  const busyLabel =
    busyAgentCount > 0
      ? zh
        ? `运行中 · ${busyAgentCount}`
        : `Running · ${busyAgentCount}`
      : zh
        ? "空闲"
        : "Idle";
  return Menu.buildFromTemplate([
    { label: `Grok Desktop  v${DESKTOP_VERSION}`, enabled: false },
    { label: busyLabel, enabled: false },
    { type: "separator" },
    {
      label: zh ? "显示窗口" : "Show window",
      click: () => showMainWindow(),
    },
    {
      label: zh ? "新建会话" : "New session",
      click: () => sendAppCommand("new-session"),
    },
    {
      label: zh ? "设置" : "Settings",
      click: () => sendAppCommand("open-settings"),
    },
    { type: "separator" },
    {
      label: zh ? "退出 Grok Desktop" : "Quit Grok Desktop",
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
  const zh = isZh();
  const isMac = process.platform === "darwin";
  const fileMenu = {
    label: zh ? "文件" : "File",
    submenu: [
      {
        label: zh ? "新建会话" : "New Session",
        accelerator: "CmdOrCtrl+N",
        click: () => sendAppCommand("new-session"),
      },
      {
        label: zh ? "设置" : "Settings",
        accelerator: "CmdOrCtrl+,",
        click: () => sendAppCommand("open-settings"),
      },
      { type: "separator" },
      isMac
        ? { role: "close", label: zh ? "关闭窗口" : "Close Window" }
        : {
            label: zh ? "隐藏到托盘" : "Hide to Tray",
            accelerator: "CmdOrCtrl+H",
            click: () => {
              if (closeToTrayEnabled()) hideMainWindowToTray();
              else mainWindow?.minimize();
            },
          },
      {
        label: zh ? "退出" : "Quit",
        accelerator: isMac ? "Cmd+Q" : "Ctrl+Q",
        click: () => quitApp(),
      },
    ],
  };
  const editMenu = {
    label: zh ? "编辑" : "Edit",
    submenu: [
      { role: "undo", label: zh ? "撤销" : "Undo" },
      { role: "redo", label: zh ? "重做" : "Redo" },
      { type: "separator" },
      { role: "cut", label: zh ? "剪切" : "Cut" },
      { role: "copy", label: zh ? "复制" : "Copy" },
      { role: "paste", label: zh ? "粘贴" : "Paste" },
      { role: "selectAll", label: zh ? "全选" : "Select All" },
    ],
  };
  const viewMenu = {
    label: zh ? "查看" : "View",
    submenu: [
      {
        label: zh ? "切换计划面板" : "Toggle Plan Panel",
        accelerator: "CmdOrCtrl+P",
        click: () => sendAppCommand("toggle-plan"),
      },
      { type: "separator" },
      { role: "reload", label: zh ? "重新加载" : "Reload" },
      { role: "toggleDevTools", label: zh ? "开发者工具" : "Toggle Developer Tools" },
      { type: "separator" },
      { role: "resetZoom", label: zh ? "实际大小" : "Actual Size" },
      { role: "zoomIn", label: zh ? "放大" : "Zoom In" },
      { role: "zoomOut", label: zh ? "缩小" : "Zoom Out" },
      { type: "separator" },
      { role: "togglefullscreen", label: zh ? "全屏" : "Toggle Full Screen" },
    ],
  };
  const helpMenu = {
    label: zh ? "帮助" : "Help",
    submenu: [
      {
        label: zh ? "检查更新" : "Check for Updates",
        click: () => sendAppCommand("check-update"),
      },
      {
        label: zh ? "打开发布页" : "Open Releases",
        click: () => shell.openExternal(RELEASES_URL),
      },
      {
        label: zh ? "GitHub 仓库" : "GitHub Repository",
        click: () => shell.openExternal(REPO_URL),
      },
      { type: "separator" },
      {
        label: zh ? `关于 Grok Desktop ${DESKTOP_VERSION}` : `About Grok Desktop ${DESKTOP_VERSION}`,
        click: () => sendAppCommand("open-about"),
      },
    ],
  };
  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about", label: zh ? "关于 Grok Desktop" : "About Grok Desktop" },
        { type: "separator" },
        {
          label: zh ? "设置" : "Settings",
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
        { role: "quit", label: zh ? "退出" : "Quit" },
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
      sandbox: false,
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
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (/^https?:\/\//i.test(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // Native right-click context menu (localized)
  mainWindow.webContents.on("context-menu", (_e, params) => {
    const zh = isZh();
    const template = [];
    if (params.isEditable) {
      template.push(
        { role: "undo", label: zh ? "撤销" : "Undo" },
        { role: "redo", label: zh ? "重做" : "Redo" },
        { type: "separator" },
        { role: "cut", label: zh ? "剪切" : "Cut", enabled: params.editFlags?.canCut !== false },
        { role: "copy", label: zh ? "复制" : "Copy", enabled: params.editFlags?.canCopy !== false },
        { role: "paste", label: zh ? "粘贴" : "Paste", enabled: params.editFlags?.canPaste !== false },
        { role: "selectAll", label: zh ? "全选" : "Select All" },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      template.push({ role: "copy", label: zh ? "复制" : "Copy" });
      template.push({
        label: zh ? "复制并粘贴到输入框" : "Copy & paste into composer",
        click: () => {
          mainWindow.webContents.send("chat:insert-text", params.selectionText);
        },
      });
    } else {
      template.push({
        label: zh ? "粘贴到输入框" : "Paste into composer",
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
function toDiffEvent(change) {
  if (!change) return null;
  const { before, after, ...light } = change;
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
  const s = found || findSession(sessionId);
  const entry = getAgentEntry(sessionId);
  if (entry) entry.meta = s || entry.meta || null;
  if (!activeSessionId || activeSessionId === sessionId) {
    activeSessionId = sessionId;
    activeSessionMeta = s || (entry && entry.meta) || activeSessionMeta;
  }
  send("agents:update", { openIds: [...agents.keys()], activeSessionId });
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
  send("agents:update", { openIds: [...agents.keys()], activeSessionId });
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
  client.on("usage", (usage) => {
    const modelId = usage?.modelId || usage?.model || client.currentModelId || "";
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
    send(
      "session:status",
      withSid({ state: "disconnected", detail: `agent 已退出 (${code})` }),
    );
    if (id) agents.delete(id);
    send("agents:update", { openIds: [...agents.keys()], activeSessionId });
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
  if (existing?.client?.started && existing.client.proc && existing.client.sessionId === sessionId) {
    // cwd change on same session is rare; keep process if alive
    touchAgent(sessionId);
    return existing.client;
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
  send("agents:update", { openIds: [...agents.keys()], activeSessionId });
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
  send("agents:update", { openIds: [...agents.keys()], activeSessionId });
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

ipcMain.handle("sessions:list", async (_e, { limit } = {}) => {
  try {
    const _t = Date.now();
    const rows = listSessions({ limit: limit || 200 });
    perf("sessions:list n=" + (rows?.length || 0), _t);
    return rows;
  } catch (err) {
    log(`sessions:list ${err.message}`);
    return [];
  }
});

ipcMain.handle("sessions:rename", async (_e, { sessionId, title }) => {
  return renameSession(sessionId, title);
});

/** 会话本地目录（供「在文件夹中显示」） */
ipcMain.handle("sessions:path", async (_e, { sessionId } = {}) => {
  const s = findSession(sessionId);
  if (!s?.dir) return { ok: false, error: "会话目录不存在" };
  return { ok: true, path: s.dir, id: s.id, cwd: s.cwd || null, title: s.title || null };
});

ipcMain.handle("sessions:usage", async (_e, { sessionId } = {}) => {
  const s = findSession(sessionId);
  if (!s?.dir) return { ok: false };
  try {
    const raw = JSON.parse(require("fs").readFileSync(require("path").join(s.dir, "signals.json"), "utf8"));
    const used = Number(raw.contextTokensUsed ?? raw.used);
    const size = Number(raw.contextWindowTokens ?? raw.size);
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return { ok: false };
    return { ok: true, used, size, estimated: false };
  } catch {
    return { ok: false };
  }
});

ipcMain.handle("sessions:delete", async (_e, { sessionId }) => {
  disposeAgent(sessionId);
  // Local dir only. `grok sessions delete` spawns the CLI (~seconds) per row.
  return deleteSessionDir(sessionId);
});

ipcMain.handle("sessions:rewind", async (_e, { sessionId } = {}) => {
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
    send("agents:update", { openIds: [...agents.keys()], activeSessionId });
    return { ok: true, dropped: cut.dropped, reloaded: true, sessionId: sid };
  } catch (err) {
    log(`sessions:rewind reload ${err.message}`);
    return { ok: true, dropped: cut.dropped, reloaded: false, error: err.message, sessionId: sid };
  }
});

ipcMain.handle("sessions:searchContent", async (_e, { query, limit } = {}) => {
  try {
    return searchSessions(query, { limit: limit || 40 });
  } catch (err) {
    log(`sessions:searchContent ${err.message}`);
    return [];
  }
});

ipcMain.handle("agents:list", async () => ({
  openIds: [...agents.keys()],
  activeSessionId,
}));

ipcMain.handle("agents:close", async (_e, { sessionId } = {}) => {
  if (sessionId) disposeAgent(sessionId);
  return { ok: true, openIds: [...agents.keys()] };
});

ipcMain.handle("sessions:saveGoal", async (_e, { sessionId, goal } = {}) => {
  try {
    const s = findSession(sessionId);
    if (!s?.dir) return { ok: false };
    if (!goal) {
      try { require("fs").unlinkSync(require("path").join(s.dir, "desktop-goal.json")); } catch { /* none */ }
      try { require("fs").unlinkSync(require("path").join(s.dir, "desktop-plan.json")); } catch { /* none */ }
      return { ok: true };
    }
    saveSessionGoal(s.dir, goal);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("sessions:history", async (_e, { sessionId }) => {
  try {
    const s = findSession(sessionId);
    if (!s) return { error: "not found", session: null, messages: [], assets: [] };
    const messages = loadHistoryPreview(s.dir, { maxMessages: 2000, maxChars: 200000, maxBytes: 8 * 1024 * 1024 });
    // Session images from assets/ + images/ (with mtime for timeline placement)
    const assets = [];
    const seenPaths = new Set();
    const pushImg = (full, name) => {
      if (seenPaths.has(full)) return;
      if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) return;
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size < 32 || st.size > 12_000_000) return;
        const dataUrl = pathToDataUrl(full);
        if (!dataUrl) return;
        seenPaths.add(full);
        assets.push({
          name,
          path: full,
          dataUrl,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        /* skip */
      }
    };
    for (const sub of ["assets", "images"]) {
      const dir = path.join(s.dir, sub);
      if (!fs.existsSync(dir)) continue;
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.slice(0, 60)) {
        pushImg(path.join(dir, name), name);
      }
    }
    assets.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
    const plan = loadSessionPlan(s.dir);
    const goal = loadSessionGoal(s.dir);
    return { session: s, messages, assets, plan, goal };
  } catch (err) {
    return { error: err.message, session: null, messages: [], assets: [], plan: null, goal: null };
  }
});

/**
 * Focus an already-live agent without reconnect noise.
 * soft: true → no "connecting" status (instant tab switch).
 */
ipcMain.handle("session:activate", async (_e, { sessionId } = {}) => {
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
  send("agents:update", { openIds: [...agents.keys()], activeSessionId });
  const commands = commandsForRenderer(live.availableCommands);
  return {
    ok: true,
    live: true,
    session: s,
    commands,
    models,
    openIds: [...agents.keys()],
    currentModelId: live.currentModelId || models?.currentModelId || null,
  };
});

ipcMain.handle("session:open", async (_e, { sessionId, soft } = {}) => {
  const gen = ++openGeneration;
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
    send("agents:update", { openIds: [...agents.keys()], activeSessionId });
    return {
      ok: true,
      session: s,
      reused: true,
      commands,
      models,
      openIds: [...agents.keys()],
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
    try { await client.setEffort("xhigh"); } catch { /* keep Extra High default */ }
    try { await client.setModel("grok-4.6"); } catch { /* ignore */ }
    const entry = getAgentEntry(sessionId);
    if (entry) entry.meta = s;
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
    send("agents:update", { openIds: [...agents.keys()], activeSessionId });
    return {
      ok: true,
      session: s,
      commands,
      models,
      openIds: [...agents.keys()],
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
      send("agents:update", { openIds: [...agents.keys()], activeSessionId });
      return { ok: true, session: s, retried: true, openIds: [...agents.keys()] };
    } catch (err2) {
      send("session:status", {
        state: "error",
        detail: err2.message,
        session: s,
        sessionId,
      });
      throw err2;
    }
  }
});

ipcMain.handle("session:new", async (_e, { cwd } = {}) => {
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
    try { await client.setEffort("xhigh"); } catch { /* chip still Extra High */ }
    try { await client.setModel("grok-4.6"); } catch { /* ignore */ }
    const models = extractModels(res);
    if (models) send("session:models", { ...models, sessionId: sid });
    send("session:status", {
      state: "ready",
      detail: "新对话",
      session: activeSessionMeta,
    });
    send("agents:update", { openIds: [...agents.keys()], activeSessionId });
    return {
      ok: true,
      session: activeSessionMeta,
      models,
      openIds: [...agents.keys()],
    };
  } catch (err) {
    send("session:status", { state: "error", detail: err.message });
    throw err;
  }
});

/**
 * prompt: { text?: string, images?: [{ mimeType, dataBase64 }], sessionId?: string }
 */
ipcMain.handle("session:prompt", async (_e, payload = {}) => {
  const sid = payload.sessionId || activeSessionId;
  const client = getAgent(sid);
  if (!client || !client.sessionId) throw new Error("没有活动会话");
  const entry = getAgentEntry(sid);
  if (entry?.busy) {
    throw new Error("该会话仍在处理上一轮，请稍候或使用队列");
  }
  touchAgent(sid);
  const text = payload.text || "";
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

ipcMain.handle("session:cancel", async (_e, { sessionId } = {}) => {
  const sid = sessionId || activeSessionId;
  const entry = getAgentEntry(sid);
  getAgent(sid)?.cancel();
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

ipcMain.handle("dialog:pickDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:pickFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  const out = [];
  for (const p of result.filePaths) {
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

ipcMain.handle("file:describePaths", async (_e, paths) => {
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = typeof raw === "string" ? raw : "";
    if (!p) continue;
    try {
      const st = fs.statSync(p);
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

ipcMain.handle("permission:respond", async (_e, { id, optionId, sessionId } = {}) => {
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

ipcMain.handle("permission:setAutoApprove", async (_e, on) => {
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

ipcMain.handle("dialog:pickImages", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
  });
  if (result.canceled) return [];
  const out = [];
  for (const p of result.filePaths) {
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

ipcMain.handle("clipboard:readImage", async () => {
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

ipcMain.handle("file:readImage", async (_e, filePath) => {
  const dataUrl = pathToDataUrl(filePath);
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  return {
    path: filePath,
    name: path.basename(filePath),
    mimeType: m?.[1] || "image/png",
    dataBase64: m?.[2] || "",
    dataUrl,
  };
});

ipcMain.handle("shell:openPath", async (_e, p) => {
  if (p) return shell.openPath(p);
});

ipcMain.handle("shell:showItem", async (_e, p) => {
  if (p) shell.showItemInFolder(p);
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

ipcMain.handle("shell:openWorkspaceCli", async () => {
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

function shanghaiDate(d = new Date()) {
  return d
    .toLocaleString("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .slice(0, 10);
}

function formatResetZh(iso) {
  if (!iso) return "";
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return String(iso);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(dt);
  const wd = parts.find((p) => p.type === "weekday")?.value || "";
  const mo = parts.find((p) => p.type === "month")?.value || "";
  const day = parts.find((p) => p.type === "day")?.value || "";
  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  return `${wd} ${mo}/${day} ${hh}:${mm}`.trim();
}

function centVal(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && typeof v.val === "number") return v.val;
  return null;
}

function parseBillingPayload(data) {
  if (!data || typeof data !== "object") return null;
  const cfg = data.config && typeof data.config === "object" ? data.config : data;
  const percentRaw = cfg.creditUsagePercent ?? cfg.credit_usage_percent ?? cfg.percent ?? cfg.usagePercent;
  const used = centVal(cfg.used);
  const limit = centVal(cfg.monthlyLimit || cfg.monthly_limit || cfg.limit);
  let percent = typeof percentRaw === "number" ? percentRaw : null;
  if (percent == null && percentRaw != null && String(percentRaw).trim() !== "") {
    const n = Number(percentRaw);
    if (Number.isFinite(n)) percent = n;
  }
  if (percent == null && used != null && limit) percent = Math.round((used / limit) * 1000) / 10;
  const period = cfg.currentPeriod || cfg.current_period || {};
  const resetAt = period.end || cfg.billingPeriodEnd || cfg.billing_period_end || "";
  const periodStart = period.start || period.begin || cfg.billingPeriodStart || cfg.billing_period_start || "";
  if (percent == null && resetAt) percent = 0;
  if (percent == null && !resetAt) return null;
  const tier = data.subscriptionTier || data.subscription_tier || "";
  return {
    percent,
    resetAt,
    periodStart,
    reset: formatResetZh(resetAt),
    subscriptionTier: tier,
    raw: `周限额 ${percent ?? "—"}% · 刷新 ${formatResetZh(resetAt) || resetAt || "—"}`,
  };
}

function readUnifiedLog(maxBytes = 2_000_000) {
  const file = path.join(grokHome(), "logs", "unified.jsonl");
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function readUnifiedTail() {
  return readUnifiedLog(2_000_000);
}

function billingFromLog(text) {
  const lines = text.split(/\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !/billing:\s*fetched credits config|creditUsagePercent|currentPeriod/i.test(line)) continue;
    try {
      const ev = JSON.parse(line);
      const cands = [ev, ev.ctx, ev.context, ev.data, ev.config];
      for (const c of cands) {
        if (c == null) continue;
        let obj = c;
        if (typeof c === "string") {
          try { obj = JSON.parse(c); } catch { continue; }
        }
        const parsed = parseBillingPayload(obj);
        if (parsed) return parsed;
      }
    } catch {
      /* skip */
    }
  }
  return null;
}

function pickTok(obj, keys) {
  if (!obj || typeof obj !== "object") return 0;
  for (const k of keys) {
    const n = Number(obj[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function tokenPartsOf(ctx, ev) {
  const src = [ctx, ev, ev?.usage, ev?.tokenUsage, ctx?.usage].filter(Boolean);
  const grab = (keys) => {
    for (const o of src) {
      const n = pickTok(o, keys);
      if (n) return n;
    }
    return 0;
  };
  const input = grab(["prompt_tokens", "promptTokens", "inputTokens", "input_tokens"]);
  const output = grab(["completion_tokens", "completionTokens", "outputTokens", "output_tokens"]);
  const reasoning = grab(["reasoning_tokens", "reasoningTokens"]);
  const cache = grab([
    "cached_prompt_tokens",
    "cachedPromptTokens",
    "cache_read_tokens",
    "cacheReadTokens",
    "cached_tokens",
    "cachedTokens",
  ]);
  return { input, output, reasoning, cache, total: input + output + reasoning };
}

function emptyDaily() {
  return { tokens: 0, input: 0, output: 0, reasoning: 0, cache: 0, byModel: {} };
}

function modelFamilyOf(id) {
  const s = String(id || "");
  if (/4[.-]?5/.test(s)) return "grok-4.5";
  if (/4[.-]?6/.test(s)) return "grok-4.6";
  return s || "grok-4.6";
}

function addTokenParts(acc, parts) {
  acc.tokens = (Number(acc.tokens) || 0) + (Number(parts.total) || 0);
  acc.input = (Number(acc.input) || 0) + (Number(parts.input) || 0);
  acc.output = (Number(acc.output) || 0) + (Number(parts.output) || 0);
  acc.reasoning = (Number(acc.reasoning) || 0) + (Number(parts.reasoning) || 0);
  acc.cache = (Number(acc.cache) || 0) + (Number(parts.cache) || 0);
}

function addByModel(acc, family, parts) {
  if (!acc.byModel) acc.byModel = {};
  if (!acc.byModel[family]) acc.byModel[family] = { tokens: 0, input: 0, output: 0, reasoning: 0, cache: 0 };
  addTokenParts(acc.byModel[family], parts);
}

function mergeByModelMax(a, b) {
  const out = {};
  for (const src of [a || {}, b || {}]) {
    for (const [k, slot] of Object.entries(src)) {
      const cur = out[k];
      if (!cur || (Number(slot.tokens) || 0) > (Number(cur.tokens) || 0)) {
        out[k] = { ...slot };
      }
    }
  }
  return out;
}

function eventDay(ev) {
  const ts = ev?.ts || ev?.time || ev?.timestamp || ev?.t || "";
  if (typeof ts === "number") return shanghaiDate(new Date(ts > 1e12 ? ts : ts * 1000));
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return shanghaiDate(d);
  }
  return "";
}

function dailyHistoryFromLog(text) {
  const days = {};
  for (const line of String(text || "").split(/\n/)) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const day = eventDay(ev);
    if (!day) continue;
    const msg = String(ev.msg || ev.message || ev.event || ev.name || ev.kind || "");
    const ctx = ev.ctx || ev.data || ev;
    const isInf =
      /inference_done|inference done/i.test(msg) ||
      ctx.prompt_tokens != null ||
      ev.prompt_tokens != null ||
      ctx.promptTokens != null;
    if (!isInf) continue;
    const parts = tokenPartsOf(ctx, ev);
    if (!parts.total && !parts.cache) continue;
    if (!days[day]) days[day] = emptyDaily();
    addTokenParts(days[day], parts);
    const family = modelFamilyOf(
      ctx.model || ev.model || ev.modelId || ev.model_id || ctx.modelId || ctx.model_id,
    );
    addByModel(days[day], family, parts);
  }
  return days;
}

function dailyTokensFromLog(text, date) {
  const days = dailyHistoryFromLog(text);
  return days[date] ? { ...emptyDaily(), ...days[date] } : emptyDaily();
}

function slimDay(slot) {
  const s = slot || {};
  return {
    tokens: Number(s.tokens) || 0,
    input: Number(s.input) || 0,
    output: Number(s.output) || 0,
    reasoning: Number(s.reasoning) || 0,
    cache: Number(s.cache) || 0,
  };
}

function mergeDayMax(a, b) {
  const x = slimDay(a);
  const y = slimDay(b);
  return {
    tokens: Math.max(x.tokens, y.tokens),
    input: Math.max(x.input, y.input),
    output: Math.max(x.output, y.output),
    reasoning: Math.max(x.reasoning, y.reasoning),
    cache: Math.max(x.cache, y.cache),
  };
}

function pruneHistory(map, keepDays = 400) {
  const out = {};
  const keys = Object.keys(map || {}).sort();
  const cut = keys.length > keepDays ? keys.slice(-keepDays) : keys;
  for (const k of cut) out[k] = slimDay(map[k]);
  return out;
}

const lastUsageTurn = new Map();

function turnTokensOf(u) {
  if (!u) return 0;
  const inp = Number(u.inputTokens);
  const out = Number(u.outputTokens);
  const rea = Number(u.reasoningTokens);
  if ([inp, out, rea].some((n) => Number.isFinite(n) && n > 0)) {
    return (Number.isFinite(inp) ? inp : 0) + (Number.isFinite(out) ? out : 0) + (Number.isFinite(rea) ? rea : 0);
  }
  return 0;
}

function noteDailyFromUsage(usage, sessionId) {
  const input = Number(usage?.inputTokens) || 0;
  const output = Number(usage?.outputTokens) || 0;
  const reasoning = Number(usage?.reasoningTokens) || 0;
  const cache = Number(usage?.cacheReadTokens) || 0;
  const n = input + output + reasoning;
  if (n <= 0 && cache <= 0) return;
  const key = sessionId || "_";
  const prev = lastUsageTurn.get(key);
  if (prev && Date.now() - prev.t < 10000 && prev.n === n && prev.cache === cache) return;
  let dIn = input;
  let dOut = output;
  let dRea = reasoning;
  let dCache = cache;
  if (prev && Date.now() - prev.t < 120000 && n >= prev.n && input >= (prev.input || 0)) {
    dIn = Math.max(0, input - (prev.input || 0));
    dOut = Math.max(0, output - (prev.output || 0));
    dRea = Math.max(0, reasoning - (prev.reasoning || 0));
    dCache = Math.max(0, cache - (prev.cache || 0));
  }
  lastUsageTurn.set(key, { n, input, output, reasoning, cache, t: Date.now() });
  if (dIn + dOut + dRea + dCache <= 0) return;
  try {
    const today = shanghaiDate();
    const desk = settings.readDesktopSettings();
    const cur = desk.dailyUsage?.date === today ? { ...emptyDaily(), ...desk.dailyUsage } : emptyDaily();
    const parts = { total: dIn + dOut + dRea, input: dIn, output: dOut, reasoning: dRea, cache: dCache };
    addTokenParts(cur, parts);
    const family = modelFamilyOf(
      usage?.modelId || usage?.model || getAgent(sessionId)?.currentModelId || "",
    );
    addByModel(cur, family, parts);
    const history = { ...(desk.dailyHistory || {}) };
    history[today] = mergeDayMax(history[today], cur);
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
    });
  } catch {
    /* ignore */
  }
}

ipcMain.handle("account:usage", async (_e, extra = {}) => {
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
    const tail = readUnifiedTail();
    if (!billing) {
      billing = billingFromLog(tail);
      if (billing) source = "log";
    }
    if (!billing && desk.lastBilling) {
      billing = desk.lastBilling;
      source = "cache";
    }
    const logDays = dailyHistoryFromLog(readUnifiedLog(12_000_000));
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

    settings.writeDesktopSettings({
      ...(billing ? { lastBilling: { ...billing, fetchedAt: Date.now() } } : {}),
      dailyUsage: { date: today, ...daily },
      dailyHistory: pruneHistory(history),
    });

    let weekFrom = "";
    if (billing?.periodStart) {
      const ps = new Date(billing.periodStart);
      if (!Number.isNaN(ps.getTime())) weekFrom = shanghaiDate(ps);
    }
    if (!weekFrom) {
      const [yy, mm, dd] = today.split("-").map(Number);
      const base = new Date(Date.UTC(yy, mm - 1, dd));
      base.setUTCDate(base.getUTCDate() - 6);
      weekFrom = base.toISOString().slice(0, 10);
    }
    const week = emptyDaily();
    const pruned = pruneHistory(history);
    for (const [d, slot] of Object.entries(pruned)) {
      if (d < weekFrom || d > today) continue;
      week.tokens += Number(slot.tokens) || 0;
      week.input += Number(slot.input) || 0;
      week.output += Number(slot.output) || 0;
      week.reasoning += Number(slot.reasoning) || 0;
      week.cache += Number(slot.cache) || 0;
    }

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
      dailyTokens: daily.tokens,
      dailyInput: daily.input,
      dailyOutput: daily.output,
      dailyCache: daily.cache,
      dailyReasoning: daily.reasoning,
      dailyByModel: daily.byModel || {},
      history: pruned,
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

ipcMain.handle("settings:get", async () => {
  const _t = Date.now();
  const all = settings.getAllSettings();
  perf("settings:get disk", _t);
  const tModels = Date.now();
  const models = await settings.listModels();
  perf("settings:get grok models", tModels);
  perf("settings:get total", _t);
  return { ...all, models };
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

ipcMain.handle("account:profile", async () => {
  try {
    return { ok: true, ...readAccountProfile() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("profile:setAvatar", async (_e, { dataBase64, mimeType } = {}) => {
  if (!dataBase64) throw new Error("empty avatar");
  const ext = /jpe?g/i.test(mimeType || "") ? ".jpg" : /webp/i.test(mimeType || "") ? ".webp" : ".png";
  const dest = path.join(appConfigDir(), "profile-avatar" + ext);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(dataBase64, "base64"));
  return settings.writeDesktopSettings({ profileAvatar: dest });
});

ipcMain.handle("profile:clearAvatar", async () => {
  const cur = settings.readDesktopSettings().profileAvatar;
  if (cur) {
    try { fs.unlinkSync(cur); } catch { /* ignore */ }
  }
  return settings.writeDesktopSettings({ profileAvatar: "" });
});

ipcMain.handle("settings:saveDesktop", async (_e, partial) => {
  const next = settings.writeDesktopSettings(partial || {});
  // Keep OS + chrome in sync when desktop prefs change
  if (
    partial &&
    ("openAtLogin" in partial ||
      "locale" in partial ||
      "closeToTray" in partial ||
      "minimizeToTray" in partial || "theme" in partial || "proxyUrl" in partial || "proxyEnabled" in partial)
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
ipcMain.handle("wallpaper:list", async () => {
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

ipcMain.handle("settings:saveGrok", async (_e, partial) => {
  return settings.updateGrokConfig(partial || {});
});

// ── Plugins ────────────────────────────────────────────

ipcMain.handle("plugins:listInstalled", async () => plugins.listInstalled());
ipcMain.handle("plugins:listAvailable", async () => {
  const r = await plugins.listAvailable();
  return Array.isArray(r) ? r : r;
});
ipcMain.handle("plugins:install", async (_e, spec) => plugins.installPlugin(spec));
ipcMain.handle("plugins:uninstall", async (_e, name) => plugins.uninstallPlugin(name));
ipcMain.handle("plugins:enable", async (_e, name) => plugins.enablePlugin(name));
ipcMain.handle("plugins:disable", async (_e, name) => plugins.disablePlugin(name));
ipcMain.handle("plugins:details", async (_e, name) => plugins.pluginDetails(name));

// ── Skills ─────────────────────────────────────────────

ipcMain.handle("skills:list", async (_e, opts) => skills.listSkills(opts?.cwd));
ipcMain.handle("skills:read", async (_e, name) => skills.readSkill(name));
ipcMain.handle("skills:create", async (_e, payload) => skills.createSkill(payload || {}));
ipcMain.handle("skills:write", async (_e, { name, markdown }) => skills.writeSkill(name, markdown));
ipcMain.handle("skills:open", async (_e, skillPath) => {
  if (skillPath) return shell.openPath(skillPath);
});

// ── Memory ─────────────────────────────────────────────

ipcMain.handle("memory:list", async () => memory.listMemoryFiles());
// UI always lists all entries (so you can manage experience even when the switch is off).
// Agent retrieval uses memory:agentContext, which respects experienceMemory.
ipcMain.handle("memory:listEntries", async (_e, opts) =>
  memory.listEntries({ ...(opts || {}), includeExperience: true }),
);
ipcMain.handle("memory:getEntry", async (_e, id) => memory.getEntry(id));
ipcMain.handle("memory:upsertEntry", async (_e, payload) => memory.upsertEntry(payload || {}));
ipcMain.handle("memory:deleteEntry", async (_e, id) => memory.deleteEntry(id));
ipcMain.handle("memory:read", async (_e, filePath) => memory.readMemoryFile(filePath));
ipcMain.handle("memory:write", async (_e, { path: filePath, content }) =>
  memory.writeMemoryFile(filePath, content),
);
ipcMain.handle("memory:append", async (_e, payload) => memory.appendNote(payload || {}));
ipcMain.handle("memory:setEnabled", async (_e, enabled) => memory.setEnabled(!!enabled));
ipcMain.handle("memory:clear", async () => memory.clearMemory());
ipcMain.handle("memory:agentContext", async (_e, opts) => {
  const desk = settings.readDesktopSettings();
  return memory.listEntriesForAgent({
    experienceEnabled: desk.experienceMemory !== false,
    type: opts?.type,
    category: opts?.category,
  });
});

ipcMain.handle("commands:list", async (_e, { sessionId } = {}) => {
  const client = getAgent(sessionId || activeSessionId);
  return { commands: commandsForRenderer(client?.availableCommands) };
});

ipcMain.handle("session:export", async (_e, { sessionId } = {}) => {
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

ipcMain.handle("session:run-slash", async (_e, { command, args, sessionId } = {}) => {
  const sid = sessionId || activeSessionId;
  const client = getAgent(sid);
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
  send("session:status", {
    state: "working",
    detail: `/${cmd}…`,
    session: meta,
    sessionId: sid,
  });
  try {
    await client.prompt(text);
    send("session:status", {
      state: "ready",
      detail: "就绪",
      session: meta,
      sessionId: sid,
    });
    return { ok: true };
  } catch (err) {
    send("session:status", {
      state: "error",
      detail: err.message,
      session: meta,
      sessionId: sid,
    });
    throw err;
  }
});

ipcMain.handle("mcp:list", async () => mcp.listMcp());
ipcMain.handle("mcp:remove", async (_e, name) => mcp.removeMcp(name));
ipcMain.handle("mcp:doctor", async () => mcp.doctorMcp());
ipcMain.handle("hooks:list", async (_e, { cwd } = {}) => {
  const sessionCwd =
    cwd ||
    activeSessionMeta?.cwd ||
    findSession(activeSessionId)?.cwd ||
    null;
  return hooks.listHooks({ cwd: sessionCwd });
});
ipcMain.handle("mcp:add", async (_e, { name, command, args }) =>
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
      models.currentModelId || client?.currentModelId || null,
    availableModels: available.map(withCacheMeta),
  };
}

ipcMain.handle("models:list", async (_e, { sessionId } = {}) => {
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

ipcMain.handle("session:set-effort", async (_e, { effort, sessionId } = {}) => {
  const client = getAgent(sessionId || activeSessionId);
  if (!client || !client.sessionId) throw new Error("请先打开一个会话");
  const res = await client.setEffort(effort);
  return { ok: true, effort, result: res };
});

ipcMain.handle("models:set", async (_e, modelId, sessionId) => {
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
  } catch {
    /* ignore */
  }
  send("session:model", { modelId: mid, sessionId: client.sessionId });
  return { ok: true, modelId: mid, result: res };
});

ipcMain.handle("app:info", async () => ({
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
ipcMain.handle("app:isOccluded", async () => isWindowOccluded());

/** Taskbar / tray busy indicator from renderer */
ipcMain.handle("app:setBusyCount", async (_e, count) => {
  const n = Math.max(0, Number(count) || 0);
  updateTrayStatus(n);
  setTaskbarWorking(n > 0);
  return { ok: true, count: n };
});

/** Flash taskbar when work finishes in background */
ipcMain.handle("app:flashFrame", async (_e, on = true) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
  try {
    if (on) flashTaskbarIfNeeded();
    else mainWindow.flashFrame(false);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

/** 环境诊断：CLI 是否存在、是否像已登录 */
ipcMain.handle("app:diagnose", async () => {
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
ipcMain.handle("shell:openExternal", async (_e, url) => {
  if (url) await shell.openExternal(String(url));
  return { ok: true };
});

/** 系统通知（后台会话完成等） */
ipcMain.handle("app:notify", async (_e, { title, body, sessionId } = {}) => {
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
ipcMain.handle("app:checkUpdate", async () => {
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
