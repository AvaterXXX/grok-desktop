#!/usr/bin/env electron
/**
 * Render README screenshots from the real UI with *fabricated* content.
 *
 * Nothing here touches the Grok home directory, the user's sessions, or the
 * CLI. `index.html` is loaded with a fake `grokDesktop` bridge installed before
 * app.js runs, so the shipping renderer paints invented conversations. That is
 * strictly safer than screenshotting a live window and blurring it afterwards:
 * no real text ever reaches a pixel.
 */
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const root = path.resolve(__dirname, "..");
const outputDir = path.resolve(
  process.env.GROK_SHOT_OUTPUT || path.join(root, "docs", "screenshots"),
);
// Chromium cannot mkdtemp under %TEMP% when it is started from this sandbox,
// so the scratch profile lives beside the project instead.
const userData = path.join(root, ".shots-profile");
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-gpu");

const WIDTH = 1440;
const HEIGHT = 900;

/** Invented sessions — names, paths and text are all made up. */
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const SESSIONS = [
  {
    id: "8f2c1a40-1111-4aaa-9bbb-000000000001",
    cwd: "C:\\work\\nebula-api",
    title: "给 nebula-api 加限流",
    summary: "给 nebula-api 加限流",
    updatedAt: iso(3),
    createdAt: iso(600),
    numMessages: 14,
  },
  {
    id: "8f2c1a40-2222-4aaa-9bbb-000000000002",
    cwd: "C:\\work\\nebula-api",
    title: "修 OAuth 回调偶发 502",
    summary: "修 OAuth 回调偶发 502",
    updatedAt: iso(48),
    createdAt: iso(900),
    numMessages: 22,
  },
  {
    id: "8f2c1a40-3333-4aaa-9bbb-000000000003",
    cwd: "C:\\work\\pixel-forge",
    title: "把导出改成增量写入",
    summary: "把导出改成增量写入",
    updatedAt: iso(180),
    createdAt: iso(1500),
    numMessages: 9,
  },
  {
    id: "8f2c1a40-4444-4aaa-9bbb-000000000004",
    cwd: "C:\\work\\pixel-forge",
    title: "迁移到 pnpm workspace",
    summary: "迁移到 pnpm workspace",
    updatedAt: iso(1500),
    createdAt: iso(3000),
    numMessages: 31,
  },
  {
    id: "8f2c1a40-5555-4aaa-9bbb-000000000005",
    cwd: "C:\\work\\docs-site",
    title: "重写 Getting Started",
    summary: "重写 Getting Started",
    updatedAt: iso(2900),
    createdAt: iso(5000),
    numMessages: 6,
  },
];

const ACTIVE = "8f2c1a40-1111-4aaa-9bbb-000000000001";

const THOUGHT = `用户要的是按 API key 限流，不是按 IP。先看看现有中间件怎么挂的，别自己造一套。

需要确认三件事：
1. 现在有没有现成的中间件链
2. 计数器放内存还是放 Redis
3. 超限返回什么`;

const ANSWER = `看完了。现有中间件链在 \`src/app.ts\`，我按 key 维度加了一层，计数放 Redis（部署是 3 副本，放内存会翻三倍）。

改了三个文件：

- \`src/middleware/rate-limit.ts\` — 新增，滑动窗口
- \`src/app.ts\` — 挂到鉴权之后
- \`src/config.ts\` — 加 \`RATE_LIMIT_RPS\`，默认 20

关键一点：限流要挂在鉴权**之后**，否则拿不到 key。超限返回 429 带 \`Retry-After\`，客户端能自己退避。`;

const DIFF = {
  path: "C:\\work\\nebula-api\\src\\middleware\\rate-limit.ts",
  relativePath: "src/middleware/rate-limit.ts",
  dir: "C:\\work\\nebula-api\\src\\middleware",
  basename: "rate-limit.ts",
  exists: false,
  title: "Write",
  status: "completed",
  stats: { added: 12, deleted: 0 },
  hunks: [
    { type: "meta", text: "— 新文件 —" },
    { type: "add", text: "export function rateLimit(opts: RateLimitOptions) {" },
    { type: "add", text: "  return async (req, res, next) => {" },
    { type: "add", text: "    const key = req.auth?.apiKeyId;" },
    { type: "add", text: "    if (!key) return next();" },
    { type: "add", text: "    const { allowed, retryAfter } = await window(key, opts);" },
    { type: "add", text: "    if (!allowed) {" },
    { type: "add", text: "      res.setHeader('Retry-After', retryAfter);" },
    { type: "add", text: "      return res.status(429).json({ error: 'rate_limited' });" },
    { type: "add", text: "    }" },
    { type: "add", text: "    next();" },
    { type: "add", text: "  };" },
    { type: "add", text: "}" },
  ],
  truncated: { lines: false, fileTooLarge: false },
  sessionId: ACTIVE,
};

const MESSAGES = [
  { role: "user", text: "nebula-api 现在谁都能无限打，帮我按 key 加个限流", at: iso(9) },
  { role: "thought", text: THOUGHT, at: iso(8) },
  {
    role: "tool",
    tool: {
      title: "搜索 rate limit",
      kind: "search",
      status: "completed",
      output: "3 个匹配：src/app.ts、src/middleware/、docs/deploy.md",
    },
    at: iso(7),
  },
  {
    role: "tool",
    tool: { title: "读取 src/app.ts", kind: "read", status: "completed", output: "142 行" },
    at: iso(6),
  },
  {
    role: "tool",
    tool: { title: "编辑 src/middleware/rate-limit.ts", kind: "edit", status: "completed" },
    fileChange: DIFF,
    at: iso(4),
  },
  { role: "assistant", text: ANSWER, at: iso(3) },
];

const USAGE = {
  ok: true,
  percent: 6,
  reset: "周五 10/23 18:50",
  resetAt: "2026-10-23T10:50:05Z",
  subscriptionTier: "SuperGrok Heavy",
  raw: "周限额 6% · 刷新 周五 10/23 18:50",
  source: "acp",
  weekTokens: 50_168_199,
  weekInput: 49_681_022,
  weekOutput: 410_311,
  weekCache: 46_174_336,
  weekReasoning: 76_866,
  weekByModel: {},
  dailyTokens: 34_004_359,
  dailyInput: 33_400_000,
  dailyOutput: 290_000,
  dailyCache: 30_100_000,
  dailyReasoning: 54_000,
  dailyByModel: {},
  history: {},
  speed: { generated: 1_574_340, ms: 11_886_930, calls: 1056, sessions: 14, rate: 132.4 },
  turn: 4,
};

const MODELS = {
  currentModelId: "grok-4.7-build-fast",
  availableModels: [
    { modelId: "grok-4.7-build-fast", name: "Grok 4.7 Fast" },
    { modelId: "grok-4.7-build", name: "Grok 4.7" },
    { modelId: "grok-4.6-build", name: "Grok 4.6" },
  ],
};

const SETTINGS = {
  desktop: {
    theme: "light",
    palette: "paper",
    locale: "zh",
    localeChosen: true,
    density: "comfortable",
    showThinking: true,
    accessMode: "full",
    enterToSend: true,
    experienceMemory: true,
    notifyOnDone: true,
    appIcon: "new",
    // The first-run setup sheet would cover the whole shot.
    setupDismissed: true,
    trayHintShown: true,
    proxyEnabled: false,
    proxyUrl: "",
    profileNickname: "",
    dailyUsage: USAGE,
    dailyHistory: {},
    weekUsage: {},
    lastBilling: { percent: 6, reset: USAGE.reset, resetAt: USAGE.resetAt },
    openTabs: [ACTIVE],
    lastActiveId: ACTIVE,
  },
  grok: { defaultModel: "grok-4.7-build-fast", permissionMode: "default", autoUpdate: true },
  grokHome: "C:\\Users\\demo\\.grok",
  desktopSettingsPath: "C:\\Users\\demo\\AppData\\Roaming\\grok-desktop\\settings.json",
  models: { models: [], defaultModel: "grok-4.7-build-fast" },
};

const SESSION_META = {
  id: ACTIVE,
  cwd: "C:\\work\\nebula-api",
  title: "给 nebula-api 加限流",
  model: "grok-4.7-build-fast",
  effort: "xhigh",
  updatedAt: iso(3),
};

/**
 * Injected into the renderer before app.js; implements only what the boot path
 * calls. Everything arrives through `data` so this function stays a plain
 * top-level function with no hidden globals — it is stringified and evaluated
 * in the page, never called here.
 */
function installFakeBridge(data) {
  const { sessions, active, usage, models, settings, meta, messages } = data;
  const noop = () => {};
  const off = () => () => {};
  const clone = (v) => JSON.parse(JSON.stringify(v));
  globalThis.grokDesktop = {
    platform: "win32",
    listSessions: async () => clone(sessions),
    loadHistory: async () => ({
      session: clone(meta),
      messages: clone(messages),
      assets: [],
      ui: {},
    }),
    openSession: async () => ({ ok: true, session: clone(meta), models: clone(models) }),
    activateSession: async () => ({ ok: true, session: clone(meta), openIds: [active] }),
    newSession: async () => ({ ok: true, session: clone(meta), models: clone(models) }),
    listCommands: async () => ({ commands: [] }),
    listModels: async () => clone(models),
    setModel: async () => ({ ok: true }),
    setEffort: async () => ({ ok: true }),
    sessionUsage: async () => ({ ok: true, used: 126_153, size: 500_000, modelId: meta.model }),
    accountUsage: async () => clone(usage),
    accountProfile: async () => ({ loggedIn: true, email: "", name: "", userId: "" }),
    appInfo: async () => ({
      grokCli: "grok",
      grokHome: "C:\\Users\\demo\\.grok",
      desktopVersion: "0.2.5",
      cliVersion: "1.0.63",
    }),
    getSettings: async () => clone(settings),
    saveDesktopSettings: async () => clone(settings.desktop),
    saveGrokSettings: async () => ({}),
    saveSessionUi: async () => ({ ok: true }),
    saveSessionGoal: async () => ({ ok: true }),
    listWallpapers: async () => [],
    listAgents: async () => ({ openIds: [active] }),
    isOccluded: async () => false,
    // A diagnostics payload without cliExists re-opens the first-run setup sheet.
    diagnose: async () => ({
      ok: true,
      cliExists: true,
      cliPath: "C:\\Users\\demo\\AppData\\Roaming\\npm\\grok.cmd",
      cliVersion: "1.0.63",
      loggedIn: true,
      grokHome: "C:\\Users\\demo\\.grok",
      desktopVersion: "0.2.5",
    }),
    listMemory: async () => ({ files: [] }),
    listHooks: async () => ({ hooks: [], roots: [] }),
    listInstalledPlugins: async () => [],
    listAvailablePlugins: async () => [],
    listSkills: async () => [],
    setBusyCount: async () => ({ ok: true }),
    flashFrame: noop,
    notify: noop,
    openExternal: noop,
    openPath: noop,
    showItem: noop,
    openWorkspaceCli: noop,
    readImage: async () => null,
    previewFile: async () => ({ ok: false }),
    describeFilePaths: async () => [],
    getPathForFile: () => "",
    respondPermission: async () => ({ ok: true }),
    setAutoApprove: async () => ({ ok: true }),
    exportSession: async () => ({ ok: true, path: "transcript.md" }),
    copySessionMarkdown: async () => ({ ok: true, chars: 12_345 }),
    runSlash: async () => ({ ok: true }),
    checkUpdate: async () => ({ ok: true }),
    offerCliUpdate: async () => ({ ok: true }),
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

async function render(window, { file, w, h, after }) {
  window.setContentSize(w, h);
  await window.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  );
  if (after) {
    try {
      await window.webContents.executeJavaScript(after);
    } catch (error) {
      // The generic Electron message hides the actual renderer error; re-run
      // the same source under a try/catch so the console tells us what broke.
      const detail = await window.webContents.executeJavaScript(
        `(() => { try { (${after}); return "ok"; } catch (e) { return e.stack || String(e); } })()`,
      );
      throw new Error(`after() failed for ${file}: ${detail}`, { cause: error });
    }
  }
  await window.webContents.executeJavaScript(
    `new Promise(r => setTimeout(() => requestAnimationFrame(r), 350))`,
  );
  const image = await window.webContents.capturePage();
  if (image.isEmpty()) throw new Error("empty capture");
  fs.writeFileSync(path.join(outputDir, file), image.toPNG());
  const { width, height } = image.getSize();
  console.log(`${file}  ${width}x${height}  ${(image.toPNG().length / 1024).toFixed(0)} KB`);
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(outputDir, { recursive: true });

  const preloadPath = path.join(userData, "fake-bridge.js");
  const fakeData = {
    sessions: SESSIONS,
    active: ACTIVE,
    usage: USAGE,
    models: MODELS,
    settings: SETTINGS,
    meta: SESSION_META,
    messages: MESSAGES,
  };
  fs.writeFileSync(
    preloadPath,
    `(${installFakeBridge.toString()})(${JSON.stringify(fakeData)});`,
    "utf8",
  );

  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: WIDTH,
    height: HEIGHT,
    backgroundColor: "#f6f3ed",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  await window.loadFile(path.join(root, "renderer", "index.html"));
  await window.webContents.executeJavaScript(
    `(() => {
       localStorage.setItem('gd-theme', 'light');
       localStorage.setItem('gd-palette', 'paper');
     })()`,
  );
  await window.reload();
  await window.webContents.executeJavaScript(
    `new Promise(r => setTimeout(() => requestAnimationFrame(r), 2500))`,
  );

  const hasStream = await window.webContents.executeJavaScript(
    `!!document.querySelector('.turn.assistant .body, .turn.user')`,
  );
  if (!hasStream) throw new Error("thread did not render — fake bridge may be incomplete");

  await render(window, { file: "01-overview.png", w: WIDTH, h: HEIGHT });

  await render(window, {
    file: "02-usage-and-speed.png",
    w: 1180,
    h: 300,
    after: `(() => {
      document.querySelector('#app-chrome').style.outline = '2px solid #6366f1';
      document.querySelector('#app-chrome').style.outlineOffset = '-2px';
    })()`,
  });

  await render(window, {
    file: "03-call-collaboration.png",
    w: WIDTH,
    h: HEIGHT,
    after: `(() => {
      // The renderer swaps in per-session panes, so the live pane is whichever
      // .thread-inner the thread currently holds — not the original id.
      const pane = document.querySelector('#thread .thread-inner') ||
                   document.querySelector('.thread-inner') ||
                   document.querySelector('#thread');
      if (!pane) throw new Error('no live thread pane');
      const card = document.createElement('div');
      card.className = 'call-card watching';
      const top = document.createElement('div');
      top.className = 'cc-top';
      const tag = document.createElement('span');
      tag.className = 'cc-tag';
      tag.textContent = '等待线程';
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'cc-jump';
      jump.textContent = '修 OAuth 回调偶发 502 · Grok 4.7';
      const clock = document.createElement('span');
      clock.className = 'cc-clock';
      clock.textContent = '耗时 42秒';
      top.append(tag, jump, clock);
      const task = document.createElement('div');
      task.className = 'cc-task';
      task.textContent = '把回调里的重复写入去掉，返回 302 前先落库一次';
      const ul = document.createElement('ul');
      ul.className = 'cc-log';
      for (const line of ['已派出，正在对方会话里跑', '对方还在跑，等它空出来']) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      }
      card.append(top, task, ul);
      pane.appendChild(card);
      card.scrollIntoView({ block: 'center' });
    })()`,
  });

  await render(window, {
    file: "04-dark.png",
    w: WIDTH,
    h: HEIGHT,
    after: `(() => {
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');
      document.documentElement.style.colorScheme = 'dark';
    })()`,
  });

  window.destroy();
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error.stack || error.message);
    app.exit(1);
  });

app.once("will-quit", () => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    /* temporary */
  }
});
