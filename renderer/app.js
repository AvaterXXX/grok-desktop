/**
 * Grok Desktop 0.6 — product shell
 * Views: chat | memory | skills | plugins | settings
 * Features: multi-agent tabs, diff cards, content search, plan panel
 */

const $ = (id) => document.getElementById(id);
const slashCatalog = globalThis.GrokSlashCatalog || {};
const a11y = globalThis.GrokA11y || {};
const {
  mapAssetsToMessageIndex,
  tailHistoryFrom,
} = globalThis.GrokHistoryModel;
const {
  buildPromptWithFiles,
  fileBasename,
  formatSendError,
  formatWaitClock,
  looksLikeImageFile,
  parseAttachText,
  parseCallSession,
  unwrapGoalWrap,
} = globalThis.GrokComposerModel;
const { groupSessionsByProject, moveKey } = globalThis.GrokSidebarModel;
const {
  canAppendAssistantChunk,
  canAppendThoughtChunk,
  createStreamBuffer,
  drainStreamSegments,
  enqueueStreamSegment,
  finalizeThoughtText,
  hasPendingStream,
  pendingStreamLength,
  shouldIgnoreOrphanStreamChunk,
} = globalThis.GrokStreamModel;

function syncModalInert() {
  const appRoot = document.getElementById("app");
  if (!appRoot) return;
  const modalOpen = !!document.querySelector(
    ".app-modal:not(.hidden), .setup-overlay:not(.hidden)",
  );
  appRoot.inert = modalOpen;
}

// Mark the host platform before the first render so platform-specific chrome applies.
(function applyPlatformClass() {
  try {
    const platform = (typeof grokDesktop !== "undefined" && grokDesktop.platform) || "";
    if (platform) document.body.classList.add(`platform-${platform}`);
    if (platform === "darwin") {
      document.querySelectorAll("kbd.mod-key").forEach((el) => {
        el.textContent = "⌘";
      });
    }
  } catch {
    /* ignore */
  }
})();

/**
 * Electron does NOT support window.prompt (always returns null).
 * Use this in-app modal for text input / confirms.
 * @returns {Promise<string|null>} null if cancelled; string (may be empty) if OK with input;
 *          for confirm-only mode returns "1" on OK and null on cancel.
 */
function askModal({
  title = "提示",
  message = "",
  defaultValue = "",
  placeholder = "",
  okLabel = "确定",
  cancelLabel = "取消",
  input = true,
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const root = $("app-modal");
    const titleEl = $("app-modal-title");
    const msgEl = $("app-modal-msg");
    const inputEl = $("app-modal-input");
    const okBtn = $("app-modal-ok");
    const cancelBtn = $("app-modal-cancel");
    const priorFocus = document.activeElement;
    if (!root || !okBtn) {
      // fallback — still broken for prompt, but avoid crash
      if (input) resolve(window.prompt(message || title, defaultValue));
      else resolve(window.confirm(message || title) ? "1" : null);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      root.classList.add("hidden");
      root.setAttribute("aria-hidden", "true");
      syncModalInert();
      document.removeEventListener("keydown", onKey, true);
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      root.querySelectorAll("[data-modal-cancel]").forEach((el) => {
        el.onclick = null;
      });
      a11y.restoreFocus?.(priorFocus);
      resolve(value);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && (!input || document.activeElement === inputEl)) {
        e.preventDefault();
        e.stopPropagation();
        finish(input ? String(inputEl.value ?? "") : "1");
      } else if (e.key === "Tab") {
        a11y.trapTabKey?.(root, e);
      }
    };

    titleEl.textContent = title;
    msgEl.textContent = message || "";
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle("danger", !!danger);
    okBtn.classList.toggle("primary", !danger);

    if (input) {
      inputEl.classList.remove("hidden");
      inputEl.value = defaultValue ?? "";
      inputEl.placeholder = placeholder || "";
    } else {
      inputEl.classList.add("hidden");
      inputEl.value = "";
    }

    root.classList.remove("hidden");
    root.setAttribute("aria-hidden", "false");
    syncModalInert();
    okBtn.onclick = () => finish(input ? String(inputEl.value ?? "") : "1");
    const cancel = () => finish(null);
    cancelBtn.onclick = cancel;
    root.querySelectorAll("[data-modal-cancel]").forEach((el) => {
      el.onclick = cancel;
    });
    document.addEventListener("keydown", onKey, true);

    requestAnimationFrame(() => {
      if (input) {
        inputEl.focus();
        inputEl.select();
      } else {
        okBtn.focus();
      }
    });
  });
}

async function askText(opts) {
  const v = await askModal({ ...opts, input: true });
  if (v == null) return null;
  const t = String(v).trim();
  return t || null;
}

async function askConfirm(opts) {
  const v = await askModal({
    okLabel: "确定",
    cancelLabel: "取消",
    ...opts,
    input: false,
  });
  return v != null;
}

const ui = {
  list: $("session-list"),
  search: $("search"),
  searchHits: $("search-hits"),
  sessionSection: $("session-section"),
  thread: $("thread"),
  inner: $("thread-inner"),
  pinnedPrompt: $("pinned-prompt"),
  pinnedPromptBtn: $("pinned-prompt-btn"),
  pinnedPromptText: $("pinned-prompt-text"),
  input: $("input"),
  send: $("btn-send"),
  cancel: $("btn-cancel"),
  fileBtn: $("btn-file"),
  attachPreview: $("attach-preview"),
  queueBar: $("queue-bar"),
  subagentBar: $("subagent-bar"),
  contextChips: $("context-chips"),
  slashMenu: $("slash-menu"),
  liveStrip: $("live-strip"),
  stripModel: $("strip-model"),
  stripEffort: $("strip-effort"),
  stripTime: $("strip-time"),
  stripDuration: $("strip-duration"),
  stripDurSep: $("strip-dur-sep"),
  stripCwd: $("strip-cwd"),
  stripCodebase: $("strip-codebase"),
  stripCodeSep: $("strip-code-sep"),
  stripQueue: $("strip-queue"),
  planPanel: $("plan-panel"),
  planList: $("plan-list"),
  planToggle: $("btn-plan-toggle"),
  planClose: $("btn-plan-close"),
  subagentToggle: $("btn-subagent-toggle"),
  subagentClose: $("btn-subagent-close"),
  subagentPanel: $("subagent-panel"),
  subagentList: $("subagent-list"),
  navSettings: $("nav-settings"),
  modelBtn: $("btn-model"),
  modelLabel: $("model-label"),
  modelPop: $("model-popover"),
  modelSub: $("model-sub"),
  effortBtn: $("btn-effort"),
  effortLabel: $("effort-label"),
  effortPop: $("effort-popover"),
  modeBtn: $("btn-mode"),
  modeLabel: $("mode-label"),
  modePop: $("mode-popover"),
  settingsBack: $("settings-back"),
  settingsSearch: $("settings-search"),
  refresh: $("btn-refresh"),
  neu: $("btn-new"),
  title: $("chat-title"),
  sub: $("chat-sub"),
  status: $("status-pill"),
  cliInfo: $("cli-info"),
  openCmd: $("btn-open-cmd"),
  cwdChip: $("cwd-chip"),
  ctxChip: $("ctx-chip"),
  ctxChipLabel: $("ctx-chip-label"),
  sessionActions: $("session-actions"),
  rename: $("btn-rename"),
  del: $("btn-delete"),
  skillsList: $("skills-list"),
  skillDetail: $("skill-detail"),
  memoryList: $("memory-list"),
  memoryDetail: $("memory-detail"),
  memoryEnabled: $("memory-enabled"),
  pluginsInstalled: $("plugins-installed"),
  pluginsMarket: $("plugins-market"),
  pluginSpec: $("plugin-install-spec"),
  settingsMsg: $("settings-msg"),
};

const PAGE = 40; // fallback window; always keep last user turn + after it
const CLAMP = 2400;
/** Soft cap: older tool/diff details stay collapsed & lazy */
const MAX_OPEN_DIFFS = 1;
/** Only one expanded tool card at a time — long agent runs stay scrollable. */
const MAX_OPEN_TOOLS = 1;

function schedulePinThreadToBottom() {
  threadFollowBottom = true;
  pinThreadToBottom();
  requestAnimationFrame(() => {
    if (threadFollowBottom) pinThreadToBottom();
    refreshPinnedPrompt();
  });
  const again = () => {
    if (threadFollowBottom) pinThreadToBottom();
  };
  setTimeout(again, 60);
  setTimeout(again, 280);
  const el = ui.thread;
  if (!el) return;
  el.querySelectorAll("img").forEach((img) => {
    if (img.complete) return;
    img.addEventListener(
      "load",
      () => {
        if (threadFollowBottom) pinThreadToBottom();
      },
      { once: true },
    );
  });
}

let view = "chat";
let sessions = [];
let activeId = null;
let activeMeta = null;
let lastUsedCwd = null;

let connecting = false;
let openSeq = 0;
const collapsed = new Set();
let sessionHistory = [];
let historyFrom = 0;
let pendingImages = [];
/** @type {Array<{path:string,name:string,preview?:string}>} */
let pendingFiles = [];
/** @type {Array<{text:string,images:any[],files:any[]}>} */
let messageQueue = [];
let desktopSettings = {
  showThinking: true,
  enterToSend: true,
  density: "comfortable",
  theme: "dark",
  palette: "paper",
  autoApprove: true,
  openTabs: [],
  lastActiveId: null,
  wallpaper: "none",
  wallpaperPath: null,
  wallpaperDim: 45,
  notifyOnDone: true,
  experienceMemory: true,
  closeToTray: true,
  minimizeToTray: false,
  openAtLogin: false,
  checkUpdates: true,
  setupDismissed: false,
  locale: "zh",
  accessMode: "full",
  archivedSessionIds: [],
  pinnedSessionIds: [],
  proxyUrl: "",
  proxyEnabled: false,
  profileNickname: "",
  profileAvatar: "",
  profileAvatarUrl: "",
};


const __bootT0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
function bootMark(name) {
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const ms = Math.round(now - __bootT0);
  console.log("[boot +" + ms + "ms]", name);
  try { grokDesktop?.log?.("[boot +" + ms + "ms] " + name); } catch { /* ignore */ }
}
function archivedSet() {
  return new Set(
    Array.isArray(desktopSettings.archivedSessionIds) ? desktopSettings.archivedSessionIds : [],
  );
}
function pinnedSet() {
  return new Set(
    Array.isArray(desktopSettings.pinnedSessionIds) ? desktopSettings.pinnedSessionIds : [],
  );
}
function isArchived(id) {
  return archivedSet().has(id);
}
function isPinned(id) {
  return pinnedSet().has(id);
}

async function persistSessionLists(partial) {
  try {
    desktopSettings = {
      ...desktopSettings,
      ...(await grokDesktop.saveDesktopSettings(partial)),
    };
  } catch {
    Object.assign(desktopSettings, partial);
  }
}

async function toggleArchiveSession(id) {
  const set = archivedSet();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  const archivedSessionIds = [...set];
  // archiving unpins
  let pinnedSessionIds = [...pinnedSet()];
  if (set.has(id)) pinnedSessionIds = pinnedSessionIds.filter((x) => x !== id);
  await persistSessionLists({ archivedSessionIds, pinnedSessionIds });
  renderSidebar(ui.search?.value || "");
  flashToast(set.has(id) ? "已归档" : "已取消归档");
}

async function togglePinSession(id) {
  const set = pinnedSet();
  if (set.has(id)) set.delete(id);
  else {
    set.add(id);
    // pin removes from archive for visibility
    const arch = archivedSet();
    if (arch.has(id)) {
      arch.delete(id);
      await persistSessionLists({
        pinnedSessionIds: [...set],
        archivedSessionIds: [...arch],
      });
      renderSidebar(ui.search?.value || "");
      flashToast("已置顶");
      return;
    }
  }
  await persistSessionLists({ pinnedSessionIds: [...set] });
  renderSidebar(ui.search?.value || "");
  flashToast(set.has(id) ? "已置顶" : "已取消置顶");
}

function flashToast(msg) {
  let el = document.getElementById("toast-flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-flash";
    el.className = "toast-flash";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-atomic", "true");
    document.body.appendChild(el);
  }
  el.textContent = msg || "";
  el.classList.add("show");
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => el.classList.remove("show"), 1600);
}

async function copyText(text) {
  const s = String(text || "");
  if (!s) throw new Error("无内容可复制");
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** @returns {"safe"|"balanced"|"full"} */
function normalizeAccessMode(mode) {
  if (mode === "safe" || mode === "balanced" || mode === "full") return mode;
  return "full";
}

/** Map product access mode → desktop autoApprove + grok permission_mode / yolo */
function accessModeToSettings(mode, yolo = false) {
  const m = normalizeAccessMode(mode);
  if (m === "safe") {
    return { accessMode: "safe", autoApprove: false, permissionMode: "ask", yolo: false };
  }
  if (m === "balanced") {
    return { accessMode: "balanced", autoApprove: true, permissionMode: "default", yolo: false };
  }
  return {
    accessMode: "full",
    autoApprove: true,
    permissionMode: "always-approve",
    yolo: !!yolo,
  };
}

function deriveAccessMode(desk = {}, grok = {}) {
  if (desk.accessMode === "safe" || desk.accessMode === "balanced" || desk.accessMode === "full") {
    return desk.accessMode;
  }
  if (desk.autoApprove === false || grok.permissionMode === "ask") return "safe";
  if (grok.yolo || grok.permissionMode === "always-approve") return "full";
  return "balanced";
}

function updateAccessChip() {
  const el = $("strip-access");
  if (!el) return;
  const mode = normalizeAccessMode(desktopSettings.accessMode);
  el.className = "access-chip mode-" + mode;
  el.textContent = t("access.badge." + mode);
  el.title = t("access." + mode + "Desc");
}

function setAccessModeUi(mode) {
  const m = normalizeAccessMode(mode);
  desktopSettings.accessMode = m;
  document.querySelectorAll("#access-mode-cards .mode-card").forEach((card) => {
    const on = card.getAttribute("data-mode") === m;
    card.classList.toggle("active", on);
    card.setAttribute("aria-checked", on ? "true" : "false");
  });
  const yoloRow = $("yolo-row");
  if (yoloRow) yoloRow.style.display = m === "full" ? "" : "none";
  // legacy hidden fields
  const mapped = accessModeToSettings(m, !!$("set-yolo")?.checked);
  if ($("set-permission")) $("set-permission").value = mapped.permissionMode;
  if ($("set-auto-approve")) {
    // checkbox may have been replaced by hidden input
    const el = $("set-auto-approve");
    if (el.type === "checkbox") el.checked = mapped.autoApprove;
    else el.value = mapped.autoApprove ? "1" : "0";
  }
  updateAccessChip();
  paintComposerAccess();
}

function applyLocale(loc, { persist } = {}) {
  const next = loc === "en" ? "en" : "zh";
  if (window.GrokI18n) GrokI18n.setLocale(next);
  desktopSettings.locale = next;
  if (window.GrokI18n) GrokI18n.applyI18n(document);
  // re-render dynamic bits that aren't data-i18n
  if (activeMeta) applyHeader(activeMeta, { soft: true });
  else if (ui.cwdChip) ui.cwdChip.textContent = t("chat.noCwd");
  updateAccessChip();
  if (activeId) {
    const st = sessionUi.get(activeId);
    renderPlan(st?.plan || null);
  } else {
    // welcome titles if present
    if (ui.title && !activeId) {
      ui.title.textContent = t("chat.welcomeTitle");
      if (ui.sub) ui.sub.textContent = t("chat.welcomeSub");
    }
  }
  setAccessModeUi(desktopSettings.accessMode);
  if (persist) {
    void grokDesktop.saveDesktopSettings({ locale: next }).catch(() => {});
  }
  refreshTurnWho();
}
/** 刚跑完、尚未点开的会话（左侧绿点） */
/** @type {Set<string>} */
const doneSessions = new Set();
/** 曾经进入过 working 的会话，用于区分「真正结束」 */
/** @type {Set<string>} */
const everWorkedSessions = new Set();
/** Last search query used for thread highlight */
let lastSearchQuery = "";
let contentSearchSeq = 0;
let persistTabsTimer = null;
/** Session id for open context menu */
let ctxSessionId = null;
let seenMedia = new Set();
/** @type {Array<object>} */
let slashCommands = [];
function localSlashCatalog() {
  try {
    const list = slashCatalog.localizeAll?.([]);
    if (Array.isArray(list) && list.length) return list;
  } catch {
    /* ignore */
  }
  return [];
}
function seedSlashCatalog() {
  if (!slashCommands.length) slashCommands = localSlashCatalog();
}

function adoptSlashCommands(list) {
  const incoming = Array.isArray(list) ? list : [];
  try {
    if (typeof grokDesktop.mergeSlashCommands === "function") {
      slashCommands = grokDesktop.mergeSlashCommands(incoming);
      return slashCommands;
    }
  } catch {
    /* ignore */
  }
  const map = new Map();
  for (const c of localSlashCatalog()) {
    if (c?.name) map.set(c.name, c);
  }
  for (const c of incoming) {
    if (!c?.name) continue;
    map.set(c.name, { ...(map.get(c.name) || {}), ...c });
  }
  slashCommands = [...map.values()];
  return slashCommands;
}
let slashFiltered = [];
let slashIndex = 0;
let slashOpen = false;
let availableModels = [];
let currentModelId = null;
let modelOpen = false;
let effortOpen = false;
let modeOpen = false;
/** @type {"goal"|"task"|"plan"} */
let composerMode = "task";
let currentEffort = "xhigh";
const DEFAULT_EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];
let effortOptions = DEFAULT_EFFORTS.map((e) => ({ ...e }));
let modelSubKind = null;

/** Open session tabs (parallel agents). */
/** @type {string[]} */
let openTabs = [];
/** Live agent session ids from main process. */
/** @type {Set<string>} */
let liveAgents = new Set();
/** Per-session busy flag for tab indicators. */
/** @type {Set<string>} */
let workingSessions = new Set();
/** 本轮 prompt 尚未返回（比 status 事件更可靠，避免中途误判为空闲导致插不进去） */
/** @type {Set<string>} */
const promptInFlight = new Set();
/** 发送代数：打断后旧的 sendNow finally 不再 flush/改状态 */
const sendGenerations = new Map();

function currentSendGeneration(sessionId) {
  return sendGenerations.get(sessionId) || 0;
}

function nextSendGeneration(sessionId) {
  const next = currentSendGeneration(sessionId) + 1;
  sendGenerations.set(sessionId, next);
  return next;
}
/** Detached thread panes per session so parallel streams stay intact. */
/** @type {Map<string, HTMLElement>} */
const threadPanes = new Map();
/** Per-session logical model + renderer-owned view state. */
const sessionStore = new GrokSessionState.SessionStore(createSessionViewState);
const sessionUi = sessionStore.states;
/** Plan panel open state. */
let planOpen = false;
/** Debounce timer for content search. */
let searchTimer = null;
let settingsPanel = "profile";

// ── utils ──────────────────────────────────────────────

function projectName(s) {
  if (!s?.cwd) return "其他";
  const parts = String(s.cwd).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || s.cwd;
}

function uiLocale() {
  try {
    return window.GrokI18n?.getLocale?.() || desktopSettings?.locale || "zh";
  } catch {
    return "zh";
  }
}

function timeApi() {
  return globalThis.GrokTime || window.GrokTime || null;
}

/** Mac-style absolute time (月日 时:分). Falls back if time-format.js missing. */
function formatAbsoluteTime(iso) {
  const api = timeApi();
  if (api?.formatAbsoluteTime) return api.formatAbsoluteTime(iso, { locale: uiLocale() });
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatFullDateTime(iso) {
  const api = timeApi();
  if (api?.formatFullDateTime) return api.formatFullDateTime(iso, { locale: uiLocale() });
  return formatAbsoluteTime(iso);
}

function formatDuration(ms, opts) {
  const api = timeApi();
  if (api?.formatDuration) return api.formatDuration(ms, { locale: uiLocale(), ...(opts || {}) });
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function formatElapsedClock(ms) {
  const api = timeApi();
  if (api?.formatElapsedClock) return api.formatElapsedClock(ms);
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** @deprecated relative labels — prefer formatAbsoluteTime */
function relativeTime(iso) {
  return formatAbsoluteTime(iso);
}

/** Per-session run timing for live duration */
const runStartedAt = new Map();
const lastRunDurationMs = new Map();
let runTickTimer = null;

function compactStatusLine() {
  return uiLocale() === "en" ? "Compacting context" : "正在压缩上下文";
}

function looksLikeCompact(raw) {
  return GrokToolPresentation.looksLikeCompact(raw);
}

function clearCompacting(sid) {
  const id = sid || activeId;
  if (!id) return;
  const st = ensureSessionUi(id);
  if (!st.compacting) return;
  st.compacting = false;
  if (id === activeId && (workingSessions.has(id) || promptInFlight.has(id))) {
    paintRunStatus(st.runLine && !/压缩上下文|Compacting context/i.test(st.runLine) ? st.runLine : (uiLocale() === "en" ? "Thinking…" : "正在思考"));
  }
}

function markCompacting(sid) {
  const id = sid || activeId;
  if (!id) return;
  const st = ensureSessionUi(id);
  st.compacting = true;
  const line = compactStatusLine();
  if (id === activeId) {
    paintRunStatus(line);
    setStatus("working", line);
  }
  setWaitStatus(id, line);
  refreshSidebarSessionState();
}

function markRunStart(sid, opts = {}) {
  if (!sid) return;
  runStartedAt.set(sid, Date.now());
  const st0 = ensureSessionUi(sid);
  if (st0) {
    st0.runningTools = new Set();
    st0.thoughtStartedAt = null;
    st0.thoughtWrap = null;
    st0.thoughtHost = null;
    st0.runLine = "";
    st0.runLineAt = Date.now();
    if (opts.compact) st0.compacting = true;
  }
  const line = opts.line || (opts.compact ? compactStatusLine() : (uiLocale() === "en" ? "Thinking…" : "正在思考"));
  if (sid === activeId) {
    paintRunStatus(line);
    if (opts.compact) setStatus("working", line);
  }
  if (opts.compact || opts.wait === "status") setWaitStatus(sid, line);
  else showTypingWait(sid);
  ensureRunTicker();
  renderSidebar(ui.search?.value || "");
}

function markRunEnd(sid) {
  if (!sid) return;
  const start = runStartedAt.get(sid);
  if (start != null) {
    lastRunDurationMs.set(sid, Math.max(0, Date.now() - start));
    runStartedAt.delete(sid);
  }
  if (!runStartedAt.size) stopRunTicker();
  settleSubagents(sid);
  const stEnd = sessionUi.get(sid);
  if (stEnd) {
    stEnd.compacting = false;
    stEnd.runningTools?.clear?.();
  }
  clearTypingWait(sid);
  if (sid === activeId) paintRunStatus();
  bumpContextUsage(sid);
  void refreshSessionUsage(sid);
}

function completedRunStatusDetail(sid, fallback = "已完成") {
  const dur = sid ? lastRunDurationMs.get(sid) : null;
  if (dur == null) return fallback;
  const label = formatDuration(dur);
  return uiLocale() === "en" ? `Done · ${label}` : `已完成 · 用时 ${label}`;
}

function ensureRunTicker() {
  if (runTickTimer) return;
  runTickTimer = setInterval(() => {
    if (!runStartedAt.size) {
      stopRunTicker();
      return;
    }
    refreshSidebarSessionState();
    if (activeId && runStartedAt.has(activeId)) {
      updateLiveStripDurationOnly();
      refreshWorkingStatusClock();
      const stLive = sessionUi.get(activeId);
      if (stLive?.thoughtWrap && stLive.thoughtStartedAt) {
        const live = stLive.thoughtWrap.querySelector(".thought-label");
        if (live) live.textContent = thoughtClockLabel(Date.now() - stLive.thoughtStartedAt);
      }
    }
  }, 1000);
}

function stopRunTicker() {
  if (runTickTimer) {
    clearInterval(runTickTimer);
    runTickTimer = null;
  }
}

function sessionWhenLabel(s, { working, done } = {}) {
  const en = uiLocale() === "en";
  if (working) {
    const start = runStartedAt.get(s?.id);
    if (sessionUi.get(s?.id)?.compacting) {
      const start = runStartedAt.get(s?.id);
      const clock = start != null ? " " + formatElapsedClock(Date.now() - start) : "";
      return en ? `Compacting${clock}` : `压缩中${clock}`;
    }
    if (start != null) {
      const clock = formatElapsedClock(Date.now() - start);
      return en ? `Running ${clock}` : `运行中 ${clock}`;
    }
    return en ? "Running" : "运行中";
  }
  if (done) {
    const dur = lastRunDurationMs.get(s?.id);
    if (dur != null) {
      const d = formatDuration(dur);
      return en ? `Done · ${d}` : `已完成 · ${d}`;
    }
    return en ? "Done" : "已完成";
  }
  return formatAbsoluteTime(s?.updatedAt);
}


async function openProjectFolder(cwd) {
  const dir = String(cwd || "").trim();
  if (!dir) return;
  try {
    if (typeof grokDesktop.openPath === "function") await grokDesktop.openPath(dir);
    else if (typeof grokDesktop.showItem === "function") await grokDesktop.showItem(dir);
    else throw new Error("没有打开目录的能力");
  } catch (err) {
    flashToast(err?.message || "打不开这个文件夹");
  }
}

function makeFileChipRow(files) {
  const row = document.createElement("div");
  row.className = "file-chips";
  for (const f of files || []) {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const path = f.path || f.name || "";
    chip.title = path;
    const ico = document.createElement("span");
    ico.className = "file-chip-ico";
    ico.textContent = "▤";
    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = f.name || fileBasename(path);
    chip.append(ico, name);
    row.appendChild(chip);
  }
  return row;
}

function paintRunStatus(line, opts = {}) {
  const bar = $("run-status");
  const txt = $("run-status-text");
  const sid = opts.sessionId || activeId;
  if (sid && sid !== activeId) return;
  const st = activeId ? ensureSessionUi(activeId) : null;
  const busyNow = !!(activeId && (workingSessions.has(activeId) || promptInFlight.has(activeId)));
  if (st?.compacting && busyNow && !opts.hide && !line) line = compactStatusLine();
  if (opts.hide || !busyNow || !st) {
    if (bar) {
      bar.classList.add("hidden");
      bar.hidden = true;
    }
    return;
  }
  if (line) {
    const next = String(line);
    if (next !== st.runLine) {
      st.runLine = next;
      st.runLineAt = Date.now();
    } else if (!st.runLineAt) {
      st.runLineAt = Date.now();
    }
  } else if (st.runLine && !st.runLineAt) {
    st.runLineAt = Date.now();
  }
  const thinking = /正在思考|Thinking/i.test(st.runLine || line || "");
  const start = thinking && st.thoughtStartedAt ? st.thoughtStartedAt : (st.runLineAt || Date.now());
  const clock = formatElapsedClock(Date.now() - start);
  const main = st.runLine || (uiLocale() === "en" ? "Thinking…" : "正在思考");
  const shown = main + " · " + clock;
  if (txt) txt.textContent = shown;
  if (bar) {
    bar.classList.remove("hidden");
    bar.hidden = false;
  }
  if (ui.status?.dataset?.state === "working") ui.status.textContent = shown;
}

function refreshWorkingStatusClock() {
  paintRunStatus();
}

function streamHasVisibleOutput(st) {
  const el = st?.streamingEl;
  if (el && String(el.textContent || "").trim()) return true;
  const sid = st && [...sessionUi.entries()].find(([, v]) => v === st)?.[0];
  const pane = typeof getPane === "function" ? getPane(sid || activeId) : ui.inner;
  if (!pane) return false;
  const lastUser = [...pane.querySelectorAll(":scope > .turn.user")].pop();
  let node = lastUser ? lastUser.nextElementSibling : pane.firstElementChild;
  while (node) {
    if (node.classList?.contains("typing-wait")) {
      node = node.nextElementSibling;
      continue;
    }
    const text = String(node.textContent || "").trim();
    if (node.classList?.contains("thought-block") && text) return true;
    if (node.classList?.contains("tool-card") || node.classList?.contains("tool-group")) return true;
    if (node.classList?.contains("turn") && node.classList.contains("assistant")) {
      const body = node.querySelector(":scope > .body");
      if (body && !body.classList.contains("typing-dots") && String(body.textContent || "").trim()) return true;
    }
    if (node.classList?.contains("subagent-turn")) return true;
    node = node.nextElementSibling;
  }
  return false;
}

function waitSidBusy(id) {
  return !!(id && (workingSessions.has(id) || promptInFlight.has(id)));
}

function paintWaitTurn(sid, { mode = "dots", text = "" } = {}) {
  const id = sid || activeId;
  if (!id) return;
  const st = ensureSessionUi(id);
  if (mode !== "hide" && streamHasVisibleOutput(st)) mode = "hide";
  if (mode === "hide") {
    if (st.typingEl?.parentNode) st.typingEl.parentNode.removeChild(st.typingEl);
    st.typingEl = null;
    return;
  }
  const pane = typeof getPane === "function" ? getPane(id) : ui.inner;
  if (!pane) return;
  let turn = st.typingEl;
  if (!turn || !turn.parentNode) {
    turn = document.createElement("div");
    turn.className = "turn assistant typing-wait";
    if (typeof makeTurnWho === "function") turn.appendChild(makeTurnWho("assistant"));
    const body = document.createElement("div");
    body.className = "body typing-dots";
    turn.appendChild(body);
    pane.querySelector(".welcome")?.remove();
    pane.appendChild(turn);
    st.typingEl = turn;
  } else if (turn.parentNode === pane) {
    pane.appendChild(turn);
  }
  const body = turn.querySelector(".body");
  if (!body) return;
  if (mode === "status" && text) {
    turn.classList.add("is-status");
    turn.classList.remove("is-dots");
    body.className = "body wait-status";
    body.textContent = text;
    body.setAttribute("aria-label", text);
  } else {
    turn.classList.add("is-dots");
    turn.classList.remove("is-status");
    body.className = "body typing-dots";
    body.innerHTML = "<i></i><i></i><i></i>";
    body.setAttribute("aria-label", uiLocale() === "en" ? "Waiting for reply" : "正在回复");
  }
  if (id === activeId) scrollThreadToBottom({ force: threadFollowBottom });
}

function runningToolCount(sid) {
  const st = sid ? sessionUi.get(sid) : null;
  return st?.runningTools ? st.runningTools.size : 0;
}

function noteToolRun(sid, payload, running) {
  const st = ensureSessionUi(sid);
  if (!st.runningTools) st.runningTools = new Set();
  const id = payload?.toolCallId || payload?.id;
  if (id) {
    if (running) st.runningTools.add(String(id));
    else st.runningTools.delete(String(id));
  }
  return st.runningTools.size;
}

function showTypingWait(sid) {
  const id = sid || activeId;
  if (!waitSidBusy(id) || runningToolCount(id)) return;
  if (streamHasVisibleOutput(ensureSessionUi(id))) return;
  paintWaitTurn(id, { mode: "dots" });
}

function setWaitStatus(sid, line) {
  if (!waitSidBusy(sid || activeId)) return;
  paintWaitTurn(sid, { mode: "status", text: line });
}

function clearTypingWait(sid) {
  paintWaitTurn(sid, { mode: "hide" });
}

function shortPath(p) {
  if (!p) return "未选择工作目录";
  if (p.startsWith("/home/")) {
    const rest = p.slice(6);
    const i = rest.indexOf("/");
    return i >= 0 ? "~/" + rest.slice(i + 1) : "~";
  }
  return p.length > 42 ? "…" + p.slice(-40) : p;
}

/** 状态栏文案统一中文（避免 CLI 英文状态直接露出来） */
function localizeStatus(state, detail) {
  const st = String(state || "idle").toLowerCase();
  const d = detail == null || detail === "" ? "" : String(detail);
  const en = typeof GrokI18n !== "undefined" && GrokI18n.getLocale() === "en";
  const stateMap = en
    ? {
        idle: "Ready",
        ready: "Ready",
        working: "Working…",
        connecting: "Connecting…",
        error: "Error",
        disconnected: "Disconnected",
      }
    : {
        idle: "就绪",
        ready: "就绪",
        working: "思考中…",
        connecting: "连接中…",
        error: "出错",
        disconnected: "已断开",
      };
  const detailMap = en
    ? {
        ready: "Ready",
        idle: "Ready",
        working: "Working…",
        connecting: "Connecting…",
        connected: "Connected",
        disconnected: "Disconnected",
        error: "Error",
        就绪: "Ready",
        已完成: "Done",
        思考中: "Working…",
        "思考中…": "Working…",
        "连接中…": "Connecting…",
        已连接: "Connected",
        已停止: "Stopped",
      }
    : {
        ready: "就绪",
        idle: "就绪",
        working: "思考中…",
        connecting: "连接中…",
        connected: "已连接",
        disconnected: "已断开",
        error: "出错",
        "agent 已关闭": "agent 已关闭",
      };
  if (!d) return stateMap[st] || stateMap.idle;
  const low = d.toLowerCase().trim();
  if (detailMap[low]) return detailMap[low];
  if (detailMap[d]) return detailMap[d];
  // 常见英文片段
  if (/^ready$/i.test(d)) return "就绪";
  if (/connecting|连接 agent/i.test(d) && /…|\.\.\./.test(d)) return d.replace(/连接 agent/i, "连接助手");
  if (/^connected$/i.test(d)) return "已连接";
  if (/reused|parallel/i.test(d)) return "已连接";
  return d;
}

function setStatus(state, detail) {
  const st = state || "idle";
  ui.status.dataset.state = st;
  ui.status.textContent = localizeStatus(st, detail);
}

/** True when this session's prompt is still in flight. Global `busy` / leftover status text must not leak across chats. */
function isAgentBusy(sessionId = activeId) {
  if (!sessionId) return false;
  if (promptInFlight.has(sessionId)) return true;
  if (workingSessions.has(sessionId)) return true;
  return false;
}

function refreshSendButtonState() {
  const canType = !!activeId;
  const agentBusy = isAgentBusy(activeId);
  const hasContent =
    !!ui.input?.value?.trim() || pendingImages.length > 0 || pendingFiles.length > 0;
  if (ui.input) ui.input.disabled = !canType;
  if (ui.fileBtn) ui.fileBtn.disabled = !canType;
  if (ui.modelBtn) ui.modelBtn.disabled = !canType || agentBusy;
  if (ui.effortBtn) ui.effortBtn.disabled = !canType || agentBusy;
  if (ui.send) {
    if (agentBusy && hasContent) {
      ui.send.disabled = false;
      ui.send.title = "加入队列";
      ui.send.setAttribute("aria-label", "加入队列");
      ui.send.classList.add("queue-mode");
      ui.send.classList.remove("stop-mode", "insert-ready");
    } else if (agentBusy) {
      ui.send.disabled = false;
      ui.send.title = "停止生成";
      ui.send.setAttribute("aria-label", "停止生成");
      ui.send.classList.add("stop-mode");
      ui.send.classList.remove("queue-mode", "insert-ready");
    } else {
      ui.send.disabled = !canType || connecting || !hasContent;
      ui.send.title = "发送";
      ui.send.setAttribute("aria-label", "发送");
      ui.send.classList.remove("stop-mode", "queue-mode", "insert-ready");
    }
  }
  if (ui.cancel) {
    ui.cancel.hidden = true;
    ui.cancel.disabled = true;
  }
  if (ui.input) {
    if (agentBusy && hasContent) {
      ui.input.placeholder = "生成中… Enter 加入队列，清空输入后点方块停止";
    } else if (agentBusy) {
      ui.input.placeholder = "生成中… 点停止可中断，输入后按钮变发送";
    } else if (composerMode === "goal") {
      ui.input.placeholder =
        typeof t === "function" ? t("mode.goalInputPh") : "描述目标，直接发送（无需 /goal）";
    } else if (composerMode === "plan") {
      ui.input.placeholder =
        typeof t === "function" ? t("mode.planInputPh") : "描述要规划的事项…";
    } else {
      ui.input.placeholder =
        typeof t === "function"
          ? t("chat.inputPh")
          : "消息 · 拖入图片 · / 命令 · + 附加文件… Enter 发送";
    }
  }
  $("composer")?.classList.toggle("is-busy", !!agentBusy);
}

function setComposerEnabled(on) {
  const canType = !!on;
  if (!canType) {
    if (ui.input) ui.input.disabled = true;
    if (ui.fileBtn) ui.fileBtn.disabled = true;
    if (ui.modelBtn) ui.modelBtn.disabled = true;
    if (ui.effortBtn) ui.effortBtn.disabled = true;
    if (ui.send) ui.send.disabled = true;
    if (ui.cancel) ui.cancel.disabled = true;
    $("composer")?.classList.remove("is-busy");
  } else {
    refreshSendButtonState();
  }
  updateLiveStrip();
}

/**
 * 任务进行中：Enter → 只排队（不打断）。
 * 点排队气泡上的「引导」→ 打断并立刻发送。
 */
function enqueueFollowUp({ text, images, files, displayText = null }) {
  if (!activeId) return false;
  const item = {
    text: text || "",
    displayText: displayText != null ? displayText : text || "",
    images: (images || []).slice(),
    files: (files || []).slice(),
  };
  if (!item.text && !item.images.length && !item.files.length) return false;
  if (!item.id) item.id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  messageQueue.push(item);
  const st = ensureSessionUi(activeId);
  st.messageQueue = messageQueue.slice();
  rerenderQueuedTurns();
  updateLiveStrip();
  refreshSendButtonState();
  return true;
}

function removeQueuedTurns() {
  ui.inner?.querySelectorAll(".turn.queued").forEach((el) => el.remove());
  const bar = ui.queueBar || $("queue-bar");
  if (bar) {
    bar.replaceChildren();
    bar.classList.add("hidden");
    bar.hidden = true;
  }
}

/** Codex-style slim queue strip above the composer — not a chat bubble. */
function rerenderQueuedTurns() {
  removeQueuedTurns();
  const bar = ui.queueBar || $("queue-bar");
  if (!bar) return;
  bar.replaceChildren();
  if (!messageQueue.length) {
    bar.classList.add("hidden");
    bar.hidden = true;
    return;
  }
  bar.classList.remove("hidden");
  bar.hidden = false;
  messageQueue.forEach((item, idx) => {
    if (!item.id) item.id = `q-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`;
    const row = document.createElement("div");
    row.className = "queue-row";
    row.dataset.qid = item.id;
    const left = document.createElement("div");
    left.className = "queue-row-text";
    const ico = document.createElement("span");
    ico.className = "queue-row-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.textContent = "↵";
    const shown = (item.displayText != null && item.displayText !== ""
      ? item.displayText
      : item.text) || (item.images?.length ? "（图片）" : "（附件）");
    const tx = document.createElement("span");
    tx.className = "queue-row-msg";
    tx.textContent = String(shown).replace(/\s+/g, " ").trim();
    tx.title = String(shown);
    left.append(ico, tx);

    tx.onclick = (e) => {
      e.stopPropagation();
      startQueueEdit(idx, tx);
    };
    tx.title = String(shown) + " · 点击编辑";

    const actions = document.createElement("div");
    actions.className = "queue-row-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "queue-edit";
    edit.textContent = "编辑";
    edit.title = "改这条排队消息";
    edit.onclick = (e) => {
      e.stopPropagation();
      startQueueEdit(idx);
    };
    const steer = document.createElement("button");
    steer.type = "button";
    steer.className = "queue-steer";
    steer.textContent = "插队";
    steer.title = "打断当前任务，立刻发送这条";
    steer.onclick = (e) => {
      e.stopPropagation();
      void guideSendFromQueue(idx);
    };
    const del = document.createElement("button");
    del.type = "button";
    del.className = "queue-del";
    del.textContent = "删除";
    del.title = "从队列去掉";
    del.onclick = (e) => {
      e.stopPropagation();
      const qid = item.id;
      messageQueue = qid
        ? messageQueue.filter((x) => x.id !== qid)
        : messageQueue.filter((_, i) => i !== idx);
      const st = ensureSessionUi(activeId);
      if (st) st.messageQueue = messageQueue.slice();
      rerenderQueuedTurns();
      updateLiveStrip();
      refreshSendButtonState();
    };
    if (isAgentBusy(activeId)) actions.append(edit, steer, del);
    else actions.append(edit, del);
    row.append(left, actions);
    bar.appendChild(row);
  });
}

function startQueueEdit(idx, txEl) {
  if (!activeId || idx < 0 || idx >= messageQueue.length) return;
  const item = messageQueue[idx];
  if (!item) return;
  const bar = ui.queueBar || $("queue-bar");
  const row = bar?.querySelectorAll(".queue-row")[idx];
  const tx = txEl || row?.querySelector(".queue-row-msg");
  if (!row || !tx) return;
  if (row.querySelector(".queue-row-editor")) {
    row.querySelector(".queue-row-editor").focus();
    return;
  }
  const input = document.createElement("textarea");
  input.className = "queue-row-editor";
  input.value = String(item.displayText != null && item.displayText !== "" ? item.displayText : item.text || "");
  input.rows = Math.min(6, Math.max(2, input.value.split("\n").length));
  tx.replaceWith(input);
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const next = input.value.replace(/\s+$/g, "");
      if (next) {
        item.text = next;
        item.displayText = next;
      }
      const st = ensureSessionUi(activeId);
      if (st) st.messageQueue = messageQueue.slice();
    }
    rerenderQueuedTurns();
    updateLiveStrip();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
}

/** 点「插队」：进行中则打断立刻发；已经空闲就直接发 */
async function guideSendFromQueue(idx) {
  if (!activeId || idx < 0 || idx >= messageQueue.length) return;
  const item = messageQueue[idx];
  if (!item) return;
  const qid = item.id;
  messageQueue = qid
    ? messageQueue.filter((x) => x.id !== qid)
    : messageQueue.filter((_, i) => i !== idx);
  const payload = {
    text: item.text || "",
    displayText: item.displayText != null ? item.displayText : item.text || "",
    images: (item.images || []).slice(),
    files: (item.files || []).slice(),
  };
  if (!payload.text && !payload.images.length && !payload.files.length) {
    const st0 = ensureSessionUi(activeId);
    if (st0) st0.messageQueue = messageQueue.slice();
    rerenderQueuedTurns();
    return;
  }
  const st = ensureSessionUi(activeId);
  st.messageQueue = messageQueue.slice();
  rerenderQueuedTurns();
  updateLiveStrip();
  const sid = activeId;
  try {
    if (isAgentBusy(sid)) await interruptAndSend(payload);
    else {
      await sendNow({
        text: payload.text,
        images: payload.images,
        files: payload.files,
        sessionId: sid,
        displayText: payload.displayText,
      });
    }
  } catch (err) {
    appendBanner(`引导发送失败：${err?.message || err}`, "error");
  }
  refreshSendButtonState();
  ui.input?.focus();
}

function updateLiveStripDurationOnly() {
  if (!ui.stripDuration || !ui.stripDurSep) return;
  const en = uiLocale() === "en";
  if (activeId && runStartedAt.has(activeId)) {
    const clock = formatElapsedClock(Date.now() - runStartedAt.get(activeId));
    ui.stripDuration.classList.remove("hidden");
    ui.stripDurSep.classList.remove("hidden");
    ui.stripDuration.textContent = en ? `⏱ ${clock}` : `⏱ ${clock}`;
    ui.stripDuration.title = en ? "Processing time" : "本次处理时长";
    ui.stripDuration.classList.add("is-live");
  } else if (activeId && lastRunDurationMs.has(activeId)) {
    const d = formatDuration(lastRunDurationMs.get(activeId));
    ui.stripDuration.classList.remove("hidden");
    ui.stripDurSep.classList.remove("hidden");
    ui.stripDuration.textContent = en ? `Done ${d}` : `用时 ${d}`;
    ui.stripDuration.title = en ? "Last run duration" : "上次处理时长";
    ui.stripDuration.classList.remove("is-live");
  } else {
    ui.stripDuration.classList.add("hidden");
    ui.stripDurSep.classList.add("hidden");
    ui.stripDuration.classList.remove("is-live");
  }
}

function updateLiveStrip() {
  if (!ui.liveStrip) return;
  if (!activeId) {
    ui.liveStrip.classList.add("hidden");
    return;
  }
  ui.liveStrip.classList.remove("hidden");
  if (ui.stripModel) ui.stripModel.textContent = shortModelName(currentModelId) || "—";
  if (ui.stripEffort) {
    const lab = effortOptions.find((e) => e.id === currentEffort)?.label || currentEffort || "—";
    ui.stripEffort.textContent = lab;
  }
  if (ui.stripTime) {
    const iso = activeMeta?.updatedAt;
    ui.stripTime.textContent = iso ? formatAbsoluteTime(iso) : "—";
    ui.stripTime.title = iso ? formatFullDateTime(iso) : "";
  }
  updateLiveStripDurationOnly();
  if (ui.stripCwd) ui.stripCwd.textContent = shortPath(activeMeta?.cwd);
  const st = activeId ? sessionUi.get(activeId) : null;
  const code = st?.codebaseLabel || "";
  if (ui.stripCodebase) {
    ui.stripCodebase.textContent = code || "";
    ui.stripCodebase.classList.toggle("hidden", !code);
  }
  ui.stripCodeSep?.classList.toggle("hidden", !code);
  if (ui.stripQueue) {
    if (messageQueue.length) {
      ui.stripQueue.classList.remove("hidden");
      ui.stripQueue.textContent = `队列 ${messageQueue.length}`;
    } else {
      ui.stripQueue.classList.add("hidden");
    }
  }
}

function renderContextChips() {
  if (!ui.contextChips) return;
  ui.contextChips.replaceChildren();
  if (!pendingFiles.length) {
    ui.contextChips.classList.add("hidden");
    return;
  }
  ui.contextChips.classList.remove("hidden");
  pendingFiles.forEach((f, idx) => {
    const chip = document.createElement("div");
    chip.className = "ctx-chip";
    chip.innerHTML = `<span></span><button type="button" title="移除">×</button>`;
    chip.querySelector("span").textContent = f.name || fileBasename(f.path);
    chip.querySelector("span").title = f.path;
    chip.querySelector("button").onclick = () => {
      pendingFiles.splice(idx, 1);
      renderContextChips();
      setComposerEnabled(!!activeId);
    };
    ui.contextChips.appendChild(chip);
  });
}

function createSessionViewState() {
  return {
    streamingEl: null,
    toolCardMap: new Map(),
    activeToolGroup: null,
    diffCardMap: new Map(),
    diffPathMap: new Map(),
    thoughtWrap: null,
    thoughtHost: null,
    plan: null,
    scrollTop: 0,
    meta: null,
    models: null,
    commands: null,
    historyAssets: [],
    history: [],
    historyFrom: 0,
    seenMedia: new Set(),
    pendingImages: [],
    pendingFiles: [],
    messageQueue: [],
    subagents: new Map(),
    composerMode: "task",
    statusState: "ready",
    statusDetail: "就绪",
    chunkBuf: createStreamBuffer(),
    chunkRaf: 0,
    runLine: "",
    runLineAt: 0,
  };
}

function ensureSessionUi(sessionId) {
  return sessionStore.ensure(sessionId);
}

function dispatchSessionEvent(sessionId, event) {
  const st = sessionStore.dispatch(sessionId, event);
  if (!st) return null;
  if (event?.type === "status" || event?.type === "run.finish" || event?.type === "run.stop") {
    st.statusState = st.model.phase;
    st.statusDetail = st.model.detail;
  }
  return st;
}

function sessionRenderContext(sessionId = activeId) {
  const sid = sessionId || activeId;
  const state = sid ? ensureSessionUi(sid) : null;
  return {
    sessionId: sid,
    state,
    pane: sid ? getPane(sid) : ui.inner,
    isActive: !!sid && sid === activeId,
  };
}

/** Save composer attachments/queue/history for the session we're leaving. */
function stashComposer(sessionId) {
  if (!sessionId) return;
  const st = ensureSessionUi(sessionId);
  st.pendingImages = pendingImages.slice();
  st.pendingFiles = pendingFiles.slice();
  st.messageQueue = messageQueue.slice();
  st.historyAssets = historyAssets.slice();
  st.history = sessionHistory.slice();
  st.historyFrom = historyFrom;
  st.seenMedia = new Set(seenMedia);
  st.scrollTop = ui.thread?.scrollTop || 0;
  st.draft = ui.input?.value || "";
  persistSessionUi(sessionId, { draft: st.draft });
  st.statusState = ui.status?.dataset?.state || st.statusState;
  st.statusDetail = ui.status?.textContent || st.statusDetail;
  if (activeMeta?.id === sessionId) st.meta = { ...activeMeta };
}

/** Restore composer for the session we're entering. */
function restoreComposer(sessionId) {
  const st = ensureSessionUi(sessionId);
  pendingImages = (st.pendingImages || []).slice();
  pendingFiles = (st.pendingFiles || []).slice();
  messageQueue = (st.messageQueue || []).slice();
  historyAssets = (st.historyAssets || []).slice();
  sessionHistory = (st.history || []).slice();
  historyFrom = st.historyFrom || 0;
  seenMedia = st.seenMedia instanceof Set ? new Set(st.seenMedia) : new Set();
  st.seenMedia = seenMedia;
  renderAttachPreview();
  renderContextChips();
  setComposerEnabled(!!sessionId && !connecting);
  rerenderQueuedTurns();
  renderSubagentBar();
  maybeFlushIdleQueue(sessionId);
}

function persistSessionUi(sid, patch, { immediate = false } = {}) {
  if (!sid || typeof grokDesktop.saveSessionUi !== "function") return;
  const st = ensureSessionUi(sid);
  st.desktopUi = { ...(st.desktopUi || {}), ...patch };
  const flush = () => {
    if (st._uiSaveTimer) clearTimeout(st._uiSaveTimer);
    st._uiSaveTimer = 0;
    void grokDesktop.saveSessionUi(sid, st.desktopUi);
  };
  st._flushDesktopUi = flush;
  if (st._uiSaveTimer) clearTimeout(st._uiSaveTimer);
  if (immediate || patch.stopped != null) flush();
  else st._uiSaveTimer = setTimeout(flush, 750);
}

function flushPendingSessionUi() {
  for (const st of sessionUi.values()) {
    if (st?._uiSaveTimer && typeof st._flushDesktopUi === "function") {
      st._flushDesktopUi();
    }
  }
}

function applyHistorySidecar(hist, st) {
  const uiState = { ...(st?.desktopUi || {}), ...(hist?.ui || {}) };
  if (st) {
    st.desktopUi = uiState;
    if (uiState.stopped) {
      st.stopped = true;
      st.skipGoalResume = true;
    }
  }
  const msgs = Array.isArray(hist?.messages) ? hist.messages : [];
  const lastUser = String(uiState.lastUser || "").trim();
  if (lastUser) {
    let lastU = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") { lastU = i; break; }
    }
    const same = lastU >= 0 && String(msgs[lastU].text || "").trim() === lastUser;
    if (!same) {
      msgs.push({ role: "user", text: lastUser });
    }
  }
  if (hist) hist.messages = msgs;
  if (st?.model?.sessionId) {
    dispatchSessionEvent(st.model.sessionId, {
      type: "hydrate",
      phase: uiState.stopped ? "ready" : st.statusState || "ready",
    });
  }
  return uiState;
}

function restoreDraftFromUi(uiState) {
  const draft = String(uiState?.draft || "");
  if (!draft || !ui.input) return;
  if (String(ui.input.value || "").trim()) return;
  ui.input.value = draft;
  try { autosize(); } catch { /* boot */ }
}

function ensurePane(sessionId) {
  if (!sessionId) return ui.inner;
  if (!threadPanes.has(sessionId)) {
    const el = document.createElement("div");
    el.className = "thread-inner";
    el.dataset.sessionId = sessionId;
    threadPanes.set(sessionId, el);
  }
  return threadPanes.get(sessionId);
}

function getPane(sessionId) {
  if (sessionId && sessionId === activeId) return ui.inner;
  if (sessionId && threadPanes.has(sessionId)) return threadPanes.get(sessionId);
  return ui.inner;
}

function activatePane(sessionId) {
  // stash scroll of current
  if (activeId && ui.inner) {
    const prev = ensureSessionUi(activeId);
    if (prev) prev.scrollTop = ui.thread.scrollTop;
    // detach current pane without destroying
    if (ui.inner.parentElement === ui.thread) {
      ui.thread.removeChild(ui.inner);
    }
    threadPanes.set(activeId, ui.inner);
  }
  const pane = ensurePane(sessionId);
  // clear thread and mount pane
  while (ui.thread.firstChild) ui.thread.removeChild(ui.thread.firstChild);
  ui.thread.appendChild(pane);
  ui.inner = pane;
  const st = ensureSessionUi(sessionId);
  threadFollowBottom = true;
  observeActivePaneForScroll();
  renderPlan(st.plan);
  schedulePinThreadToBottom();
  refreshPinnedPrompt();
}

function addOpenTab(sessionId) {
  if (!sessionId) return;
  if (!openTabs.includes(sessionId)) openTabs.push(sessionId);
  schedulePersistTabs();
}

function removeOpenTab(sessionId) {
  openTabs = openTabs.filter((id) => id !== sessionId);
  threadPanes.delete(sessionId);
  sessionUi.delete(sessionId);
  workingSessions.delete(sessionId);
  liveAgents.delete(sessionId);
  schedulePersistTabs();
}

/** Debounced write of open tabs + last active session to desktop settings. */
function schedulePersistTabs() {
  clearTimeout(persistTabsTimer);
  persistTabsTimer = setTimeout(() => {
    void persistOpenTabs();
  }, 400);
}

function tabsToPersist() {
  const current = activeId || desktopSettings.lastActiveId || null;
  const rest = openTabs.filter((id) => id && id !== current);
  return (current ? [current, ...rest] : rest).slice(0, 12);
}

async function persistOpenTabs() {
  try {
    const next = {
      openTabs: tabsToPersist(),
      lastActiveId: activeId || desktopSettings.lastActiveId || null,
    };
    desktopSettings = {
      ...desktopSettings,
      ...next,
    };
    await grokDesktop.saveDesktopSettings(next);
  } catch {
    /* ignore persistence errors */
  }
}

/** Prefer a short readable title from first user message. */
function titleFromUserText(text) {
  let t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  // drop leading list/markdown markers
  t = t.replace(/^(?:[#>*\-\d.、]+\s*)+/, "");
  // keep one line
  t = t.split(/[。！？\n]/)[0] || t;
  t = t.trim();
  if (t.length > 36) t = t.slice(0, 36).replace(/\s+\S*$/, "") || t.slice(0, 36);
  return t;
}

function looksLikeAutoTitle(title) {
  if (!title) return true;
  const t = String(title).trim();
  if (!t) return true;
  if (/^(新对话|新会话|Untitled|New chat|New conversation)$/i.test(t)) return true;
  // Long English CLI-generated titles often look like sentence case phrases
  if (/^[A-Za-z0-9][-\w\s,./:&+]{20,}$/.test(t) && !/[\u4e00-\u9fff]/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Highlight query inside currently rendered message bodies and scroll to first hit.
 * @returns {boolean} true if found
 */
function highlightSearchInThread(query) {
  const q = String(query || "").trim();
  clearSearchHighlight();
  if (!q || !ui.inner) return false;
  const qLow = q.toLowerCase();
  const bodies = ui.inner.querySelectorAll(".turn .body");
  let firstMark = null;
  for (const body of bodies) {
    const text = body.textContent || "";
    const low = text.toLowerCase();
    let from = 0;
    let idx = low.indexOf(qLow, from);
    if (idx < 0) continue;
    // rebuild with marks (first 8 hits per body)
    const frag = document.createDocumentFragment();
    let hits = 0;
    while (idx >= 0 && hits < 8) {
      if (idx > from) frag.appendChild(document.createTextNode(text.slice(from, idx)));
      const mark = document.createElement("mark");
      mark.className = "search-hl-mark";
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      if (!firstMark) firstMark = mark;
      hits++;
      from = idx + q.length;
      idx = low.indexOf(qLow, from);
    }
    if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
    body.replaceChildren(frag);
    body.closest(".turn")?.classList.add("search-hl-turn");
  }
  if (firstMark) {
    firstMark.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }
  return false;
}

function clearSearchHighlight() {
  if (!ui.inner) return;
  ui.inner.querySelectorAll(".turn.search-hl-turn").forEach((el) => el.classList.remove("search-hl-turn"));
  // restore plain text for marked bodies, then re-linkify URLs
  ui.inner.querySelectorAll(".turn .body").forEach((body) => {
    if (!body.querySelector("mark.search-hl-mark")) return;
    const t = body.textContent || "";
    setMessageBody(body, t);
  });
}

/** Open session then highlight search query in the thread. */
async function openSessionWithHighlight(sessionId, query) {
  lastSearchQuery = query || "";
  if (view !== "chat") switchView("chat");
  await selectSession(sessionId);
  if (!lastSearchQuery) return;
  // allow pane to settle
  await new Promise((r) => requestAnimationFrame(() => r()));
  let found = highlightSearchInThread(lastSearchQuery);
  // If not in visible window, load earlier history once
  if (!found && historyFrom > 0) {
    historyFrom = 0;
    renderHistory();
    found = highlightSearchInThread(lastSearchQuery);
  }
  if (!found) {
    appendBanner(
      `已打开会话，当前预览未定位到「${lastSearchQuery}」（可能仅标题匹配，或内容在更早历史）`,
    );
  }
}

let sessionCtxReturnFocus = null;

function hideSessionCtx({ restore = true } = {}) {
  const menu = $("session-ctx");
  if (menu) {
    menu.classList.add("hidden");
    menu.setAttribute("aria-hidden", "true");
  }
  ctxSessionId = null;
  if (restore) a11y.restoreFocus?.(sessionCtxReturnFocus);
  sessionCtxReturnFocus = null;
}

function showSessionCtx(x, y, sessionId, invoker = null) {
  const menu = $("session-ctx");
  if (!menu) return;
  sessionCtxReturnFocus = invoker || document.activeElement;
  ctxSessionId = sessionId;
  // dynamic labels
  const pinBtn = $("ctx-pin");
  const archBtn = $("ctx-archive");
  if (pinBtn) pinBtn.textContent = isPinned(sessionId) ? "取消置顶" : "置顶";
  if (archBtn) archBtn.textContent = isArchived(sessionId) ? "取消归档" : "归档";
  const s = sessions.find((x) => x.id === sessionId);
  const cwdBtn = menu.querySelector('[data-act="copy-cwd"]');
  if (cwdBtn) cwdBtn.disabled = !s?.cwd;
  menu.classList.remove("hidden");
  menu.setAttribute("aria-hidden", "false");
  // measure then clamp to viewport (menu grew with more actions)
  const pad = 8;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 320;
  let left = x;
  let top = y;
  if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad;
  if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad;
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
  requestAnimationFrame(() => {
    menu.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  });
}

function sessionTabTitle(id) {
  if (id === activeId && activeMeta?.title) return activeMeta.title;
  const cached = sessionUi.get(id)?.meta?.title;
  if (cached) return cached;
  const s = sessions.find((x) => x.id === id);
  return s?.title || id.slice(0, 8);
}

/** Ctrl/Cmd+Tab cycle open session tabs */
function cycleTab(dir = 1) {
  if (openTabs.length < 2) return;
  const idx = Math.max(0, openTabs.indexOf(activeId));
  const next = openTabs[(idx + dir + openTabs.length) % openTabs.length];
  if (next) void selectSession(next);
}

/** User wants stick-to-bottom while streaming (false after scroll-up). */
let threadFollowBottom = true;
let threadScrollWired = false;
let threadUserScrolling = false;

/** True if the chat thread is already near the bottom (user wants stick-to-bottom). */
function isThreadNearBottom(threshold = 64) {
  const el = ui.thread;
  if (!el) return true;
  // content shorter than viewport → always "at bottom"
  if (el.scrollHeight <= el.clientHeight + 4) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

function updateJumpToLatest() {
  const btn = document.getElementById("jump-latest");
  if (!btn) return;
  btn.classList.toggle("hidden", isThreadNearBottom());
}

function pinThreadToBottom() {
  const el = ui.thread;
  if (!el) return;
  pinThreadToBottom._locking = true;
  el.scrollTop = el.scrollHeight + 4096;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      pinThreadToBottom._locking = false;
      updateJumpToLatest();
      refreshPinnedPrompt();
    });
  });
}

function wireThreadScrollFollow() {
  if (threadScrollWired || !ui.thread) return;
  threadScrollWired = true;
  const el = ui.thread;

  el.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY < 0) {
        threadFollowBottom = false;
        updateJumpToLatest();
        return;
      }
      // After the wheel applies, re-follow if we landed near the bottom.
      requestAnimationFrame(() => {
        if (isThreadNearBottom()) threadFollowBottom = true;
        updateJumpToLatest();
      });
    },
    { passive: true },
  );

  el.addEventListener(
    "pointerdown",
    () => {
      threadUserScrolling = true;
    },
    { passive: true },
  );

  window.addEventListener(
    "pointerup",
    () => {
      if (!threadUserScrolling) return;
      threadUserScrolling = false;
      threadFollowBottom = isThreadNearBottom(72);
      updateJumpToLatest();
    },
    { passive: true },
  );

  el.addEventListener(
    "scroll",
    () => {
      if (pinThreadToBottom._locking) return;
      if (threadUserScrolling) {
        threadFollowBottom = isThreadNearBottom();
      } else if (isThreadNearBottom()) {
        // Never set follow=false from a generic scroll (programmatic stream pins
        // used to fire scroll events and flip follow off).
        threadFollowBottom = true;
      }
      updateJumpToLatest();
      refreshPinnedPrompt();
    },
    { passive: true },
  );

  document.getElementById("jump-latest")?.addEventListener("click", () => {
    scrollThreadToBottom({ force: true });
  });

  try {
    const ro = new ResizeObserver(() => {
      if (threadFollowBottom) pinThreadToBottom();
      else updateJumpToLatest();
      refreshPinnedPrompt();
    });
    pinThreadToBottom._ro = ro;
    if (ui.inner) ro.observe(ui.inner);
  } catch {
    /* ResizeObserver unavailable */
  }
}

/** Re-bind size observer when the active session pane swaps. */
function observeActivePaneForScroll() {
  const ro = pinThreadToBottom._ro;
  if (ro && ui.inner) {
    try {
      ro.disconnect();
      ro.observe(ui.inner);
    } catch {
      /* ignore */
    }
  }
  updateJumpToLatest();
}

/**
 * Scroll thread to bottom when following the stream (or force=true).
 * Pins once; ResizeObserver covers later layout growth.
 */
function scrollThreadToBottom({ force = false } = {}) {
  if (!ui.thread) return;
  if (force) threadFollowBottom = true;
  if (!threadFollowBottom) {
    updateJumpToLatest();
    return;
  }
  pinThreadToBottom();
}

function forSession(payload, fn, { scroll = false, tabs = true } = {}) {
  const sid = payload?.sessionId || activeId;
  if (!sid) return;
  const context = sessionRenderContext(sid);
  fn(sid, context.state, context.isActive, context);
  // Default: do NOT scroll on every event (streaming uses batched flush instead)
  if (scroll && context.isActive) scrollThreadToBottom();
  else if (!context.isActive && tabs) refreshSidebarSessionState();
}

/**
 * Batch stream tokens into one DOM write per animation frame.
 * Long chats used to reflow on every tiny chunk (textContent += + scroll).
 */
function thoughtClockLabel(ms) {
  const sec = Math.max(0.1, (Number(ms) || 0) / 1000);
  const shown = sec < 10 ? sec.toFixed(1).replace(/\.0$/, "") : String(Math.round(sec));
  return uiLocale() === "en" ? `Thought for ${shown}s` : `思考了 ${shown} 秒`;
}


function currentAssistantBody(st) {
  const el = st?.assistantBody;
  if (!el) return null;
  const turn = el.closest?.(".turn");
  const pane = turn?.parentElement;
  return canAppendAssistantChunk({
    connected: !!el.isConnected,
    kind: el.dataset.kind,
    insideThought: !!el.closest?.(".thought-block"),
    afterLastUser: !pane || nodeAfterLastUser(pane, turn),
  })
    ? el
    : null;
}


function nodeAfterLastUser(pane, el) {
  const lastUser = lastUserTurnEl(pane);
  if (!el || !lastUser || lastUser.parentElement !== el.parentElement) return !lastUser;
  return !!(lastUser.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function noteThoughtStream(sid, text) {
  const st = ensureSessionUi(sid);
  st.activeToolGroup = null;
  const pane = getPane(sid) || ui.inner;
  const lastUser = lastUserTurnEl(pane);
  let wrap = st.thoughtWrap;
  const canContinue = canAppendThoughtChunk({
    connected: !!wrap?.isConnected,
    samePane: !!wrap && wrap.parentElement === pane,
    done: wrap?.dataset.done === "1",
    afterLastUser: !lastUser || nodeAfterLastUser(pane, wrap),
  });
  // A whitespace-only token with no active thought is transport noise. It must
  // not close an assistant message or become an invisible stream boundary.
  if (shouldIgnoreOrphanStreamChunk(canContinue, text)) return;
  if (!canContinue) {
    finishThoughtClock(sid);
    const priorReply = currentAssistantBody(st)?.closest?.(".turn");
    if (priorReply) setAssistantTurnKind(priorReply, "commentary");
    st.assistantBody = null;
    st.streamingEl = null;
    wrap = null;
  }
  // Streaming transports may emit whitespace as an independent token. Do not
  // turn that token into an empty 0.1-second disclosure; spacing inside an
  // already-open thought is still preserved below.
  // A thought is continuous only while thought events stay adjacent. Tool,
  // assistant and user events close it explicitly, preserving timeline order.
  const needNew = !wrap;
  if (needNew) {
    st.thoughtStartedAt = Date.now();
    wrap = document.createElement("div");
    wrap.className = "thought-block is-open";
    wrap.dataset.sessionId = sid || "";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "thought-head";
    head.setAttribute("aria-expanded", "true");
    const label = document.createElement("span");
    label.className = "thought-label";
    label.textContent = uiLocale() === "en" ? "Thinking…" : "正在思考";
    const stepCount = document.createElement("span");
    stepCount.className = "thought-step-count hidden";
    const chev = document.createElement("span");
    chev.className = "t-chev";
    chev.textContent = "▾";
    head.append(label, stepCount, chev);
    head.onclick = () => {
      wrap.classList.toggle("is-open");
      head.setAttribute("aria-expanded", String(wrap.classList.contains("is-open")));
      const row = wrap.querySelector(".thought");
      if (wrap.classList.contains("is-open") && row?.dataset.md === "pending") {
        requestAnimationFrame(() => {
          if (row.dataset.md !== "pending") return;
          const raw = row.textContent || "";
          if (raw.length > 80000) { row.dataset.md = "1"; return; }
          setMessageBody(row, raw, { markdown: true });
          row.dataset.md = "1";
        });
      }
    };
    const row = document.createElement("div");
    row.className = "thought";
    row.dataset.kind = "thought";
    wrap.append(head, row);
    pane?.querySelector?.(".welcome")?.remove();
    pane?.appendChild(wrap);
    st.thoughtWrap = wrap;
    st.thoughtHost = wrap;
  } else {
    st.thoughtWrap = wrap;
    st.thoughtHost = wrap;
    wrap.classList.add("is-open");
    wrap.dataset.done = "";
    if (!st.thoughtStartedAt) st.thoughtStartedAt = Date.now();
  }
  const row = wrap.querySelector(".thought");
  if (!row) return;
  const last = row.lastChild;
  if (last && last.nodeType === 3) last.data += text;
  else row.appendChild(document.createTextNode(text));
  const live = wrap.querySelector(".thought-label");
  if (live && st.thoughtStartedAt) {
    live.textContent = thoughtClockLabel(Date.now() - st.thoughtStartedAt);
  }
}

function markThoughtInterrupted(wrap) {
  if (!wrap) return;
  wrap.dataset.interrupted = "1";
  const label = wrap.querySelector(".thought-label");
  const suffix = uiLocale() === "en" ? " · fragment ended" : " · 片段中断";
  if (label && !label.textContent.endsWith(suffix)) label.textContent += suffix;
  wrap.title =
    uiLocale() === "en"
      ? "The upstream thought ended without sending the rest of this fragment."
      : "上游结束了这段思考，后续片段没有发送到桌面端。";
}

function settleThoughtText(st, wrap) {
  if (!st || !wrap) return;
  const label = wrap.querySelector(".thought-label");
  if (label && st.thoughtStartedAt) {
    label.textContent = thoughtClockLabel(Date.now() - st.thoughtStartedAt);
  }
  const row = wrap.querySelector(".thought");
  if (row) {
    const settled = finalizeThoughtText(row.textContent || "");
    if (settled.interrupted) {
      row.textContent = settled.text;
      row.dataset.interrupted = "1";
      markThoughtInterrupted(wrap);
    }
  }
  wrap.dataset.done = "1";
  st.thoughtStartedAt = null;
}

function holdThoughtForTools(sid) {
  const st = sid ? sessionUi.get(sid) : null;
  if (!st?.thoughtWrap) return;
  settleThoughtText(st, st.thoughtWrap);
  st.thoughtHost = st.thoughtWrap;
  st.thoughtWrap = null;
}

function finishThoughtClock(sid) {
  const st = sid ? sessionUi.get(sid) : null;
  if (!st) return;
  const wrap = st.thoughtWrap || st.thoughtHost;
  if (!wrap) {
    st.thoughtStartedAt = null;
    st.thoughtWrap = null;
    st.thoughtHost = null;
    return;
  }
  if (st.thoughtWrap) settleThoughtText(st, st.thoughtWrap);
  wrap.classList.remove("is-open");
  wrap.querySelector(".thought-head")?.setAttribute("aria-expanded", "false");
  wrap.dataset.done = "1";
  st.thoughtStartedAt = null;
  st.thoughtWrap = null;
  st.thoughtHost = null;
}

function flushSessionStream(sid, { finish = false } = {}) {
  const st = sid ? ensureSessionUi(sid) : null;
  if (!st) return;
  if (st.chunkRaf) {
    cancelAnimationFrame(st.chunkRaf);
    st.chunkRaf = 0;
  }
  if (hasPendingStream(st.chunkBuf)) flushStreamChunks(sid);
  if (finish) endStreamChrome(sid);
}

function enqueueStreamChunk(payload) {
  const { kind, text } = payload || {};
  if (!text) return;
  const sid = payload?.sessionId || activeId;
  if (!sid) return;
  const st = ensureSessionUi(sid);
  if (!st.chunkBuf) st.chunkBuf = createStreamBuffer();
  enqueueStreamSegment(st.chunkBuf, kind, text);
  noteCallActivity(sid, kind === "thought" ? "正在思考" : "正在回复");
  if (!st._ctxBumpAt || Date.now() - st._ctxBumpAt > 800) {
    st._ctxBumpAt = Date.now();
    bumpContextUsage(sid);
  }

  if (st.chunkRaf) return;
  st.chunkRaf = requestAnimationFrame(() => {
    st.chunkRaf = 0;
    flushStreamChunks(sid);
  });
}

function flushStreamChunks(sid) {
  const st = ensureSessionUi(sid);
  if (!st?.chunkBuf) return;
  const isActive = sid === activeId;
  if (isActive && connecting && !st.replayOpen && !promptInFlight.has(sid)) {
    return;
  }

  const segments = drainStreamSegments(st.chunkBuf);
  if (!segments.length) return;

  const context = sessionRenderContext(sid);
  const pane = context.pane;
  for (const segment of segments) {
    const { kind, text } = segment;
    let assistantTarget = null;
    if (kind === "assistant") {
      // Ignore transport-only whitespace when there is no assistant target.
      // In particular, do not let it close a thought and split that thought.
      assistantTarget = currentAssistantBody(st);
      if (shouldIgnoreOrphanStreamChunk(assistantTarget, text)) continue;
      clearTypingWait(sid);
      if (sid === activeId) paintRunStatus("", { hide: true });
      finishThoughtClock(sid);
    } else {
      clearTypingWait(sid);
      if (sid === activeId && waitSidBusy(sid) && !runningToolCount(sid) && !ensureSessionUi(sid).compacting) {
        paintRunStatus(uiLocale() === "en" ? "Thinking…" : "正在思考");
      }
    }
    if (kind === "thought" && sid === activeId && isAgentBusy(sid)) {
      const cur = ensureSessionUi(sid).runLine || "";
      if (!ensureSessionUi(sid).compacting && (!cur || /开始处理|Starting|正在思考|Thinking/.test(cur))) {
        paintRunStatus(uiLocale() === "en" ? "Thinking…" : "正在思考");
      }
    }
    if (kind === "thought") {
      noteThoughtStream(sid, text);
      dispatchSessionEvent(sid, { type: "thought.chunk", text });
    } else {
      dispatchSessionEvent(sid, { type: "assistant.chunk", text });
      let target = assistantTarget || currentAssistantBody(st);
      if (!target) {
        target = appendTurn("assistant", text, {
          stream: true,
          clampable: false,
          skipScroll: true,
          pane,
          sessionId: sid,
        });
        target.dataset.kind = "assistant";
        st.assistantBody = target;
      } else {
        const last = target.lastChild;
        if (last && last.nodeType === 3) last.data += text;
        else target.appendChild(document.createTextNode(text));
        target.dataset.kind = "assistant";
      }
      st.streamingEl = target;
    }
  }
  if (!isActive) refreshSidebarSessionState();
  if (isActive && threadFollowBottom) pinThreadToBottom();
  else if (isActive) updateJumpToLatest();
}

/** Mark stream finished so old turns can use content-visibility again. */
function endStreamChrome(sid) {
  finishThoughtClock(sid);
  const pane = sid ? getPane(sid) : ui.inner;
  pane?.querySelectorAll?.(".turn.streaming").forEach((el) => {
    el.classList.remove("streaming");
    el.setAttribute("aria-busy", "false");
    // Coalesce many Text nodes from streaming, then make URLs clickable
    const body = el.querySelector(".body");
    if (body) {
      const t = body.textContent || "";
      setMessageBody(body, t, { markdown: el.classList.contains("assistant") });
    }
  });
  // Thoughts stay plain text here. Extra-High thoughts are huge; markdown
  // at turn-end freezes the window. Render when the user expands.
  pane?.querySelectorAll?.(".thought").forEach((el) => {
    if (el.dataset.md === "1") return;
    el.dataset.md = "pending";
  });
  classifyAssistantTurns(pane, { settled: true });
}








const {
  aggregateDiffStatus,
  buildToolDetailText,
  defaultToolGroupExpanded,
  diffPathLabel,
  diffStatusPresentation,
  normalizeDiffPath,
  shortTargetLabel,
  toolPreviewLine,
} = GrokToolPresentation;

function isTerminalToolStatus(status) {
  return GrokSessionState.isTerminalToolStatus(status);
}

function humanizeToolActivity(payload) {
  return GrokToolPresentation.humanizeToolActivity(payload, uiLocale());
}

function setActivityFromTool(payload) {
  const h = humanizeToolActivity(payload);
  const sid = payload?.sessionId || activeId;
  const line = h.target ? `${h.verb} · ${h.target}` : h.verb;
  const compactTool = looksLikeCompact(payload?.kind) || looksLikeCompact(payload?.title);
  if (compactTool) {
    if (h.running) markCompacting(sid);
    else clearCompacting(sid);
  } else if (h.running) {
    clearCompacting(sid);
  }
  const n = noteToolRun(sid, payload, h.running);
  const shown = compactTool && h.running ? compactStatusLine() : line;
  if (n > 0) {
    if (sid === activeId) paintRunStatus(shown);
    setWaitStatus(sid, shown);
  } else if (waitSidBusy(sid)) {
    const st = ensureSessionUi(sid);
    if (streamHasVisibleOutput(st)) {
      clearTypingWait(sid);
    } else {
      if (sid === activeId) paintRunStatus(uiLocale() === "en" ? "Thinking…" : "正在思考");
      showTypingWait(sid);
    }
  }
}

function collapseToolCard(card) {
  if (!card) return;
  card.classList.remove("open");
  const pre = card.querySelector("pre");
  if (pre && !pre.classList.contains("tool-pre-empty")) {
    pre.classList.add("tool-pre-empty");
    pre.textContent = "展开查看详情";
  }
}

function updateToolGroup(group) {
  if (!group) return;
  const cards = [...group.querySelectorAll(":scope > .tool-group-body > .tool-card")];
  const total = cards.length;
  const running = cards.filter((card) => !isTerminalToolStatus(card._payload?.status)).length;
  const failed = cards.filter((card) => /failed|error|cancel|reject|denied/i.test(String(card._payload?.status || ""))).length;
  group.classList.toggle("single", total < 2);
  group.classList.toggle("settled", total > 0 && running === 0);
  group.classList.toggle("failed", failed > 0);
  const status = group.querySelector(".tool-group-status");
  const label = group.querySelector(".tool-group-label");
  const meta = group.querySelector(".tool-group-meta");
  if (status) status.className = `tool-group-status ${failed ? "failed" : running ? "running" : "completed"}`;
  if (label) {
    label.textContent = running
      ? uiLocale() === "en" ? `Running ${total} steps` : `正在执行 ${total} 个步骤`
      : uiLocale() === "en" ? `${total} steps completed` : `已完成 ${total} 个步骤`;
  }
  if (meta) {
    meta.textContent = failed
      ? uiLocale() === "en" ? `${failed} need attention` : `${failed} 个需注意`
      : running
        ? uiLocale() === "en" ? `${running} in progress` : `${running} 个进行中`
        : uiLocale() === "en" ? "Completed" : "已完成";
  }
  if (!group.dataset.userToggled) {
    const expanded = defaultToolGroupExpanded({ total, running, failed });
    group.classList.toggle("open", expanded);
    group
      .querySelector(".tool-group-head")
      ?.setAttribute("aria-expanded", String(expanded));
  }
  updateThoughtStepCount(group.closest(".thought-block"));
}

function updateThoughtStepCount(wrap) {
  if (!wrap) return;
  const count = wrap.querySelectorAll(".tool-card, .diff-card, .perm-card").length;
  let label = wrap.querySelector(":scope > .thought-head > .thought-step-count");
  if (!label && count) {
    label = document.createElement("span");
    label.className = "thought-step-count";
    wrap.querySelector(":scope > .thought-head > .t-chev")?.before(label);
  }
  if (!label) return;
  label.textContent = uiLocale() === "en" ? `· ${count} steps` : `· ${count} 个步骤`;
  label.classList.toggle("hidden", count < 1);
}

function thoughtStepHost(context) {
  const { pane, state } = context || {};
  const wrap = state?.thoughtHost;
  if (!wrap?.isConnected || wrap.parentElement !== pane) {
    if (state) state.thoughtHost = null;
    return null;
  }
  let host = wrap.querySelector(":scope > .thought-steps");
  if (!host) {
    host = document.createElement("div");
    host.className = "thought-steps";
    wrap.appendChild(host);
  }
  return host;
}

function ensureToolGroup(context) {
  const { pane, state, sessionId } = context;
  const host = thoughtStepHost(context) || pane;
  let group = state?.activeToolGroup;
  if (!group?.isConnected || group.parentElement !== host || host.lastElementChild !== group) {
    group = document.createElement("section");
    group.className = "tool-group open single";
    group.dataset.sessionId = sessionId || "";
    group.innerHTML = `
      <button type="button" class="tool-group-head" aria-expanded="true">
        <span class="tool-group-status running" aria-hidden="true"></span>
        <span class="tool-group-label"></span>
        <span class="tool-group-meta"></span>
        <span class="tool-group-chev" aria-hidden="true">▾</span>
      </button>
      <div class="tool-group-body"></div>`;
    const head = group.querySelector(".tool-group-head");
    head.onclick = () => {
      if (group.classList.contains("single")) return;
      group.dataset.userToggled = "1";
      group.classList.toggle("open");
      head.setAttribute("aria-expanded", String(group.classList.contains("open")));
    };
    host.appendChild(group);
    if (state) state.activeToolGroup = group;
  }
  return group;
}

function enforceMaxOpenTools(keepCard, pane = ui.inner) {
  const opens = [...pane.querySelectorAll(".tool-card.open")];
  for (const c of opens) {
    if (c === keepCard) continue;
    collapseToolCard(c);
  }
  // if somehow still over limit
  const still = [...pane.querySelectorAll(".tool-card.open")];
  for (let i = 0; i < still.length - MAX_OPEN_TOOLS; i++) {
    if (still[i] !== keepCard) collapseToolCard(still[i]);
  }
}


const MAX_EAGER_THOUGHT_MARKDOWN = 80000;

function paintHistoryThought(row, text) {
  if (!row) return;
  const raw = String(text || "");
  row._rawText = raw;
  const settled = finalizeThoughtText(raw);
  row.dataset.interrupted = settled.interrupted ? "1" : "";
  const shown = settled.text;
  if (raw.length > MAX_EAGER_THOUGHT_MARKDOWN) {
    row.classList.remove("md");
    row.textContent = shown;
    row.dataset.md = "1";
    row.dataset.linkified = "1";
    return;
  }
  setMessageBody(row, shown, { markdown: true });
  row.dataset.md = "1";
}

function appendHistoryThought(text) {
  const body = String(text || "").trim();
  if (!body) return;
  const sid = activeId;
  const state = sid ? ensureSessionUi(sid) : null;
  if (sid) finishThoughtClock(sid);
  ui.inner.querySelector(".welcome")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "thought-block";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "thought-head";
  head.setAttribute("aria-expanded", "false");
  const label = document.createElement("span");
  label.className = "thought-label";
  label.textContent = uiLocale() === "en" ? "Thought" : "思考";
  const stepCount = document.createElement("span");
  stepCount.className = "thought-step-count hidden";
  const chev = document.createElement("span");
  chev.className = "t-chev";
  chev.textContent = "▾";
  head.append(label, stepCount, chev);
  head.onclick = () => {
    wrap.classList.toggle("is-open");
    head.setAttribute("aria-expanded", String(wrap.classList.contains("is-open")));
  };
  const row = document.createElement("div");
  row.className = "thought";
  row.dataset.kind = "thought";
  paintHistoryThought(row, body);
  wrap.append(head, row);
  if (row.dataset.interrupted === "1") markThoughtInterrupted(wrap);
  ui.inner.appendChild(wrap);
  if (state) {
    state.thoughtWrap = null;
    state.thoughtHost = wrap;
  }
  return wrap;
}

function mergeToolPayload(previous, payload) {
  const merged = { ...(previous || {}) };
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null) continue;
    if (
      key === "status" &&
      isTerminalToolStatus(merged.status) &&
      !isTerminalToolStatus(value)
    ) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function upsertDiffToolPayload(card, id, payload) {
  if (!card) return;
  if (!card._toolPayloads) card._toolPayloads = new Map();
  const key = String(id || payload?.toolCallId || "diff");
  const previous = card._toolPayloads.get(key);
  card._toolPayloads.set(key, mergeToolPayload(previous, payload));
  const all = [...card._toolPayloads.values()];
  card._toolPayload = {
    ...(card._toolPayload || {}),
    ...(payload || {}),
    status: aggregateDiffStatus(all),
  };
  paintDiffCardStatus(card, card._toolPayload.status, { allowReopen: true });
}

function appendToolCard(payload, renderContext = null) {
  const context = renderContext || sessionRenderContext(payload?.sessionId || activeId);
  const pane = context.pane || ui.inner;
  const state = context.state || ensureSessionUi(context.sessionId || activeId);
  const cards = state?.toolCardMap || new Map();
  pane.querySelector(".welcome")?.remove();
  const id = payload.toolCallId || `t-${Date.now()}`;
  const diffCard = state?.diffCardMap?.get(id);
  if (diffCard?.isConnected) {
    upsertDiffToolPayload(diffCard, id, payload);
    const mergedPayload = diffCard._toolPayload;
    if (context.isActive) setActivityFromTool(mergedPayload);
    noteCallActivity(
      mergedPayload.sessionId || activeId,
      mergedPayload.title || mergedPayload.kind || "工具",
    );
    return diffCard;
  }
  let card = cards.get(id);
  if (!card) {
    const group = ensureToolGroup(context);
    card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.id = id;
    card._detail = "";
    card.innerHTML = `
      <button type="button" class="tool-card-head" aria-expanded="false">
        <span class="t-status"></span>
        <span class="t-main">
          <span class="t-title"></span>
          <span class="t-preview"></span>
        </span>
        <span class="t-chev">▾</span>
      </button>
      <div class="tool-card-body"><pre class="tool-pre-empty">展开查看详情</pre></div>`;
    // Lazy: only paint huge pre when user opens the card
    card.querySelector(".tool-card-head").onclick = () => {
      const willOpen = !card.classList.contains("open");
      if (willOpen) {
        enforceMaxOpenTools(card, pane);
        card.classList.add("open");
        card.querySelector(".tool-card-head").setAttribute("aria-expanded", "true");
        const pre = card.querySelector("pre");
        if (card._detail) {
          pre.classList.remove("tool-pre-empty");
          pre.textContent = card._detail;
        }
      } else {
        collapseToolCard(card);
        card.querySelector(".tool-card-head").setAttribute("aria-expanded", "false");
      }
    };
    group.querySelector(".tool-group-body").appendChild(card);
    cards.set(id, card);
  }
  const mergedPayload = mergeToolPayload(card._payload, payload);
  paintToolCard(card, mergedPayload);
  updateToolGroup(card.closest(".tool-group"));
  if (context.isActive) setActivityFromTool(mergedPayload);
  noteCallActivity(mergedPayload.sessionId || activeId, mergedPayload.title || mergedPayload.kind || "工具");
  if (context.isActive) scrollThreadToBottom({ force: threadFollowBottom });
  return card;
}

function paintToolCard(card, mergedPayload) {
  card._payload = mergedPayload;
  const status = (mergedPayload.status || "running").toLowerCase();
  const st = card.querySelector(".t-status");
  st.textContent = statusLabelZh(TOOL_STATUS_ZH, status);
  st.title = status;
  st.className = "t-status " + status.replace(/\s+/g, "-");
  const human = humanizeToolActivity(mergedPayload);
  card.querySelector(".t-title").textContent =
    human.title || mergedPayload.title || mergedPayload.kind || "工具";
  // Store detail; only write into DOM if currently open
  const detail = buildToolDetailText(mergedPayload);
  if (detail) card._detail = detail;
  const preview = card.querySelector(".t-preview");
  if (preview) {
    const p = toolPreviewLine(card._detail);
    preview.textContent = p;
    preview.hidden = !p;
  }
  if (card.classList.contains("open") && card._detail) {
    const pre = card.querySelector("pre");
    pre.classList.remove("tool-pre-empty");
    pre.textContent = card._detail;
  }
}

function settleToolCards(sid, { state = "ready", detail = "" } = {}) {
  const st = sid ? ensureSessionUi(sid) : null;
  if (!st) return;
  st.runningTools?.clear?.();
  const stopped = /stop|cancel|abort|中断|停止|已停/i.test(String(detail || ""));
  const terminalStatus = stopped
    ? "cancelled"
    : state === "error" || state === "disconnected"
      ? "failed"
      : "completed";
  const groups = new Set();
  for (const card of st.toolCardMap?.values?.() || []) {
    if (!card?.isConnected || isTerminalToolStatus(card._payload?.status)) continue;
    const group = card.closest(".tool-group");
    if (group) groups.add(group);
    paintToolCard(card, {
      ...(card._payload || {}),
      status: terminalStatus,
      sessionId: sid,
    });
  }
  for (const card of st.toolCardMap?.values?.() || []) {
    const group = card?.closest?.(".tool-group");
    if (group) groups.add(group);
  }
  for (const group of groups) updateToolGroup(group);
  for (const card of new Set(st.diffCardMap?.values?.() || [])) {
    if (!card?.isConnected) continue;
    if (isTerminalToolStatus(card.dataset.status)) continue;
    if (card._toolPayloads?.size) {
      for (const [id, payload] of card._toolPayloads) {
        if (!isTerminalToolStatus(payload?.status)) {
          card._toolPayloads.set(id, { ...(payload || {}), status: terminalStatus });
        }
      }
      const status = aggregateDiffStatus([...card._toolPayloads.values()]);
      card._toolPayload = { ...(card._toolPayload || {}), status, sessionId: sid };
      paintDiffCardStatus(card, status, { allowReopen: true });
    } else {
      paintDiffCardStatus(card, terminalStatus);
    }
  }
}

function collapseOlderOpenDiffs(keep, pane = ui.inner) {
  const opens = [...pane.querySelectorAll(".diff-card.open")].filter((el) => el !== keep);
  const extra = opens.length - Math.max(0, MAX_OPEN_DIFFS - 1);
  for (let i = 0; i < extra; i++) {
    opens[i].classList.remove("open");
    opens[i].querySelector(".diff-card-body")?.replaceChildren();
  }
}

function paintDiffCardStatus(card, status, { allowReopen = false } = {}) {
  if (!card) return;
  const next = diffStatusPresentation(status, uiLocale());
  if (
    !allowReopen &&
    isTerminalToolStatus(card.dataset.status) &&
    !isTerminalToolStatus(next.value)
  ) return;
  card.dataset.status = next.value;
  card.classList.toggle("running", next.running);
  card.classList.toggle("done", next.done);
  card.classList.toggle("failed", next.failed);
  const label = card.querySelector(".d-status");
  if (label) {
    label.textContent = next.label;
    label.classList.toggle("hidden", !next.label);
  }
}

function foldToolCardIntoDiff(state, id, diffCard) {
  if (!state || !id || !diffCard) return;
  const toolCard = state.toolCardMap?.get(id);
  if (!toolCard) return;
  upsertDiffToolPayload(diffCard, id, toolCard._payload);
  const group = toolCard.closest?.(".tool-group");
  toolCard.remove();
  state.toolCardMap.delete(id);
  if (!group) return;
  const remaining = group.querySelectorAll(":scope > .tool-group-body > .tool-card").length;
  if (!remaining) {
    if (state.activeToolGroup === group) state.activeToolGroup = null;
    group.remove();
  } else {
    updateToolGroup(group);
  }
}

function appendDiffCard(change, renderContext = null) {
  if (!change?.path && !change?.relativePath) return;
  const context = renderContext || sessionRenderContext(change?.sessionId || activeId);
  const pane = context.pane || ui.inner;
  const state = context.state || ensureSessionUi(context.sessionId || activeId);
  const cards = state?.diffCardMap || new Map();
  if (state) state.activeToolGroup = null;
  pane.querySelector(".welcome")?.remove();
  const absPath = change.path || "";
  const pathKey = normalizeDiffPath(absPath || change.relativePath);
  const id = change.toolCallId || absPath || `d-${Date.now()}`;
  const stepHost = thoughtStepHost(context);
  const pathCards = stepHost
    ? (stepHost._diffPathMap ||= new Map())
    : state?.diffPathMap || new Map();
  let card = pathKey ? pathCards.get(pathKey) : cards.get(id);
  if (card && !card.isConnected) card = null;
  if (!card) {
    const host = stepHost || pane;
    card = document.createElement("div");
    card.className = "diff-card";
    card.dataset.id = id;
    card.innerHTML = `
      <button type="button" class="diff-card-head" aria-expanded="false">
        <span class="d-badge"></span>
        <span class="d-path"></span>
        <span class="d-count hidden"></span>
        <span class="d-status hidden"></span>
        <span class="d-stats"></span>
        <span class="t-chev">▾</span>
      </button>
      <div class="diff-actions">
        <button type="button" class="d-act" data-act="open" title="用系统默认程序打开">打开</button>
        <button type="button" class="d-act" data-act="reveal" title="在文件管理器中显示">定位</button>
        <button type="button" class="d-act" data-act="copy" title="复制绝对路径">复制路径</button>
      </div>
      <div class="diff-card-body"></div>
      <div class="diff-foot hidden"></div>`;
    card.querySelector(".diff-card-head").onclick = () => {
      card.classList.toggle("open");
      card.querySelector(".diff-card-head").setAttribute("aria-expanded", String(card.classList.contains("open")));
      if (card.classList.contains("open")) collapseOlderOpenDiffs(card, pane);
    };
    card.querySelector(".diff-actions").addEventListener("click", async (e) => {
      const btn = e.target.closest(".d-act");
      if (!btn) return;
      e.stopPropagation();
      const p = card.dataset.path;
      if (!p) return;
      const act = btn.dataset.act;
      try {
        if (act === "open") {
          await grokDesktop.openPath(p);
        } else if (act === "reveal") {
          await grokDesktop.showItem(p);
        } else if (act === "copy") {
          await navigator.clipboard?.writeText(p);
          btn.textContent = "已复制";
          setTimeout(() => {
            btn.textContent = "复制路径";
          }, 1200);
        }
      } catch (err) {
        appendBanner(`操作失败：${err.message || err}`, "error");
      }
    });
    host.appendChild(card);
  }
  cards.set(id, card);
  if (pathKey) pathCards.set(pathKey, card);

  card.dataset.path = card.dataset.path || absPath;
  if (!card._changes) card._changes = new Map();
  card._changes.set(String(id), change);
  const edits = [...card._changes.values()];
  const officialTitle = String(change.title || "").trim();
  const badgeHit = officialTitle.match(/^(Write|Edit|Create|Read|Delete|Patch)\b/i);
  const badge = edits.length > 1
    ? "Edit"
    : badgeHit
      ? badgeHit[1]
      : officialTitle && officialTitle.length <= 16
        ? officialTitle
        : "Edit";
  const badgeEl = card.querySelector(".d-badge");
  if (badgeEl) badgeEl.textContent = badge;
  const pathLabel = diffPathLabel(change);
  const pathEl = card.querySelector(".d-path");
  pathEl.textContent = pathLabel;
  pathEl.title = absPath || pathLabel;
  const countEl = card.querySelector(".d-count");
  if (countEl) {
    countEl.textContent = uiLocale() === "en" ? `${edits.length} edits` : `${edits.length} 次修改`;
    countEl.classList.toggle("hidden", edits.length < 2);
  }

  const add = edits.reduce((sum, item) => sum + Number(item.stats?.added || 0), 0);
  const del = edits.reduce((sum, item) => sum + Number(item.stats?.deleted || 0), 0);
  const isNew = edits.some((item) => item.exists === false);
  card.querySelector(".d-stats").innerHTML =
    `<span class="add">+${add}</span> <span class="del">−${del}</span>` +
    (isNew ? ' <span class="d-new">新文件</span>' : "");

  upsertDiffToolPayload(card, id, change);
  foldToolCardIntoDiff(state, id, card);

  // Keep hunks on the card; only paint lines when expanded (long-chat scroll win)
  card._hunks = edits.flatMap((item, index) => {
    const hunks = Array.isArray(item.hunks) ? item.hunks : [];
    if (!index) return hunks;
    const label = uiLocale() === "en" ? `Edit ${index + 1}` : `第 ${index + 1} 次修改`;
    return [{ type: "meta", text: `— ${label} —` }, ...hunks];
  });
  card._trunc = edits.reduce((acc, item) => ({
    ...acc,
    ...(item.truncated || {}),
    lines: !!(acc.lines || item.truncated?.lines),
    fileTooLarge: !!(acc.fileTooLarge || item.truncated?.fileTooLarge),
  }), {});
  card._absPath = card._absPath || absPath;

  const head = card.querySelector(".diff-card-head");
  if (head && !head._lazyBound) {
    head._lazyBound = true;
    head.addEventListener("click", () => {
      // after toggle in other handler — next frame paint
      requestAnimationFrame(() => {
        if (card.classList.contains("open")) paintDiffBody(card);
        else {
          card.querySelector(".diff-card-body")?.replaceChildren();
        }
      });
    });
  }
  if (card.classList.contains("open")) paintDiffBody(card);
  else card.querySelector(".diff-card-body")?.replaceChildren();
  updateThoughtStepCount(card.closest(".thought-block"));

  noteCallActivity(change.sessionId || activeId, "正在修改 · " + shortTargetLabel(pathLabel));

  if (context.isActive) scrollThreadToBottom({ force: threadFollowBottom });
  const sid = change.sessionId || activeId;
  if (sid && !isAgentBusy(sid) && !promptInFlight.has(sid)) scheduleTurnFileSummary(sid);
  return card;
}


function beginTurnFileWatch(sid) {
  const pane = (sid && typeof getPane === "function" ? getPane(sid) : null) || ui.inner;
  pane?.querySelectorAll?.(":scope > .turn-files[data-live='1']").forEach((el) => {
    el.dataset.live = "0";
  });
}

function diffsAfterLastUser(pane) {
  if (!pane) return [];
  const users = pane.querySelectorAll(":scope > .turn.user");
  const lastUser = users[users.length - 1];
  return [...pane.querySelectorAll(".diff-card")].filter((card) =>
    !lastUser || !!(lastUser.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
}

function fileKeyFromCard(card) {
  const p = normalizeDiffPath(card.dataset.path || card._absPath || "");
  if (p) return p;
  return String(card.querySelector(".d-path")?.textContent || "").trim().toLowerCase();
}

function cardDiffStats(card) {
  const hunks = card._hunks || [];
  if (hunks.length) {
    return {
      add: hunks.filter((h) => h.type === "add").length,
      del: hunks.filter((h) => h.type === "del").length,
    };
  }
  const txt = card.querySelector(".d-stats")?.textContent || "";
  const am = txt.match(/\+(\d+)/);
  const dm = txt.match(/[−-]\s*(\d+)/);
  return { add: am ? Number(am[1]) : 0, del: dm ? Number(dm[1]) : 0 };
}

function mergeTurnFiles(diffs) {
  const map = new Map();
  for (const card of diffs || []) {
    const key = fileKeyFromCard(card);
    if (!key) continue;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        path: card.dataset.path || card._absPath || "",
        label: card.querySelector(".d-path")?.textContent || "",
        badge: card.querySelector(".d-badge")?.textContent || "Edit",
        add: 0,
        del: 0,
        edits: [],
      };
      map.set(key, g);
    }
    const badge = card.querySelector(".d-badge")?.textContent || "Edit";
    if (badge && g.badge !== badge) g.badge = "Edit";
    const changes = card._changes?.size ? [...card._changes.values()] : [null];
    for (const change of changes) {
      const st = change
        ? { add: Number(change.stats?.added || 0), del: Number(change.stats?.deleted || 0) }
        : cardDiffStats(card);
      g.add += st.add;
      g.del += st.del;
      g.edits.push({
        badge,
        add: st.add,
        del: st.del,
        hunks: change && Array.isArray(change.hunks) ? change.hunks : null,
        card,
      });
    }
  }
  return [...map.values()];
}

function paintHunksInto(body, hunks) {
  body.replaceChildren();
  const list = Array.isArray(hunks) ? hunks : [];
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "diff-line same";
    empty.textContent = "（无行级差异预览）";
    body.appendChild(empty);
    return;
  }
  let sameRun = 0;
  for (const h of list) {
    if (h.type === "same") {
      sameRun++;
      if (sameRun > 2) continue;
    } else {
      sameRun = 0;
    }
    const line = document.createElement("div");
    line.className = `diff-line ${h.type || "same"}`;
    if (h.type === "meta") {
      line.textContent = h.text ?? "";
    } else {
      const tx = document.createElement("span");
      tx.className = "tx";
      tx.textContent = h.text ?? "";
      const ln = document.createElement("span");
      ln.className = "ln";
      line.append(ln, tx);
    }
    body.appendChild(line);
  }
}

function closeTurnFileSheet() {
  document.getElementById("tf-sheet")?.remove();
}

function openTurnFileSheet(group) {
  closeTurnFileSheet();
  const en = uiLocale() === "en";
  const wrap = document.createElement("div");
  wrap.id = "tf-sheet";
  wrap.className = "tf-sheet";
  const back = document.createElement("div");
  back.className = "tf-sheet-back";
  const card = document.createElement("div");
  card.className = "tf-sheet-card";
  const head = document.createElement("div");
  head.className = "tf-sheet-head";
  const titles = document.createElement("div");
  const title = document.createElement("div");
  title.className = "tf-sheet-title";
  title.textContent = group.label || group.path;
  const sub = document.createElement("div");
  sub.className = "tf-sheet-sub";
  const n = group.edits.length;
  sub.textContent = en
    ? `${n} edit${n === 1 ? "" : "s"}  +${group.add} −${group.del}`
    : `${n} 次修改  +${group.add} −${group.del}`;
  titles.append(title, sub);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tf-sheet-close";
  closeBtn.textContent = en ? "Close" : "关闭";
  head.append(titles, closeBtn);
  const body = document.createElement("div");
  body.className = "tf-sheet-body";
  group.edits.forEach((ed, i) => {
    const sec = document.createElement("div");
    sec.className = "tf-sheet-edit";
    const h = document.createElement("div");
    h.className = "tf-sheet-edit-h";
    h.textContent = en
      ? `Edit ${i + 1} · ${ed.badge}  +${ed.add} −${ed.del}`
      : `第 ${i + 1} 次 · ${ed.badge}  +${ed.add} −${ed.del}`;
    const diff = document.createElement("div");
    diff.className = "tf-sheet-diff";
    let hunks = Array.isArray(ed.hunks)
      ? ed.hunks
      : ed.card && Array.isArray(ed.card._hunks)
        ? ed.card._hunks
        : [];
    if (!hunks.length && ed.card) {
      try { paintDiffBody(ed.card); } catch { /* ignore */ }
      hunks = ed.card._hunks || [];
    }
    if (!hunks.length && ed.card) {
      const src = ed.card.querySelector(".diff-card-body");
      if (src && src.childElementCount) {
        for (const n of src.children) diff.appendChild(n.cloneNode(true));
      } else {
        paintHunksInto(diff, hunks);
      }
    } else {
      paintHunksInto(diff, hunks);
    }
    sec.append(h, diff);
    body.appendChild(sec);
  });
  card.append(head, body);
  wrap.append(back, card);
  const onKey = (e) => {
    if (e.key === "Escape") {
      closeTurnFileSheet();
      document.removeEventListener("keydown", onKey);
    }
  };
  back.onclick = () => { document.removeEventListener("keydown", onKey); closeTurnFileSheet(); };
  closeBtn.onclick = back.onclick;
  document.addEventListener("keydown", onKey);
  document.body.appendChild(wrap);
}

function buildTurnFileBox(groups, live) {
  const box = document.createElement("div");
  box.className = "turn-files";
  box.dataset.live = live ? "1" : "0";
  const head = document.createElement("div");
  head.className = "tf-head";
  head.textContent = uiLocale() === "en"
    ? `Changed ${groups.length} file${groups.length === 1 ? "" : "s"}`
    : `本轮改了 ${groups.length} 个文件`;
  const list = document.createElement("div");
  list.className = "tf-list";
  for (const it of groups) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tf-row";
    const badge = document.createElement("span");
    badge.className = "tf-badge";
    badge.textContent = it.edits.length > 1 ? `${it.edits.length}次` : it.badge;
    const name = document.createElement("span");
    name.className = "tf-name";
    name.textContent = it.label || it.path;
    name.title = it.path || it.label;
    const stats = document.createElement("span");
    stats.className = "tf-stats";
    stats.innerHTML = `<span class="add">+${it.add}</span> <span class="del">−${it.del}</span>`;
    btn.append(badge, name, stats);
    btn.onclick = () => openTurnFileSheet(it);
    list.appendChild(btn);
  }
  box.append(head, list);
  return box;
}

function appendTurnFileSummary(sid) {
  const pane = (sid && typeof getPane === "function" ? getPane(sid) : null)
    || (sid === activeId || !sid ? ui.inner : null);
  if (!pane) return;
  const diffs = diffsAfterLastUser(pane);
  pane.querySelectorAll(":scope > .turn-files[data-live='1']").forEach((el) => el.remove());
  if (!diffs.length) return;
  pane.appendChild(buildTurnFileBox(mergeTurnFiles(diffs), true));
  if ((sid === activeId || !sid) && threadFollowBottom) scrollThreadToBottom({ force: true });
}

function scheduleTurnFileSummary(sid) {
  const id = sid || activeId;
  if (!id) return;
  const st = ensureSessionUi(id);
  if (!st) return;
  clearTimeout(st._tfTimer);
  st._tfTimer = setTimeout(() => appendTurnFileSummary(id), 240);
}

function sealTurnFileSummaries(pane) {
  if (!pane) return;
  const kids = [...pane.children];
  const ranges = [];
  let lastUser = -1;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].classList?.contains("turn") && kids[i].classList.contains("user")) {
      if (lastUser >= 0) ranges.push([lastUser, i]);
      lastUser = i;
    }
  }
  if (lastUser >= 0) ranges.push([lastUser, kids.length]);
  for (let r = ranges.length - 1; r >= 0; r--) {
    const [from, to] = ranges[r];
    const slice = kids.slice(from + 1, to);
    if (slice.some((el) => el.classList.contains("turn-files"))) continue;
    const diffs = slice.flatMap((el) =>
      el.classList.contains("diff-card") ? [el] : [...el.querySelectorAll(".diff-card")],
    );
    if (!diffs.length) continue;
    const box = buildTurnFileBox(mergeTurnFiles(diffs), false);
    const lastDiff = diffs[diffs.length - 1];
    const anchor = slice.findLast((el) => el === lastDiff || el.contains(lastDiff));
    (anchor || kids[to - 1])?.after(box);
  }
}

function paintDiffBody(card) {
  const body = card.querySelector(".diff-card-body");
  if (!body) return;
  body.replaceChildren();
  const hunks = card._hunks || [];
  let sameRun = 0;
  const MAX_SAME = 2;
  let rendered = 0;
  const MAX_RENDER = 180;
  let delRun = 0;
  let addRun = 0;
  let skippedDel = 0;
  let skippedAdd = 0;
  let paintedAdd = 0;
  const MAX_DEL_RUN = 36;
  const MAX_ADD_RUN = 80;
  const totalAdd = hunks.filter((h) => h.type === "add").length;
  const totalDel = hunks.filter((h) => h.type === "del").length;

  const appendLine = (type, text) => {
    const line = document.createElement("div");
    line.className = `diff-line ${type || "same"}`;
    if (type === "meta") {
      line.textContent = text ?? "";
      body.appendChild(line);
      rendered++;
      return;
    }
    const tx = document.createElement("span");
    tx.className = "tx";
    tx.textContent = text ?? "";
    const ln = document.createElement("span");
    ln.className = "ln";
    line.append(ln, tx);
    body.appendChild(line);
    rendered++;
  };

  for (const h of hunks) {
    if (rendered >= MAX_RENDER) {
      if (h.type === "add") skippedAdd++;
      else if (h.type === "del") skippedDel++;
      continue;
    }
    if (h.type === "same") {
      sameRun++;
      delRun = 0;
      addRun = 0;
      if (sameRun > MAX_SAME) continue;
      appendLine("same", h.text);
      continue;
    }
    if (h.type === "meta") {
      sameRun = 0;
      delRun = 0;
      addRun = 0;
      appendLine("meta", h.text);
      continue;
    }
    sameRun = 0;
    if (h.type === "del") {
      addRun = 0;
      delRun++;
      if (delRun > MAX_DEL_RUN && totalAdd > 0 && paintedAdd === 0) {
        skippedDel++;
        continue;
      }
      appendLine("del", h.text);
      continue;
    }
    if (h.type === "add") {
      if (skippedDel && paintedAdd === 0) {
        appendLine("meta", `… 省略 ${skippedDel} 行删除，下面是新增`);
        skippedDel = 0;
      }
      delRun = 0;
      addRun++;
      if (addRun > MAX_ADD_RUN) {
        skippedAdd++;
        continue;
      }
      paintedAdd++;
      appendLine("add", h.text);
      continue;
    }
    appendLine(h.type || "same", h.text);
  }
  if (!hunks.length) {
    const empty = document.createElement("div");
    empty.className = "diff-line same";
    empty.textContent = "（无行级差异预览）";
    body.appendChild(empty);
  }
  if (skippedDel || skippedAdd) {
    const more = document.createElement("div");
    more.className = "diff-line meta";
    const bits = [];
    if (skippedDel) bits.push(`省略 ${skippedDel} 行删除`);
    if (skippedAdd) bits.push(`省略 ${skippedAdd} 行新增`);
    if (!bits.length) bits.push(`仅预览 ${rendered} 行`);
    more.textContent = `… ${bits.join(" · ")} · 共 +${totalAdd} −${totalDel}，点「打开」看全文`;
    body.appendChild(more);
  }

  const foot = card.querySelector(".diff-foot");
  if (!foot) return;
  const tr = card._trunc || {};
  const notes = [];
  if (tr.fileTooLarge) {
    notes.push(
      `原文件过大${tr.fileSize ? `（${formatBytesUi(tr.fileSize)}）` : ""}，已跳过全文对比`,
    );
  } else if (tr.lines) {
    notes.push(
      `预览截断：最多 ${tr.maxLines || 200} 行（${tr.beforeLines ?? "?"} → ${tr.afterLines ?? "?"} 行）`,
    );
  }
  if (card._absPath) notes.push(card._absPath);
  if (notes.length) {
    foot.classList.remove("hidden");
    foot.textContent = notes.join(" · ");
  } else {
    foot.classList.add("hidden");
  }
}

function formatBytesUi(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizePlanEntries(update) {
  if (!update) return [];
  const entries =
    update.entries ||
    update.plan ||
    update.items ||
    update.steps ||
    (Array.isArray(update) ? update : null);
  if (!Array.isArray(entries)) {
    // single content blob
    if (update.content || update.text) {
      return [{ content: update.content || update.text, status: update.status || "pending" }];
    }
    return [];
  }
  return entries.map((e) => {
    if (typeof e === "string") return { content: e, status: "pending" };
    return {
      content: e.content || e.text || e.title || e.description || JSON.stringify(e),
      status: e.status || e.state || "pending",
      priority: e.priority,
    };
  });
}

const TOOL_STATUS_ZH = {
  running: "运行中",
  pending: "等待",
  in_progress: "运行中",
  updated: "更新中",
  completed: "完成",
  complete: "完成",
  success: "完成",
  failed: "失败",
  error: "失败",
  cancelled: "已取消",
  canceled: "已取消",
};

function statusLabelZh(map, raw) {
  const key = String(raw || "").toLowerCase().replace(/\s+/g, "_");
  return map[key] || raw || "";
}


function isGoalChrome() {
  const auto = activeId ? sessionAutomation.get(activeId) : null;
  if (auto?.kind === "goal") return true;
  return composerMode === "goal";
}

function syncPlanChrome(entryCount = 0) {
  const goal = isGoalChrome();
  const label = $("plan-toggle-label");
  if (label) label.textContent = goal
    ? (typeof t === "function" ? t("chat.goal") : "目标")
    : (typeof t === "function" ? t("chat.plan") : "计划");
  if (ui.planToggle) {
    ui.planToggle.title = goal
      ? (typeof t === "function" ? t("chat.goalHint") : "打开 / 关闭右侧目标面板")
      : (typeof t === "function" ? t("chat.planHint") : "打开 / 关闭右侧计划面板");
    ui.planToggle.classList.toggle("is-goal", goal);
  }
  const title = $("plan-panel-label");
  if (title) title.textContent = goal
    ? (typeof t === "function" ? t("chat.goalTitle") : "执行目标")
    : (typeof t === "function" ? t("chat.planTitle") : "执行计划");
  const badge = $("plan-badge");
  if (badge) {
    const n = Number(entryCount) || 0;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", n <= 0);
  }
}

function renderPlan(planData) {
  if (!ui.planList) return;
  const entries = normalizePlanEntries(planData);
  const badge = $("plan-badge");
  const progress = $("plan-progress");

  // Plan toggle lives only in the top toolbar — always available when session open.
  ui.planToggle?.classList.remove("hidden");
  syncPlanChrome(entries.length);

  if (!entries.length) {
    ui.planList.innerHTML = `<div class="plan-empty">${t(isGoalChrome() ? "chat.goalEmpty" : "chat.planEmpty")}</div>`;
    ui.planToggle?.classList.remove("has-plan");
    if (badge) {
      badge.classList.add("hidden");
      badge.classList.remove("done");
      badge.textContent = "0";
    }
    if (progress) {
      progress.classList.add("hidden");
      progress.textContent = "";
    }
    renderWorkCard();
    return;
  }

  ui.planToggle?.classList.add("has-plan");

  const done = entries.filter((e) =>
    /completed|done|success/i.test(String(e.status || "")),
  ).length;
  if (badge) {
    badge.textContent = String(entries.length);
    badge.classList.remove("hidden");
    badge.classList.toggle("done", done === entries.length && entries.length > 0);
  }
  if (progress) {
    progress.textContent = `${done}/${entries.length}`;
    progress.classList.remove("hidden");
  }

  const kinds = entries.map((e) => planStepKind(e.status));
  const allDone = done === entries.length && entries.length > 0;
  if (allDone) {
    clearFinishedGoal(activeId, { paint: false });
    setPlanOpen(false);
    ui.planList.innerHTML = `<div class="plan-empty">${t(isGoalChrome() ? "chat.goalEmpty" : "chat.planEmpty")}</div>`;
    ui.planToggle?.classList.remove("has-plan");
    if (badge) {
      badge.classList.add("hidden");
      badge.classList.remove("done");
      badge.textContent = "0";
    }
    if (progress) {
      progress.classList.add("hidden");
      progress.textContent = "";
    }
    renderWorkCard();
    return;
  }

  ui.planList.replaceChildren();
  const sheet = document.createElement("div");
  sheet.className = "plan-sheet";

  const list = document.createElement("ol");
  list.className = "work-steps plan-card-steps";
  for (const e of entries) {
    const kind = planStepKind(e.status);
    const li = document.createElement("li");
    li.className = "work-step is-" + kind;
    const mark = document.createElement("span");
    mark.className = "work-mark";
    mark.setAttribute("aria-hidden", "true");
    const txt = document.createElement("span");
    txt.className = "work-step-text";
    txt.textContent = e.content || "";
    li.append(mark, txt);
    list.appendChild(li);
  }
  sheet.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "plan-card-foot";
  const pill = document.createElement("span");
  pill.className = "work-pill plan-card-pill" + (allDone ? " is-done" : "");
  if (!allDone) {
    const spin = document.createElement("span");
    spin.className = "work-pill-spin";
    spin.setAttribute("aria-hidden", "true");
    pill.appendChild(spin);
  }
  const pillText = document.createElement("span");
  const en = uiLocale() === "en";
  const tpl = typeof t === "function"
    ? t(allDone ? "work.stepDone" : "work.stepN")
    : (allDone ? (en ? "Done {m} / {m}" : "已完成 {m} / {m}") : (en ? "Step {n} / {m}" : "第 {n} / {m} 步"));
  const nowIdx = kinds.findIndex((k) => k === "now");
  const stepN = nowIdx >= 0 ? nowIdx + 1 : Math.min(entries.length, done + 1);
  pillText.textContent = String(tpl).replace("{n}", String(stepN)).split("{m}").join(String(entries.length));
  pill.appendChild(pillText);
  foot.appendChild(pill);
  sheet.appendChild(foot);
  ui.planList.appendChild(sheet);
  renderWorkCard();
}

function setPlanOpen(on) {
  planOpen = !!on;
  const el = ui.planPanel || $("plan-panel");
  if (el) {
    el.classList.toggle("hidden", !planOpen);
    el.hidden = !planOpen;
    el.classList.toggle("show", planOpen);
  }
  ui.planToggle?.classList.toggle("active", planOpen);
}
let subagentOpen = false;

function setSubagentOpen(on) {
  subagentOpen = !!on;
  const el = ui.subagentPanel || $("subagent-panel");
  if (el) {
    el.classList.toggle("hidden", !subagentOpen);
    el.hidden = !subagentOpen;
  }
  (ui.subagentToggle || $("btn-subagent-toggle"))?.classList.toggle("active", subagentOpen);
}

function appendPermissionCard(req, renderContext = null) {
  const context = renderContext || sessionRenderContext(req?.sessionId || activeId);
  const pane = context.pane || ui.inner;
  const host = thoughtStepHost(context) || pane;
  if (context.state) context.state.activeToolGroup = null;
  pane.querySelector(".welcome")?.remove();
  const card = document.createElement("div");
  card.className = "perm-card";
  const title = req.toolCall?.title || req.toolCall?.kind || t("perm.toolDefault");
  const raw = req.toolCall?.rawInput || req.toolCall?.input;
  let detail = "";
  try {
    detail = raw ? (typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)) : "";
  } catch {
    detail = String(raw || "");
  }
  card.innerHTML = `
    <h4></h4>
    <p></p>
    <pre class="perm-detail"></pre>
    <div class="perm-actions"></div>`;
  card.querySelector("h4").textContent = t("perm.needApprove");
  card.querySelector("p").textContent = title;
  const pre = card.querySelector("pre");
  if (detail) pre.textContent = detail.slice(0, 4000);
  else pre.remove();
  const actions = card.querySelector(".perm-actions");
  const options = req.options?.length
    ? req.options
    : [
        { optionId: "allow_once", name: t("perm.allowOnce") },
        { optionId: "reject_once", name: t("perm.reject") },
      ];
  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    const oid = opt.optionId || opt.kind || "";
    const isAllow = /allow/i.test(oid) || /allow|允许|批准/i.test(opt.name || "");
    btn.className = "btn " + (isAllow ? "primary" : "ghost");
    btn.textContent = opt.name || oid;
    btn.onclick = async () => {
      actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await grokDesktop.respondPermission(req.id, oid, req.sessionId);
        card.style.opacity = "0.55";
        const tag = document.createElement("div");
        tag.style.cssText = "font-size:11px;color:var(--muted);margin-top:6px";
        tag.textContent = `${t("perm.selected")}${opt.name || oid}`;
        card.appendChild(tag);
      } catch (err) {
        appendBanner(`${t("perm.fail")}${err.message}`, "error", pane, context.isActive);
      }
    };
    actions.appendChild(btn);
  }
  host.appendChild(card);
  updateThoughtStepCount(card.closest(".thought-block"));
  if (context.isActive) scrollThreadToBottom({ force: true });
}

async function runSilentSlash(sid, command, args) {
  const cmd = String(command || "").replace(/^\//, "");
  const id = sid || activeId;
  if (!id || !cmd) return;
  noteAutomationFromSlash(cmd, args || "");
  workingSessions.add(id);
  markRunStart(id);
  if (id === activeId) {
    setBusy(true);
    setStatus("working", cmd === "goal" ? "继续目标…" : `/${cmd}…`);
  }
  try {
    await grokDesktop.runSlash(cmd, args || undefined, id);
  } catch {
    await grokDesktop.prompt({
      text: args ? `/${cmd} ${args}` : `/${cmd}`,
      sessionId: id,
    });
  } finally {
    workingSessions.delete(id);
    markRunEnd(id);
    if (id === activeId) {
      setBusy(false);
      updateLiveStrip();
    }
  }
}

function clearFinishedGoal(sid, { paint = true } = {}) {
  const id = sid || activeId;
  if (!id) return false;
  const st = ensureSessionUi(id);
  if (!isPlanAllDone(st.plan)) return false;
  st.plan = null;
  st.skipGoalResume = true;
  st.goalResumeTried = true;
  st.planPanelSeen = false;
  clearSessionAutomation(id);
  if (id === activeId) {
    setPlanOpen(false);
    if (composerMode === "goal") {
      st.composerMode = "task";
      paintComposerMode("task");
    }
    if (paint) renderPlan(null);
  }
  return true;
}

function isPlanAllDone(plan) {
  const entries = normalizePlanEntries(plan);
  if (!entries.length) return false;
  return entries.every((e) => planStepKind(e.status) === "done");
}

function abortGoalResume(sid, { pause = false } = {}) {
  const id = sid || activeId;
  if (!id) return;
  const st = ensureSessionUi(id);
  st.skipGoalResume = true;
  st.goalResumeTried = true;
  if (pause) {
    const prev = sessionAutomation.get(id);
    setSessionAutomation(id, "goal", prev?.label || "goal", { paused: true });
  }
}

function shouldSkipGoalResume(id) {
  const st = ensureSessionUi(id);
  const auto = sessionAutomation.get(id);
  return !!(st.skipGoalResume || auto?.paused || isPlanAllDone(st.plan));
}

async function maybeResumeGoal(sessionId) {
  const id = sessionId || activeId;
  if (!id) return;
  const st = ensureSessionUi(id);
  if (st.stopped || st.desktopUi?.stopped || st.skipGoalResume || st.goalResumeTried) return;
  if (workingSessions.has(id) || promptInFlight.has(id)) return;
  const queued = (id === activeId ? messageQueue : st.messageQueue) || [];
  if (queued.length) return;
  const inferred = inferGoalFromSession(id, st.meta, st.history || sessionHistory);
  const auto = sessionAutomation.get(id);
  const isGoal = inferred.mode === "goal" || auto?.kind === "goal";
  if (!isGoal) return;
  if (auto?.paused || inferred.paused) return;
  if (isPlanAllDone(st.plan)) {
    clearFinishedGoal(id, { paint: id === activeId });
    return;
  }
  st.goalResumeTried = true;
  try {
    await runSilentSlash(id, "goal", "resume");
    if (shouldSkipGoalResume(id)) return;
    if (workingSessions.has(id) || promptInFlight.has(id)) return;
    const label = [auto?.label, inferred.label].find((x) => x && !/^(goal|resume|status|pause|clear)$/i.test(String(x)));
    const text = label
      ? `继续执行目标：${label}\n从中断处接着做，不要重新规划。`
      : "继续执行当前目标，从中断的步骤接着做，不要重新规划。";
    if (shouldSkipGoalResume(id)) return;
    const queued2 = (id === activeId ? messageQueue : ensureSessionUi(id).messageQueue) || [];
    if (queued2.length || promptInFlight.has(id) || workingSessions.has(id)) return;
    if (id === activeId) appendBanner("正在继续目标…");
    await sendNow({
      text,
      sessionId: id,
      skipCall: true,
      displayText: "继续目标",
    });
  } catch (err) {
    if (shouldSkipGoalResume(id)) return;
    const msg = String(err?.message || err || "");
    if (/cancel|abort|中断|停止|disposed|exited|没有活动会话|no session/i.test(msg)) return;
    st.goalResumeTried = false;
    if (id === activeId) appendBanner(`目标没能自动继续：${err?.message || err}`, "error");
  }
}

/** Run a real slash command against the live agent (no placeholders). */
async function runRealSlash(command, args) {
  if (!activeId) {
    appendBanner("请先打开一个会话", "error");
    return;
  }
  const cmd = String(command || "").replace(/^\//, "");
  const sid = activeId;
  if (await dispatchBuiltinSlash(cmd, args || "", sid, { echo: true })) return;
  if (/^(call|send-to|invoke)$/i.test(cmd)) {
    const canon = cmd.toLowerCase() === "usages" ? "usage" : cmd.toLowerCase();
    appendTurn("user", args ? `/${canon} ${args}` : `/${canon}`, { clampable: false });
    await handleDesktopSlash(canon, args || "", sid);
    return;
  }
  noteAutomationFromSlash(cmd, args || "");
  appendTurn("user", args ? `/${cmd} ${args}` : `/${cmd}`, { clampable: false });
  const st = ensureSessionUi(sid);
  finishThoughtClock(sid);
  st.streamingEl = null;
  st.assistantBody = null;
  workingSessions.add(sid);
  markRunStart(sid);
  setBusy(true);
  if (/^compact$/i.test(cmd)) {
    markCompacting(sid);
  } else {
    setStatus("working", `/${cmd}…`);
  }
  try {
    await grokDesktop.runSlash(cmd, args || undefined, sid);
    if (activeId === sid) setStatus("ready", "就绪");
  } catch (err) {
    // fallback: normal prompt path
    try {
      await grokDesktop.prompt({
        text: args ? `/${cmd} ${args}` : `/${cmd}`,
        sessionId: sid,
      });
      if (activeId === sid) setStatus("ready", "就绪");
    } catch (err2) {
      if (activeId === sid) {
        setStatus("error", err2.message || err.message);
        appendBanner(`命令失败：${err2.message || err.message}`, "error");
      }
    }
  } finally {
    workingSessions.delete(sid);
    markRunEnd(sid);
    if (activeId === sid) {
      setBusy(false);
      updateLiveStrip();
      if (activeMeta) applyHeader(activeMeta, { soft: true });
    }
    refreshSidebarSessionState();
  }
}

function setBusy() {
  // Keep composer open for 插话 while agent works
  setComposerEnabled(!!activeId && !connecting);
  refreshSendButtonState();
  autosize();
}

function autosize() {
  ui.input.style.height = "auto";
  ui.input.style.height = Math.min(ui.input.scrollHeight, 130) + "px";
}

// ── Views ──────────────────────────────────────────────

function switchView(name) {
  closeModelPop();
  view = name;

  // Desktop layout: settings takes over the full app chrome.
  document.getElementById("app")?.classList.toggle("settings-mode", name === "settings");

  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${name}`);
  });
  document.querySelectorAll(".rail-item[data-view]").forEach((btn) => {
    const active = btn.dataset.view === name;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  ui.navSettings?.classList.toggle("active", name === "settings");
  if (name === "settings") ui.navSettings?.setAttribute("aria-current", "page");
  else ui.navSettings?.removeAttribute("aria-current");

  if (name !== "settings") {
    ui.sessionSection.style.display = name === "chat" ? "" : "none";
  }
  if (name === "memory") void loadMemory();
  if (name === "skills") void loadSkills();
  if (name === "plugins") void loadPlugins();
  if (name === "settings") {
    showSettingsPanel(settingsPanel || "profile");
    void loadSettings();
  }
  const dock = $("subagent-panel");
  if (dock) {
    const show = name === "chat" && subagentOpen;
    dock.classList.toggle("hidden", !show);
    dock.hidden = !show;
  }
}

function initializeSettingsA11y() {
  const nav = document.querySelector(".settings-nav-scroll");
  if (!nav) return;
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-orientation", "vertical");
  const buttons = [...nav.querySelectorAll(".sn-item[data-panel]")];
  for (const button of buttons) {
    const panelName = button.dataset.panel;
    const panel = document.querySelector(`.settings-panel[data-panel="${panelName}"]`);
    const buttonId = `settings-tab-${panelName}`;
    button.id = buttonId;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", panel?.id || `panel-${panelName}`);
    if (panel) {
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", buttonId);
      panel.tabIndex = 0;
    }
  }
  nav.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const visible = buttons.filter((button) => !button.classList.contains("hidden-by-search"));
    if (!visible.length) return;
    event.preventDefault();
    const current = visible.indexOf(document.activeElement);
    const index = a11y.nextMenuIndex?.(current, visible.length, event.key) ?? current;
    const next = visible[Math.max(0, index)];
    next?.focus();
    if (next?.dataset.panel) showSettingsPanel(next.dataset.panel);
  });
}

initializeSettingsA11y();

document.querySelectorAll(".rail-item[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

ui.navSettings?.addEventListener("click", () => switchView("settings"));
ui.settingsBack?.addEventListener("click", () => switchView("chat"));

function showSettingsPanel(id) {
  settingsPanel = id || "profile";
  document.querySelectorAll(".settings-panel").forEach((p) => {
    const active = p.dataset.panel === settingsPanel;
    p.classList.toggle("active", active);
    p.setAttribute("aria-hidden", active ? "false" : "true");
  });
  document.querySelectorAll(".sn-item").forEach((btn) => {
    const active = btn.dataset.panel === settingsPanel;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
  });
  if (settingsPanel === "skills") void fillSettingsSkills();
  if (settingsPanel === "plugins") void fillSettingsPlugins();
  if (settingsPanel === "mcp") void fillSettingsMcp();
  if (settingsPanel === "automation") void fillSettingsAutomation();
  if (settingsPanel === "profile") void fillSettingsProfile();
}

async function fillSettingsAutomation() {
  await fillSettingsHooks();
}

async function fillSettingsHooks() {
  const box = $("settings-hooks-list");
  if (!box) return;
  box.innerHTML = `<div class="list-empty">${uiLocale() === "en" ? "Scanning…" : "扫描中…"}</div>`;
  try {
    const r = await grokDesktop.listHooks?.(activeMeta?.cwd || undefined);
    const list = r?.hooks || [];
    box.replaceChildren();
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.innerHTML =
        uiLocale() === "en"
          ? `No hooks found<br><span style="opacity:.8">Add JSON under ~/.grok/hooks/</span>`
          : `未发现 Hooks<br><span style="opacity:.8">可在 ~/.grok/hooks/ 下放置 *.json</span>`;
      box.appendChild(empty);
      return;
    }
    for (const h of list) {
      const row = document.createElement("div");
      row.className = "embed-row";
      const left = document.createElement("div");
      left.className = "embed-row-main";
      const title = document.createElement("strong");
      title.textContent = h.name || h.path;
      const meta = document.createElement("span");
      meta.className = "embed-meta";
      const ev = (h.events || []).slice(0, 6).join(", ") || "—";
      meta.textContent = `${h.scope || ""}${h.compat ? " · compat" : ""} · ${ev}`;
      meta.title = h.path || "";
      left.append(title, meta);
      row.appendChild(left);
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = `<div class="list-error">${err?.message || err}</div>`;
  }
}

async function fillSettingsSkills() {
  const box = $("settings-skills-list");
  if (!box) return;
  box.innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const list = await grokDesktop.listSkills({ cwd: activeMeta?.cwd || lastUsedCwd || undefined });
    box.replaceChildren();
    if (!list.length) {
      box.innerHTML =
        '<div class="list-empty">未发现 Skills<br><span style="opacity:.8">可在侧栏 Skills 页新建，或放入 ~/.grok/skills</span></div>';
      return;
    }
    // 设置页只显示摘要（最多 12 条）
    const shown = list.slice(0, 12);
    for (const s of shown) {
      const row = document.createElement("div");
      row.className = "embed-item";
      row.innerHTML = `<div><div class="name"></div><div class="sub"></div></div><button type="button" class="btn ghost">调用</button>`;
      row.querySelector(".name").textContent = s.name;
      row.querySelector(".sub").textContent = (s.description || s.scope || "").slice(0, 120);
      row.querySelector("button").onclick = async () => {
        switchView("chat");
        if (!activeId) {
          appendBanner("请先打开会话，再调用 Skill", "error");
          return;
        }
        await runRealSlash(s.name);
      };
      box.appendChild(row);
    }
    if (list.length > shown.length) {
      const more = document.createElement("div");
      more.className = "list-empty";
      more.style.padding = "8px";
      more.textContent = `另有 ${list.length - shown.length} 个 · 在侧栏 Skills 查看全部`;
      box.appendChild(more);
    }
  } catch (err) {
    box.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

async function fillSettingsPlugins() {
  const box = $("settings-plugins-list");
  if (!box) return;
  box.innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const list = await grokDesktop.listInstalledPlugins();
    box.replaceChildren();
    if (!list?.length) {
      box.innerHTML = '<div class="list-empty">尚未安装插件</div>';
      return;
    }
    for (const p of list) {
      const name = p.name || "plugin";
      const row = document.createElement("div");
      row.className = "embed-item";
      row.innerHTML = `<div><div class="name"></div><div class="sub"></div></div><button type="button" class="btn danger">卸载</button>`;
      row.querySelector(".name").textContent = name;
      row.querySelector(".sub").textContent = p.description || p.status || "";
      row.querySelector("button").onclick = async () => {
        if (!confirm(`卸载 ${name}？`)) return;
        await grokDesktop.uninstallPlugin(name);
        await fillSettingsPlugins();
      };
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

async function fillSettingsMcp() {
  const box = $("settings-mcp-list");
  if (!box) return;
  box.innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const data = await grokDesktop.listMcp();
    box.replaceChildren();
    if (data.error && !data.servers?.length) {
      box.innerHTML = `<div class="list-error">${data.error}</div>`;
      return;
    }
    if (!data.servers?.length) {
      box.innerHTML = `<div class="list-empty">${data.raw || "未配置 MCP 服务器"}</div>`;
      return;
    }
    for (const s of data.servers) {
      const row = document.createElement("div");
      row.className = "embed-item";
      row.innerHTML = `<div><div class="name"></div><div class="sub"></div></div><button type="button" class="btn danger">移除</button>`;
      row.querySelector(".name").textContent = s.name;
      row.querySelector(".sub").textContent = s.line || "";
      row.querySelector("button").onclick = async () => {
        if (!confirm(`移除 MCP ${s.name}？`)) return;
        await grokDesktop.removeMcp(s.name);
        await fillSettingsMcp();
      };
      box.appendChild(row);
    }
  } catch (err) {
    box.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

$("settings-plugin-install")?.addEventListener("click", async () => {
  const spec = $("settings-plugin-spec")?.value?.trim();
  if (!spec) return;
  try {
    await grokDesktop.installPlugin(spec);
    $("settings-plugin-spec").value = "";
    await fillSettingsPlugins();
  } catch (err) {
    alert(err.message || err);
  }
});
$("mcp-add")?.addEventListener("click", async () => {
  const name = $("mcp-name")?.value?.trim();
  const cmd = $("mcp-cmd")?.value?.trim();
  if (!name || !cmd) return alert("填写名称和命令");
  try {
    // split command into parts for grok mcp add
    const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [cmd];
    const command = parts[0].replace(/^"|"$/g, "");
    const args = parts.slice(1).map((p) => p.replace(/^"|"$/g, ""));
    await grokDesktop.addMcp({ name, command, args });
    $("mcp-name").value = "";
    $("mcp-cmd").value = "";
    await fillSettingsMcp();
  } catch (err) {
    alert(err.message || err);
  }
});
$("mcp-doctor")?.addEventListener("click", async () => {
  const out = $("mcp-doctor-out");
  if (out) {
    out.classList.remove("hidden");
    out.textContent = "诊断中…";
  }
  try {
    const r = await grokDesktop.doctorMcp();
    if (out) out.textContent = r.output || "完成";
  } catch (err) {
    if (out) out.textContent = err.message || String(err);
  }
});

document.querySelectorAll(".sn-item").forEach((btn) => {
  btn.addEventListener("click", () => showSettingsPanel(btn.dataset.panel));
});

ui.settingsSearch?.addEventListener("input", () => {
  const q = (ui.settingsSearch.value || "").trim().toLowerCase();
  document.querySelectorAll(".sn-item").forEach((btn) => {
    const text = btn.textContent.toLowerCase();
    btn.classList.toggle("hidden-by-search", !!q && !text.includes(q));
  });
});

$("settings-goto-memory")?.addEventListener("click", () => switchView("memory"));
$("settings-goto-skills")?.addEventListener("click", () => switchView("skills"));
$("settings-goto-plugins")?.addEventListener("click", () => switchView("plugins"));
$("auto-goto-skills")?.addEventListener("click", () => switchView("skills"));
$("auto-insert-goal")?.addEventListener("click", () => insertSlashIntoComposer("/goal "));
$("auto-insert-loop")?.addEventListener("click", () => insertSlashIntoComposer("/loop "));
$("auto-hooks-refresh")?.addEventListener("click", () => void fillSettingsHooks());
$("work-goal-pause")?.addEventListener("click", () => {
  if (!activeId) return;
  abortGoalResume(activeId, { pause: true });
  void stopActiveTurn();
  void runRealSlash("goal", "pause");
});
$("work-goal-clear")?.addEventListener("click", () => {
  if (!activeId) return;
  void runRealSlash("goal", "clear");
  clearSessionAutomation(activeId);
  paintComposerMode("task");
});
$("work-loop-stop")?.addEventListener("click", () => {
  if (!activeId) return;
  void runRealSlash("loop", "clear");
  clearSessionAutomation(activeId);
});
$("work-plan-all")?.addEventListener("click", () => setPlanOpen(true));
$("work-plan-more")?.addEventListener("click", () => setPlanOpen(true));
$("work-plan-pill")?.addEventListener("click", () => setPlanOpen(true));
// ── Model picker ───────────────────────────────────────

const DEFAULT_MODEL_ID = "grok-4.6";
const DEFAULT_EFFORT = "xhigh";

function resolvePreferredModelId() {
  const list = availableModels || [];
  const hints = ["grok-4.6", "grok-4-6"];
  for (const hint of hints) {
    const hit = list.find((m) => String(m.modelId || m.id || "") === hint);
    if (hit) return hit.modelId || hit.id;
  }
  const fuzzy = list.find((m) => /grok[-_.]?4[-_.]?6/i.test(String(m.modelId || m.id || m.name || "")));
  return (fuzzy && (fuzzy.modelId || fuzzy.id)) || DEFAULT_MODEL_ID;
}

async function applyPreferredDefaults(sid) {
  const target = sid || activeId;
  refreshEffortOptions(currentModelId);
  const effort = (target && sessionEffortUser.get(target)) || defaultEffortForModel(currentModelId);
  currentEffort = effort;
  const mid = resolvePreferredModelId();
  try {
    if (mid && grokDesktop.setModel && mid !== currentModelId) {
      await grokDesktop.setModel(mid, target);
      currentModelId = mid;
    }
  } catch { /* chip still shows preferred */ }
  try {
    if (grokDesktop.setEffort) await grokDesktop.setEffort(effort, target);
  } catch { /* ignore */ }
  syncModelChip();
  updateLiveStrip();
}

function shortModelName(id) {
  if (!id) return "模型";
  const raw = String(id);
  const map = {
    "grok-4.6": "Grok 4.6",
    "grok-4-6": "Grok 4.6",
    "grok-4.5": "Grok 4.5",
    "grok-4-5": "Grok 4.5",
    "grok-4": "Grok 4",
    "grok-3": "Grok 3",
  };
  if (map[raw]) return map[raw];
  let name = raw.replace(/^grok-?/i, "Grok ").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/Grok (\d+) (\d+)/i, "Grok $1.$2");
  return name.slice(0, 22) || "模型";
}

function applyModelCatalog(src) {
  if (!src) return;
  if (Array.isArray(src.availableModels)) {
    setModelsState(src);
    return;
  }
  const list = src.models || src.available || [];
  if (!list.length && !src.defaultModel && !src.currentModelId) return;
  setModelsState({
    currentModelId: src.currentModelId || src.defaultModel || currentModelId,
    availableModels: list.map((m) => ({
      modelId: m.modelId || m.id,
      name: m.name || m.modelId || m.id,
      _meta: m._meta || null,
    })),
  });
}

function effortLabelText() {
  const lab = effortOptions.find((e) => e.id === currentEffort)?.label || currentEffort || "";
  return String(lab);
}

function syncModelChip() {
  if (ui.modelLabel) ui.modelLabel.textContent = shortModelName(currentModelId);
  const el = ui.effortLabel;
  const dot = $("effort-dot");
  const lab = effortLabelText();
  if (el) {
    el.textContent = lab || "思考";
    el.hidden = !lab;
  }
  if (dot) dot.hidden = !lab;
}

function normalizeEffortId(raw) {
  const id = String(raw || "").trim().toLowerCase();
  if (id === "extra-high" || id === "extra_high" || id === "extra high") return "xhigh";
  return id;
}

function findModelEntry(modelId) {
  const id = String(modelId || currentModelId || "");
  if (!id) return null;
  return (availableModels || []).find((m) => String(m.modelId || m.id || "") === id) || null;
}

function effortsFromModel(modelId) {
  const m = findModelEntry(modelId);
  const raw = m?._meta?.reasoningEfforts || m?.reasoningEfforts || [];
  const byId = new Map();
  for (const e of raw) {
    const id = normalizeEffortId(e?.value || e?.id || e);
    if (!id) continue;
    let label = e?.label || e?.name || byId.get(id)?.label || id;
    label = String(label).replace(/\s*effort\s*$/i, "").trim() || id;
    if (id === "xhigh" && !/extra/i.test(label)) label = "Extra High";
    byId.set(id, { id, label });
  }
  if (!byId.size) {
    const fallback = /4[.-]?5/.test(String(modelId || ""))
      ? DEFAULT_EFFORTS.filter((e) => e.id !== "xhigh")
      : DEFAULT_EFFORTS;
    return fallback.map((e) => ({ ...e }));
  }
  const order = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const extra = [...byId.keys()].filter((k) => !order.includes(k));
  return [...order, ...extra].filter((k) => byId.has(k)).map((k) => byId.get(k));
}

function defaultEffortForModel(modelId) {
  const m = findModelEntry(modelId);
  const hinted = normalizeEffortId(m?._meta?.reasoningEffort || m?.reasoningEffort);
  const opts = effortsFromModel(modelId);
  const ids = new Set(opts.map((e) => e.id));
  if (hinted && ids.has(hinted) && hinted !== "high") return hinted;
  if (ids.has("xhigh") && /4[.-]?6/.test(String(modelId || currentModelId || ""))) return "xhigh";
  if (ids.has("high")) return "high";
  return opts[opts.length - 1]?.id || "high";
}

function refreshEffortOptions(modelId) {
  effortOptions = effortsFromModel(modelId || currentModelId);
  const ids = new Set(effortOptions.map((e) => e.id));
  if (!ids.has(normalizeEffortId(currentEffort))) {
    currentEffort = defaultEffortForModel(modelId || currentModelId);
  }
}

/** Session ids where the user picked an effort this run — don't stomp those. */
const sessionEffortUser = new Map();

function setModelsState(modelsPayload) {
  if (!modelsPayload) return;
  if (Array.isArray(modelsPayload.availableModels)) {
    availableModels = modelsPayload.availableModels;
  }
  if (modelsPayload.currentModelId) {
    currentModelId = modelsPayload.currentModelId;
  }
  refreshEffortOptions(currentModelId);
  syncModelChip();
}

function pickerRow(label, value, kind) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "picker-row" + (modelSubKind === kind ? " open" : "");
  btn.innerHTML = `<span class="picker-k"></span><span class="picker-v"></span><span class="picker-chev">›</span>`;
  btn.querySelector(".picker-k").textContent = label;
  btn.querySelector(".picker-v").textContent = value || "—";
  btn.onclick = (ev) => {
    ev.stopPropagation();
    if (modelSubKind === kind) closeModelSub();
    else openModelSub(kind);
  };
  return btn;
}

function renderModelPop() {
  if (!ui.modelPop) return;
  ui.modelPop.replaceChildren();
  ui.modelPop.appendChild(pickerRow("模型", shortModelName(currentModelId), "model"));
  ui.modelPop.appendChild(pickerRow("思考", effortLabelText() || "High", "effort"));
}

function renderModelSub(kind) {
  const host = ui.modelSub;
  if (!host) return;
  host.replaceChildren();
  const head = document.createElement("div");
  head.className = "pop-sec";
  head.textContent = kind === "model" ? "模型" : "思考";
  host.appendChild(head);
  if (kind === "model") {
    const list =
      availableModels.length > 0
        ? availableModels
        : currentModelId
          ? [{ modelId: currentModelId, name: currentModelId }]
          : [];
    for (const m of list) {
      const id = m.modelId || m.id;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-item" + (id === currentModelId ? " active" : "");
      const check = id === currentModelId ? "✓" : "";
      btn.innerHTML = `<span class="mid-name"></span><span class="mid-check">${check}</span>`;
      btn.querySelector(".mid-name").textContent = m.name || shortModelName(id);
      btn.onclick = (ev) => {
        ev.stopPropagation();
        void selectModel(id);
      };
      host.appendChild(btn);
    }
  } else {
    for (const e of effortOptions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-item" + (e.id === currentEffort ? " active" : "");
      const check = e.id === currentEffort ? "✓" : "";
      btn.innerHTML = `<span class="mid-name"></span><span class="mid-check">${check}</span>`;
      btn.querySelector(".mid-name").textContent = e.label || e.id;
      btn.onclick = (ev) => {
        ev.stopPropagation();
        void selectEffort(e.id);
      };
      host.appendChild(btn);
    }
  }
}

function openModelSub(kind) {
  modelSubKind = kind;
  renderModelPop();
  renderModelSub(kind);
  ui.modelSub?.classList.remove("hidden");
}

function closeModelSub() {
  modelSubKind = null;
  ui.modelSub?.classList.add("hidden");
  if (modelOpen) renderModelPop();
}

async function openModelPop() {
  if (!availableModels.length) {
    try {
      applyModelCatalog(await grokDesktop.listModels(activeId));
    } catch {
      /* keep empty */
    }
  }
  modelOpen = true;
  effortOpen = false;
  modeOpen = false;
  ui.effortPop?.classList.add("hidden");
  ui.modePop?.classList.add("hidden");
  hideSlash();
  closeModelSub();
  renderModelPop();
  ui.modelPop?.classList.remove("hidden");
}
function closeModelPop() {
  modelOpen = false;
  closeModelSub();
  ui.modelPop?.classList.add("hidden");
}
function toggleModelPop() {
  if (modelOpen) closeModelPop();
  else openModelPop();
}

function renderEffortPop() {
  if (!ui.effortPop) return;
  ui.effortPop.replaceChildren();
  for (const e of effortOptions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "model-item" + (e.id === currentEffort ? " active" : "");
    btn.textContent = e.label || e.id;
    btn.onclick = () => void selectEffort(e.id);
    ui.effortPop.appendChild(btn);
  }
}
function openEffortPop() {
  if (!activeId || connecting) return;
  effortOpen = true;
  modelOpen = false;
  modeOpen = false;
  ui.modelPop?.classList.add("hidden");
  ui.modePop?.classList.add("hidden");
  hideSlash();
  renderEffortPop();
  ui.effortPop?.classList.remove("hidden");
}
function closeEffortPop() {
  effortOpen = false;
  ui.effortPop?.classList.add("hidden");
}
async function selectEffort(id) {
  const next = normalizeEffortId(id);
  closeEffortPop();
  closeModelPop();
  if (!next) return;
  currentEffort = next;
  syncModelChip();
  await applyEffort(next, activeId, { silent: true });
}

ui.effortBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (effortOpen) closeEffortPop();
  else openEffortPop();
});

async function selectModel(modelId) {
  closeModelPop();
  if (!modelId || modelId === currentModelId) return;
  try {
    await grokDesktop.setModel(modelId, activeId);
    currentModelId = modelId;
    refreshEffortOptions(modelId);
    if (activeId && !sessionEffortUser.has(activeId)) {
      await applyEffort(currentEffort, activeId, { silent: true });
    } else if (activeId && !effortOptions.some((e) => e.id === currentEffort)) {
      await applyEffort(defaultEffortForModel(modelId), activeId, { silent: true });
    }
    syncModelChip();
    if (activeMeta) activeMeta.model = modelId;
    applyHeader(activeMeta);
    setStatus("ready", `模型 · ${shortModelName(modelId)}`);
  } catch (err) {
    appendBanner(`切换模型失败：${err.message || err}`, "error");
  }
}

ui.modelBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleModelPop();
});

grokDesktop.onModels?.((payload) => {
  if (payload?.sessionId && payload.sessionId !== activeId) return;
  setModelsState(payload);
  void applyPreferredDefaults(payload?.sessionId || activeId);
});
grokDesktop.onModel?.(({ modelId, sessionId }) => {
  if (sessionId && sessionId !== activeId) return;
  if (modelId) {
    currentModelId = modelId;
    syncModelChip();
  }
});

// click outside closes popovers
document.addEventListener("click", (e) => {
  if ((modelOpen || modelSubKind) && !e.target.closest(".model-wrap")) closeModelPop();
  if (effortOpen && !e.target.closest(".model-wrap")) closeEffortPop();
  if (modeOpen && !e.target.closest(".model-wrap")) closeModePop();
});

// Topbar session actions (export / rename / delete wired below)
$("btn-act-export")?.addEventListener("click", async () => {
  if (!activeId) return;
  try {
    const r = await grokDesktop.exportSession(activeId);
    if (r?.ok) {
      flashToast(t("chat.export") + " ✓");
      appendBanner(`已导出：${r.path}`);
    } else if (!r?.cancelled) {
      flashToast(r?.error || "导出取消");
    }
  } catch (err) {
    flashToast(err.message || "导出失败");
    appendBanner(`导出失败：${err.message}`, "error");
  }
});
// Settings → 环境：低频诊断命令（顶栏已不放）
async function runSettingsSlash(name) {
  switchView("chat");
  await runRealSlash(name);
}
$("btn-run-usage")?.addEventListener("click", () => runSettingsSlash("usage"));
$("btn-run-context")?.addEventListener("click", () => runSettingsSlash("context"));
$("btn-run-compact")?.addEventListener("click", () => runSettingsSlash("compact"));
$("btn-run-session-info")?.addEventListener("click", () => runSettingsSlash("session-info"));

// ── Sidebar sessions ───────────────────────────────────

function sessionOrderList() {
  return Array.isArray(desktopSettings.sessionOrder) ? desktopSettings.sessionOrder.slice() : [];
}
function projectOrderList() {
  return Array.isArray(desktopSettings.projectOrder) ? desktopSettings.projectOrder.slice() : [];
}
function isSessionWorking(s) {
  const id = s?.id;
  return !!(id && (workingSessions.has(id) || promptInFlight.has(id)));
}
function persistSidebarOrder(sessionOrder, projectOrder) {
  const next = {};
  if (sessionOrder) next.sessionOrder = sessionOrder;
  if (projectOrder) next.projectOrder = projectOrder;
  Object.assign(desktopSettings, next);
  void persistSessionLists(next);
}

function groupByProject(items) {
  return groupSessionsByProject(items, {
    projectName,
    isWorking: isSessionWorking,
    sessionOrder: sessionOrderList(),
    projectOrder: projectOrderList(),
  });
}

function makeSessionRow(s) {
  const row = document.createElement("button");
  row.type = "button";
  const working = workingSessions.has(s.id) || promptInFlight.has(s.id);
  const done = !working && doneSessions.has(s.id);
  const pinned = isPinned(s.id);
  const archived = isArchived(s.id);
  row.className =
    "session-row" +
    (s.id === activeId ? " active" : "") +
    (working ? " is-working" : "") +
    (done ? " is-done" : "") +
    (pinned ? " is-pinned" : "") +
    (archived ? " is-archived" : "");
  row.dataset.sessionId = s.id;
  row.setAttribute("aria-haspopup", "menu");
  if (s.id === activeId) row.setAttribute("aria-current", "true");
  row.draggable = true;
  row.innerHTML = `
    <span class="s-ind" aria-hidden="true"></span>
    <span class="title"></span>
    <span class="when"></span>`;
  const ind = row.querySelector(".s-ind");
  if (working) {
    ind.className = "s-ind spin";
    ind.title = "运行中";
  } else if (done) {
    ind.className = "s-ind done";
    ind.title = "已完成 · 点开清除";
  } else {
    ind.className = "s-ind";
  }
  row.querySelector(".title").textContent = s.title || s.id.slice(0, 8);
  const fullWhen = formatFullDateTime(s.updatedAt);
  row.querySelector(".title").title = [s.title || s.id, fullWhen, s.id].filter(Boolean).join("\n");
  const whenEl = row.querySelector(".when");
  whenEl.textContent = sessionWhenLabel(s, { working, done });
  whenEl.title = fullWhen || whenEl.textContent;
  row.onclick = (e) => {
    if (row.dataset.dragged === "1") {
      row.dataset.dragged = "";
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (view !== "chat") switchView("chat");
    void selectSession(s.id);
  };
  wireSessionDrag(row, s);
  return row;
}

function appendProjectGroup(listEl, g, { icon = "📁", headClass = "" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "project" + (collapsed.has(g.name) ? " collapsed" : "");
  wrap.dataset.projectKey = g.cwd || g.name || "";
  wrap.dataset.projectName = g.name || "";
  const row = document.createElement("div");
  row.className = "project-head-row";
  const head = document.createElement("button");
  head.type = "button";
  head.className = "project-head" + (headClass ? " " + headClass : "");
  head.setAttribute("aria-expanded", collapsed.has(g.name) ? "false" : "true");
  head.innerHTML = `<span></span><span class="name"></span><span class="chev">▾</span>`;
  head.querySelector("span").textContent = icon;
  head.querySelector(".name").textContent = g.name;
  head.title = g.cwd || g.name;
  head.onclick = (e) => {
    e.stopPropagation();
    if (collapsed.has(g.name)) collapsed.delete(g.name);
    else collapsed.add(g.name);
    renderSidebar(ui.search?.value || "");
  };
  row.appendChild(head);
  if (g.cwd) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "project-new";
    add.title = "在此项目新建对话";
    add.setAttribute("aria-label", "在此项目新建对话");
    add.textContent = "+";
    add.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void newSession({ cwd: g.cwd });
    };
    row.appendChild(add);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openProjectFolder(g.cwd);
    });
    row.title = (g.cwd || "") + "\n右键从文件夹打开";
  }
  wrap.appendChild(row);
  const body = document.createElement("div");
  body.className = "project-body";
  for (const s of g.sessions) body.appendChild(makeSessionRow(s));
  wrap.appendChild(body);
  if (g.name !== "归档" && !String(g.name || "").startsWith("置顶")) {
    wireProjectDrag(wrap, g);
  }
  listEl.appendChild(wrap);
}

function collectVisibleSessionIds() {
  return [...document.querySelectorAll("#session-list .session-row, .session-row")]
    .map((el) => el.dataset.sessionId)
    .filter(Boolean);
}
function collectVisibleProjectKeys() {
  return [...document.querySelectorAll(".project")]
    .map((el) => el.dataset.projectKey)
    .filter((k) => k && k !== "归档" && !String(k).startsWith("置顶"));
}
function wireSessionDrag(row, s) {
  row.addEventListener("dragstart", (e) => {
    row.dataset.dragged = "1";
    e.dataTransfer.setData("application/x-grok-session", s.id);
    e.dataTransfer.setData("text/plain", s.id);
    e.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    document.querySelectorAll(".drop-before,.drop-after").forEach((el) => {
      el.classList.remove("drop-before", "drop-after");
    });
  });
  row.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-grok-session") && !e.dataTransfer.types.includes("text/plain")) return;
    e.preventDefault();
    e.stopPropagation();
    const mid = row.getBoundingClientRect().top + row.offsetHeight / 2;
    row.classList.toggle("drop-before", e.clientY < mid);
    row.classList.toggle("drop-after", e.clientY >= mid);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove("drop-before", "drop-after");
    const src = e.dataTransfer.getData("application/x-grok-session") || e.dataTransfer.getData("text/plain");
    if (!src || src === s.id) return;
    const after = e.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2;
    const base = sessionOrderList();
    const seed = base.length ? base : collectVisibleSessionIds();
    const next = moveKey(seed.length ? seed : collectVisibleSessionIds(), src, s.id, after);
    persistSidebarOrder(next, null);
    renderSidebar(ui.search?.value || "");
  });
}
function wireProjectDrag(wrap, g) {
  const key = g.cwd || g.name;
  const handle = wrap.querySelector(".project-head-row") || wrap.querySelector(".project-head");
  if (!handle) return;
  handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    if (e.target.closest(".project-new, .session-row")) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("application/x-grok-project", key);
    e.dataTransfer.setData("text/plain", key);
    e.dataTransfer.effectAllowed = "move";
    wrap.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => {
    wrap.classList.remove("dragging");
    document.querySelectorAll(".project.drop-before,.project.drop-after").forEach((el) => {
      el.classList.remove("drop-before", "drop-after");
    });
  });
  wrap.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-grok-project")) return;
    if (e.target.closest(".session-row")) return;
    e.preventDefault();
    const mid = wrap.getBoundingClientRect().top + 22;
    wrap.classList.toggle("drop-before", e.clientY < mid);
    wrap.classList.toggle("drop-after", e.clientY >= mid);
  });
  wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-before", "drop-after"));
  wrap.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("application/x-grok-project")) return;
    if (e.target.closest(".session-row")) return;
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.remove("drop-before", "drop-after");
    const src = e.dataTransfer.getData("application/x-grok-project");
    if (!src || src === key) return;
    const after = e.clientY >= wrap.getBoundingClientRect().top + 22;
    const base = projectOrderList();
    const seed = base.length ? base : collectVisibleProjectKeys();
    const next = moveKey(seed.length ? seed : collectVisibleProjectKeys(), src, key, after);
    persistSidebarOrder(null, next);
    renderSidebar(ui.search?.value || "");
  });
}

function renderSidebar(filter = "") {
  const q = filter.trim().toLowerCase();
  const items = !q
    ? sessions
    : sessions.filter((s) =>
        `${s.title} ${s.summary} ${s.cwd || ""} ${s.id}`.toLowerCase().includes(q),
      );
  const scrollTop = ui.list.scrollTop;
  ui.list.replaceChildren();

  if (!items.length) {
    const d = document.createElement("div");
    d.className = "list-empty";
    d.innerHTML = q
      ? "没有匹配的会话"
      : "还没有会话<br><span style='opacity:.8'>点「对话」旁的 + 开始</span>";
    ui.list.appendChild(d);
    return;
  }

  const arch = archivedSet();
  const pin = pinnedSet();
  const activeItems = items.filter((s) => !arch.has(s.id));
  const archivedItems = items.filter((s) => arch.has(s.id));
  const pinnedItems = activeItems.filter((s) => pin.has(s.id));
  const restItems = activeItems.filter((s) => !pin.has(s.id));

  if (pinnedItems.length) {
    appendProjectGroup(
      ui.list,
      { name: `置顶 · ${pinnedItems.length}`, cwd: null, sessions: pinnedItems },
      { icon: "📌" },
    );
  }
  for (const g of groupByProject(restItems)) {
    appendProjectGroup(ui.list, g, { icon: "📁" });
  }
  if (archivedItems.length) {
    const archKey = "归档";
    // 默认折叠；用户展开过则记住
    try {
      if (!sessionStorage.getItem("arch-expanded")) collapsed.add(archKey);
    } catch {
      collapsed.add(archKey);
    }
    const wrap = document.createElement("div");
    wrap.className = "project" + (collapsed.has(archKey) ? " collapsed" : "");
    const head = document.createElement("button");
    head.type = "button";
    head.className = "project-head archive-head";
    head.setAttribute("aria-expanded", collapsed.has(archKey) ? "false" : "true");
    head.innerHTML = `<span>📦</span><span class="name"></span><span class="chev">▾</span>`;
    head.querySelector(".name").textContent = `归档 · ${archivedItems.length}`;
    head.onclick = (e) => {
      e.stopPropagation();
      if (collapsed.has(archKey)) {
        collapsed.delete(archKey);
        try {
          sessionStorage.setItem("arch-expanded", "1");
        } catch {
          /* ignore */
        }
      } else {
        collapsed.add(archKey);
        try {
          sessionStorage.removeItem("arch-expanded");
        } catch {
          /* ignore */
        }
      }
      renderSidebar(ui.search?.value || "");
    };
    wrap.appendChild(head);
    const body = document.createElement("div");
    body.className = "project-body";
    for (const s of archivedItems) body.appendChild(makeSessionRow(s));
    wrap.appendChild(body);
    ui.list.appendChild(wrap);
  }
  ui.list.scrollTop = scrollTop;
}

function markActive(id) {
  // 点开会话：清掉「已完成」绿点（用户已看到）
  if (id && doneSessions.has(id)) {
    doneSessions.delete(id);
  }
  // 整表刷新更稳（含 when 文案恢复相对时间）
  renderSidebar(ui.search?.value || "");
  const rows = ui.list.querySelectorAll(".session-row");
  rows.forEach((r) => {
    const active = r.dataset.sessionId === id;
    r.classList.toggle("active", active);
    if (active) r.setAttribute("aria-current", "true");
    else r.removeAttribute("aria-current");
  });
}

/** 轻量刷新侧栏状态点，不整表重建 */
function refreshSidebarSessionState() {
  if (!ui.list) return;
  const rows = ui.list.querySelectorAll(".session-row");
  if (!rows.length) return;
  rows.forEach((r) => {
    const sid = r.dataset.sessionId;
    if (!sid) return;
    const working = workingSessions.has(sid) || promptInFlight.has(sid);
    const done = !working && doneSessions.has(sid);
    r.classList.toggle("is-working", working);
    r.classList.toggle("is-done", done);
    const ind = r.querySelector(".s-ind");
    const when = r.querySelector(".when");
    const s = sessions.find((x) => x.id === sid);
    if (ind) {
      if (working) {
        ind.className = "s-ind spin";
        ind.title = "运行中";
      } else if (done) {
        ind.className = "s-ind done";
        ind.title = "已完成 · 点开清除";
      } else {
        ind.className = "s-ind";
        ind.title = "";
      }
    }
    if (when) {
      when.textContent = sessionWhenLabel(s || { id: sid, updatedAt: s?.updatedAt }, {
        working,
        done,
      });
      if (s?.updatedAt) when.title = formatFullDateTime(s.updatedAt);
    }
  });
}

async function refreshSessions() {
  try {
    const next = await grokDesktop.listSessions({ limit: 200 });
    if (Array.isArray(next)) sessions = next;
    renderSidebar(ui.search.value);
  } catch (err) {
    console.error(err);
    if (!sessions.length) {
      ui.list.innerHTML = `<div class="list-error">加载失败：${err.message || err}</div>`;
    }
  }
}

let refreshSessionsTimer = 0;
function scheduleRefreshSessions() {
  clearTimeout(refreshSessionsTimer);
  refreshSessionsTimer = setTimeout(() => void refreshSessions(), 600);
}

function dropSessionFromList(id) {
  sessions = sessions.filter((s) => s.id !== id);
  sessionAutomation.delete(id);
  renderSidebar(ui.search.value);
}

async function deleteSessionUi(id, { persistLists = false } = {}) {
  dropSessionFromList(id);
  removeOpenTab(id);
  if (activeId === id) {
    activeId = null;
    const next = openTabs[0];
    if (next) void selectSession(next);
    else {
      showWelcome();
      setStatus("idle", "就绪");
    }
  }
  if (persistLists) {
    void persistSessionLists({
      pinnedSessionIds: [...pinnedSet()].filter((x) => x !== id),
      archivedSessionIds: [...archivedSet()].filter((x) => x !== id),
    });
  }
  try {
    await grokDesktop.deleteSession(id);
  } catch (err) {
    flashToast(err.message || String(err));
    scheduleRefreshSessions();
    return false;
  }
  scheduleRefreshSessions();
  return true;
}

// ── Chat ───────────────────────────────────────────────

function showWelcome() {
  // Use a detached welcome pane so open tabs keep their DOM
  const welcomePane = document.createElement("div");
  welcomePane.className = "thread-inner";
  welcomePane.innerHTML = `
    <div class="welcome">
      <h2></h2>
      <p></p>
      <ol class="welcome-steps">
        <li><span class="n">1</span><div><strong></strong><span></span></div></li>
        <li><span class="n">2</span><div><strong></strong><span></span></div></li>
        <li><span class="n">3</span><div><strong></strong><span></span></div></li>
      </ol>
      <div class="welcome-cta">
        <button type="button" class="btn primary" id="welcome-new"></button>
        <button type="button" class="btn" id="welcome-memory"></button>
        <button type="button" class="btn" id="welcome-auto"></button>
      </div>
      <div class="welcome-auto" id="welcome-auto-map">
        <div class="welcome-auto-head"></div>
        <div class="auto-map compact">
          <button type="button" class="auto-map-card clickable" data-auto="skills">
            <div class="auto-map-title"></div>
            <p class="auto-map-desc"></p>
          </button>
          <button type="button" class="auto-map-card clickable" data-auto="goal">
            <div class="auto-map-title"></div>
            <p class="auto-map-desc"></p>
          </button>
          <button type="button" class="auto-map-card clickable" data-auto="loop">
            <div class="auto-map-title"></div>
            <p class="auto-map-desc"></p>
          </button>
          <button type="button" class="auto-map-card clickable" data-auto="hooks">
            <div class="auto-map-title"></div>
            <p class="auto-map-desc"></p>
          </button>
        </div>
      </div>
    </div>`;
  const root = welcomePane.querySelector(".welcome");
  root.querySelector("h2").textContent = t("welcome.h2");
  root.querySelector("p").textContent = t("welcome.p");
  const steps = root.querySelectorAll(".welcome-steps li");
  const stepKeys = [
    ["welcome.s1t", "welcome.s1d"],
    ["welcome.s2t", "welcome.s2d"],
    ["welcome.s3t", "welcome.s3d"],
  ];
  steps.forEach((li, i) => {
    li.querySelector("strong").textContent = t(stepKeys[i][0]);
    li.querySelector("span:not(.n)").textContent = t(stepKeys[i][1]);
  });
  welcomePane.querySelector("#welcome-new").textContent = t("welcome.new");
  welcomePane.querySelector("#welcome-memory").textContent = t("welcome.memory");
  welcomePane.querySelector("#welcome-auto").textContent = t("welcome.auto");
  const head = welcomePane.querySelector(".welcome-auto-head");
  if (head) head.textContent = t("welcome.autoHead");
  const autoCards = [
    ["skills", "auto.map.skillTitle", "auto.map.skillDesc"],
    ["goal", "auto.map.goalTitle", "auto.map.goalDesc"],
    ["loop", "auto.map.loopTitle", "auto.map.loopDesc"],
    ["hooks", "auto.map.hooksTitle", "auto.map.hooksDesc"],
  ];
  autoCards.forEach(([key, tk, dk]) => {
    const card = welcomePane.querySelector(`.auto-map-card[data-auto="${key}"]`);
    if (!card) return;
    card.querySelector(".auto-map-title").textContent = t(tk);
    card.querySelector(".auto-map-desc").textContent = t(dk);
  });
  while (ui.thread.firstChild) ui.thread.removeChild(ui.thread.firstChild);
  ui.thread.appendChild(welcomePane);
  ui.inner = welcomePane;
  $("welcome-new")?.addEventListener("click", () => newSession());
  $("welcome-memory")?.addEventListener("click", () => switchView("memory"));
  $("welcome-auto")?.addEventListener("click", () => {
    switchView("settings");
    showSettingsPanel("automation");
  });
  welcomePane.querySelectorAll(".auto-map-card[data-auto]").forEach((card) => {
    card.addEventListener("click", () => handleWelcomeAuto(card.getAttribute("data-auto")));
  });
  ui.sessionActions.classList.add("hidden");
  activeId = null;
  activeMeta = null;
  setComposerEnabled(false);
  setPlanOpen(false);
  renderPlan(null);
  hideAutoBar();
  ui.title.textContent = t("chat.welcomeTitle");
  ui.sub.textContent = t("chat.welcomeSub");
  ui.cwdChip.textContent = "未选择工作目录";
  schedulePersistTabs();
}


function userTurnEls(pane) {
  const root = pane || ui.inner;
  return [...(root?.querySelectorAll(":scope > .turn.user:not(.queued)") || [])];
}

function lastUserTurnEl(pane) {
  const turns = userTurnEls(pane);
  return turns.length ? turns[turns.length - 1] : null;
}

function userTurnText(turn) {
  if (!turn) return "";
  const body = turn.querySelector(":scope > .body");
  const text = (body ? body.textContent : "") || "";
  const trimmed = String(text).trim();
  if (trimmed) return trimmed;
  if (turn.querySelector(".turn-media img")) return "（图片）";
  if (turn.querySelector(".file-chip")) return "（附件）";
  return "";
}

function turnVisibleInThread(el) {
  const thread = ui.thread;
  if (!el || !thread) return false;
  const tr = thread.getBoundingClientRect();
  const lr = el.getBoundingClientRect();
  return lr.bottom > tr.top + 8 && lr.top < tr.bottom - 8;
}

/** Last user turn that has scrolled past the top — the section we are in. */
function activePinnedUserTurn(pane) {
  const turns = userTurnEls(pane);
  const thread = ui.thread;
  if (!turns.length || !thread) return null;
  const top = thread.getBoundingClientRect().top + 8;
  let current = null;
  for (const t of turns) {
    if (t.getBoundingClientRect().top <= top) current = t;
    else break;
  }
  return current;
}

function hidePinnedPrompt() {
  const el = ui.pinnedPrompt;
  const tx = ui.pinnedPromptText;
  if (el) {
    el.hidden = true;
    el.classList.add("hidden");
    el._pinnedTurn = null;
  }
  if (tx) tx.textContent = "";
}

function refreshPinnedPrompt(pane) {
  const el = ui.pinnedPrompt;
  const tx = ui.pinnedPromptText;
  if (!el || !tx) return;
  const turns = userTurnEls(pane);
  if (turns.some(turnVisibleInThread)) {
    hidePinnedPrompt();
    return;
  }
  const turn = activePinnedUserTurn(pane);
  const text = userTurnText(turn);
  if (!turn || !text) {
    hidePinnedPrompt();
    return;
  }
  el._pinnedTurn = turn;
  tx.textContent = text;
  el.hidden = false;
  el.classList.remove("hidden");
}

function expandUserTurn(last) {
  if (!last) return;
  const body = last.querySelector(":scope > .body");
  if (body) {
    body.classList.remove("clamped");
    body.classList.remove("hidden");
  }
  const btn = last.querySelector(":scope > .turn-actions > .expand");
  if (btn) btn.textContent = "收起";
}

function scrollToLastUserPrompt() {
  const last = ui.pinnedPrompt?._pinnedTurn || activePinnedUserTurn() || lastUserTurnEl();
  if (!last) return;
  threadFollowBottom = false;
  expandUserTurn(last);
  last.scrollIntoView({ block: "start", behavior: "smooth" });
  requestAnimationFrame(() => {
    last.scrollIntoView({ block: "start", behavior: "auto" });
    refreshPinnedPrompt();
    updateJumpToLatest();
  });
}

function clearThread() {
  ui.inner.replaceChildren();
  if (activeId) {
    const state = ensureSessionUi(activeId);
    state.streamingEl = null;
    state.activeToolGroup = null;
  }
  seenMedia = new Set();
  if (activeId) ensureSessionUi(activeId).seenMedia = seenMedia;
  refreshPinnedPrompt();
}

function shouldClamp(text) {
  return (text || "").length > CLAMP || (text || "").split("\n").length > 40;
}

function recentContextForTurn(turn, { maxTurns = 10, maxChars = 12000 } = {}) {
  const allTurns = Array.from(
    turn?.parentElement?.querySelectorAll?.(".turn.user, .turn.assistant") || [],
  );
  const selectedIndex = allTurns.indexOf(turn);
  if (selectedIndex < 0) return "";

  const picked = [];
  let used = 0;
  for (let i = selectedIndex; i >= 0 && picked.length < maxTurns && used < maxChars; i -= 1) {
    const item = allTurns[i];
    const text = String(item.querySelector(":scope > .body")?.textContent || "").trim();
    if (!text) continue;
    const remaining = maxChars - used;
    const clipped = text.length > remaining ? text.slice(text.length - remaining) : text;
    picked.push({ role: item.classList.contains("user") ? "user" : "assistant", text: clipped });
    used += clipped.length;
  }
  return picked
    .reverse()
    .map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.text}`)
    .join("\n\n");
}

async function branchFromTurn(turn) {
  const context = recentContextForTurn(turn);
  if (!context) {
    flashToast(t("chat.branchNoContext"));
    return null;
  }
  const sourceTitle = activeMeta?.title || t("chat.branchSourceFallback");
  const cwd = activeMeta?.cwd || sessions.find((s) => s.id === activeId)?.cwd || null;
  const en = uiLocale() === "en";
  const prompt = en
    ? `You are continuing work in a new task branched from an existing conversation. Use the recent context below as background, continue the unfinished goal, and do not repeat the context. If no next step is clear, briefly confirm the handoff and wait for instructions.\n\n<recent_context>\n${context}\n</recent_context>`
    : `你正在一个从已有会话分支出来的新任务中。请把下面的最近上下文作为背景，承接尚未完成的目标继续执行，不要复述上下文。如果没有明确的下一步，请简短确认已承接并等待指令。\n\n<recent_context>\n${context}\n</recent_context>`;
  const displayText = en ? `Continue from “${sourceTitle}”` : `承接「${sourceTitle}」的最近上下文`;
  const desiredTitle = `${en ? "Branch" : "分支"} · ${sourceTitle}`.slice(0, 64);
  return newSession({ cwd, initialPrompt: prompt, initialDisplayText: displayText, desiredTitle });
}

/** Match http(s) URLs in plain text (trailing punctuation stripped into separate text). */
const MSG_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Build a document fragment: plain text + clickable <a.msg-link> for http(s) URLs.
 * Safe: only creates text nodes and anchors; never injects raw HTML.
 */
function linkifyToFragment(text) {
  const frag = document.createDocumentFragment();
  const raw = String(text || "");
  if (!raw) return frag;
  MSG_URL_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = MSG_URL_RE.exec(raw)) !== null) {
    if (m.index > last) {
      frag.appendChild(document.createTextNode(raw.slice(last, m.index)));
    }
    let url = m[0];
    let trail = "";
    // Peel common trailing punctuation not usually part of the URL
    while (url.length > 8 && /[),.;:!?，。；：！？]$/.test(url)) {
      // keep balanced ) if it looks like part of the path
      if (url.endsWith(")") && (url.match(/\(/g) || []).length > (url.match(/\)/g) || []).length - 1) {
        break;
      }
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    if (/^https?:\/\/.+/i.test(url)) {
      const a = document.createElement("a");
      a.className = "msg-link";
      a.href = url;
      a.textContent = url;
      a.rel = "noopener noreferrer";
      a.title = url;
      frag.appendChild(a);
    } else {
      frag.appendChild(document.createTextNode(m[0]));
      trail = "";
    }
    if (trail) frag.appendChild(document.createTextNode(trail));
    last = m.index + m[0].length;
  }
  if (last < raw.length) {
    frag.appendChild(document.createTextNode(raw.slice(last)));
  }
  return frag;
}

/** Fill an element with linkified text (replaces children). */
function setMessageBody(el, text, { markdown } = {}) {
  if (!el) return;
  const raw = String(text || "");
  const asMd = markdown === true || (markdown !== false && !!(el.closest?.(".turn.assistant") || el.classList.contains("thought") || el.closest?.(".thought")));
  if (raw.length > 400000) {
    el.classList.remove("md");
    el.textContent = raw;
    el.dataset.linkified = "1";
    return;
  }
  if (asMd && typeof renderMarkdown === "function") {
    el.classList.add("md");
    el.innerHTML = renderMarkdown(raw);
  } else {
    el.classList.remove("md");
    el.replaceChildren();
    el.appendChild(linkifyToFragment(raw));
  }
  el.dataset.linkified = "1";
}

function actionIcon(name) {
  const icon = document.createElement("span");
  icon.className = `action-glyph action-glyph-${name}`;
  icon.setAttribute("aria-hidden", "true");
  const shapes = {
    copy: '<rect x="5.5" y="2.5" width="8" height="8" rx="2"/><rect x="2.5" y="5.5" width="8" height="8" rx="2"/>',
    share: '<circle cx="4" cy="8" r="1.6"/><circle cx="11.8" cy="3.8" r="1.6"/><circle cx="11.8" cy="12.2" r="1.6"/><path d="m5.4 7.2 4.9-2.7M5.4 8.8l4.9 2.7"/>',
    memory: '<path d="M8 3.2a2.4 2.4 0 0 0-4.2 1.6 2.4 2.4 0 0 0 .1 4.7 2.4 2.4 0 0 0 4.1 1.5 2.4 2.4 0 0 0 4.1-1.5 2.4 2.4 0 0 0 .1-4.7A2.4 2.4 0 0 0 8 3.2Z"/><path d="M8 3.2v9.1M5.1 6.1h1.5M9.4 6.1h1.5M5.2 9.1h1.4M9.4 9.1h1.4"/>',
    edit: '<path d="M10.8 2.8 13.2 5.2 6 12.4H3.6V10z"/><path d="M9.6 4 12 6.4"/>',
    undo: '<path d="M3.6 7.2h6.4a3.2 3.2 0 1 1 0 6.4H8"/><path d="M3.6 7.2 6 4.8M3.6 7.2 6 9.6"/>'
  };
  const svg = `<svg viewBox="0 0 16 16" focusable="false" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round">${shapes[name] || ""}</g></svg>`;
  icon.innerHTML = svg;
  return icon;
}

/**
 * Create a message bubble. Images live INSIDE the turn (not a free-floating
 * strip at the bottom of the thread).
 * @returns {HTMLElement} body element (streaming target) — turn is body.parentElement
 */
function removeTurnAndAfter(turn) {
  if (!turn) return;
  let n = turn.nextSibling;
  turn.remove();
  while (n) {
    const next = n.nextSibling;
    if (n.nodeType === 1 && (
      n.classList.contains("turn") ||
      n.classList.contains("tool-card") ||
      n.classList.contains("tool-group") ||
      n.classList.contains("diff-card") ||
      n.classList.contains("turn-files") ||
      n.classList.contains("thought") ||
      n.classList.contains("thought-block") ||
      n.classList.contains("perm-card") ||
      n.classList.contains("typing-wait") ||
      n.classList.contains("banner")
    )) {
      n.remove();
    }
    n = next;
  }
}

async function stopActiveTurn() {
  if (!activeId) return;
  abortGoalResume(activeId);
  const st = ensureSessionUi(activeId);
  st.stopped = true;
  st.skipGoalResume = true;
  persistSessionUi(activeId, { stopped: true });
  if (!isAgentBusy(activeId) && !promptInFlight.has(activeId)) return;
  try { await grokDesktop.cancel(activeId); } catch { /* ignore */ }
  settleToolCards(activeId, { state: "ready", detail: "已停止" });
  workingSessions.delete(activeId);
  promptInFlight.delete(activeId);
  markRunEnd(activeId);
  setBusy(false);
  setStatus("ready", "已停止");
}

async function retractUserTurn(turn, { silent = false } = {}) {
  if (!turn || turn !== lastUserTurnEl()) {
    if (!silent) flashToast("只能撤回最后一条");
    return false;
  }
  await stopActiveTurn();
  removeTurnAndAfter(turn);
  try {
    if (activeId && grokDesktop.rewindSession) {
      await grokDesktop.rewindSession(activeId);
    }
  } catch (err) {
    if (!silent) flashToast(err?.message || "撤回会话历史失败");
  }
  if (!silent) flashToast("已撤回");
  refreshPinnedPrompt();
  return true;
}

async function editUserTurn(turn) {
  if (!turn || turn !== lastUserTurnEl()) {
    flashToast("只能编辑最后一条");
    return;
  }
  const text = turn.querySelector(".body")?.textContent || "";
  const ok = await retractUserTurn(turn, { silent: true });
  if (!ok) return;
  ui.input.value = text;
  autosize();
  refreshSendButtonState();
  ui.input.focus();
  flashToast("已撤回到输入框，改完再发");
}

function profileNickname() {
  const n = String(desktopSettings.profileNickname || "").trim();
  return n || (uiLocale() === "en" ? "You" : "你");
}

function lastSpeakerWasAssistant(pane = ui.inner) {
  const kids = [...(pane?.children || [])];
  for (let i = kids.length - 1; i >= 0; i--) {
    const el = kids[i];
    if (!el?.classList) continue;
    if (el.classList.contains("turn")) return el.classList.contains("assistant");
    // Tool / diff starts a new step — next Grok reply is not a continuation.
    if (
      el.classList.contains("tool-card") ||
      el.classList.contains("tool-group") ||
      el.classList.contains("diff-card") ||
      el.classList.contains("turn-files")
    ) {
      return false;
    }
    if (
      el.classList.contains("thought") ||
      el.classList.contains("thought-block") ||
      el.classList.contains("banner")
    ) {
      if (el.classList.contains("thought-block") && el.querySelector(".tool-card, .diff-card")) {
        return false;
      }
      continue;
    }
  }
  return false;
}

function makeTurnWho(role) {
  const who = document.createElement("div");
  who.className = "turn-who";
  const hasUserAvatar = !!desktopSettings.profileAvatarUrl;
  if (hasUserAvatar) {
    const img = document.createElement("img");
    img.className = "who-avatar";
    img.alt = "";
    img.src = role === "user" ? desktopSettings.profileAvatarUrl : "icon.png";
    who.appendChild(img);
  } else {
    const name = document.createElement("span");
    name.className = "who-name";
    name.textContent = role === "user" ? profileNickname() : "Grok";
    who.appendChild(name);
  }
  return who;
}

function setAssistantTurnKind(turn, kind) {
  if (!turn?.classList?.contains("assistant")) return;
  turn.classList.toggle("commentary", kind === "commentary");
  turn.classList.toggle("final-answer", kind === "final");
  turn.classList.toggle("response-live", kind === "live");
  const who = turn.querySelector(":scope > .turn-who");
  if (!who) return;
  let label = who.querySelector(".response-kind");
  if (!label) {
    label = document.createElement("span");
    label.className = "response-kind";
    who.appendChild(label);
  }
  label.textContent = kind === "commentary"
    ? t("response.progress")
    : kind === "final"
      ? t("response.final")
      : t("response.live");
}

function classifyAssistantTurns(pane = ui.inner, { settled = false } = {}) {
  if (!pane) return;
  let assistants = [];
  const finishSegment = () => {
    if (!assistants.length) return;
    assistants.forEach((turn, index) => {
      const last = index === assistants.length - 1;
      setAssistantTurnKind(turn, last && settled ? "final" : last ? "live" : "commentary");
    });
    assistants = [];
  };
  for (const node of pane.children) {
    if (node.classList?.contains("turn") && node.classList.contains("user")) finishSegment();
    else if (node.classList?.contains("turn") && node.classList.contains("assistant")) assistants.push(node);
  }
  finishSegment();
}

function refreshTurnWho() {
  const root = ui.inner;
  if (!root) return;
  let lastAsst = false;
  for (const el of root.children) {
    if (!el?.classList) continue;
    if (!el.classList.contains("turn")) {
      if (
        el.classList.contains("tool-card") ||
        el.classList.contains("tool-group") ||
        el.classList.contains("diff-card") ||
        el.classList.contains("turn-files") ||
        (el.classList.contains("thought-block") && el.querySelector(".tool-card, .diff-card"))
      ) {
        lastAsst = false;
        continue;
      }
      continue;
    }
    const isAsst = el.classList.contains("assistant");
    el.classList.toggle("cont", isAsst && lastAsst);
    el.querySelector(":scope > .turn-who")?.remove();
    el.insertBefore(makeTurnWho(isAsst ? "assistant" : "user"), el.firstChild);
    lastAsst = isAsst;
  }
  classifyAssistantTurns(root, { settled: !activeId || !isAgentBusy(activeId) });
}

async function hydrateProfileAvatar() {
  const p = desktopSettings.profileAvatar;
  if (!p) {
    desktopSettings.profileAvatarUrl = "";
    return;
  }
  if (desktopSettings.profileAvatarUrl && desktopSettings.profileAvatarUrl.startsWith("data:")) return;
  try {
    const img = await grokDesktop.readImage?.(p);
    desktopSettings.profileAvatarUrl = img?.dataUrl || "";
  } catch {
    desktopSettings.profileAvatarUrl = "";
  }
}

function appendTurn(
  role,
  text,
  {
    stream = false,
    clampable = true,
    images = [],
    skipScroll = false,
    files = [],
    pane = ui.inner,
    sessionId = activeId,
  } = {},
) {
  const state = sessionId ? ensureSessionUi(sessionId) : null;
  if (state) {
    state.activeToolGroup = null;
    if (role === "user") state.diffPathMap = new Map();
  }
  if ((role === "user" || role === "assistant") && sessionId) finishThoughtClock(sessionId);
  pane.querySelector(".welcome")?.remove();
  let fileList = Array.isArray(files) ? files.slice() : [];
  let bodyText = text || "";
  if (role === "user" && !fileList.length && !stream) {
    const parsed = parseAttachText(bodyText);
    if (parsed) {
      fileList = parsed;
      bodyText = "";
    }
  }
  const turn = document.createElement("div");
  turn.className = `turn ${role}`;
  turn.setAttribute("role", "article");
  turn.setAttribute("aria-label", role === "user" ? profileNickname() : "Grok");
  if (fileList.length) turn.classList.add("has-files");
  if (stream) {
    turn.classList.add("streaming");
    turn.setAttribute("aria-busy", "true");
  }
  if (role === "assistant" && lastSpeakerWasAssistant(pane)) turn.classList.add("cont");
  turn.appendChild(makeTurnWho(role));
  if (role === "assistant" && stream) setAssistantTurnKind(turn, "live");
  if (role === "user" && fileList.length) turn.appendChild(makeFileChipRow(fileList));
  const body = document.createElement("div");
  body.className = "body";
  // Stream as plain text (fast); linkify when stream ends / for history
  if (stream) {
    body.textContent = bodyText || "";
  } else {
    setMessageBody(body, bodyText || "", { markdown: role === "assistant" });
  }
  if (!bodyText && fileList.length && !stream) body.classList.add("hidden");

  // User: images above text; assistant: text then images (filled as they arrive)
  if (role === "user" && images?.length) {
    const media = ensureTurnMedia(turn);
    for (const img of images) {
      addImgToMediaRow(media, img.dataUrl || img, img.key || img.dataUrl, state);
    }
  }

  const skipActions = stream || (role === "assistant" && sessionId && workingSessions.has(sessionId));
  const actions = document.createElement("div");
  actions.className = "turn-actions";

  if (!skipActions && !stream && clampable && role === "user" && shouldClamp(bodyText)) {
    body.classList.add("clamped");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "expand";
    btn.textContent = "展开全文";
    btn.onclick = () => {
      body.classList.toggle("clamped");
      btn.textContent = body.classList.contains("clamped") ? "展开全文" : "收起";
    };
    actions.appendChild(btn);
  }

  if (!skipActions && String(bodyText || "").trim()) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "turn-action-icon turn-copy";
    copyBtn.appendChild(actionIcon("copy"));
    copyBtn.title = t("chat.copyMessageHint");
    copyBtn.setAttribute("aria-label", t("chat.copyMessageHint"));
    copyBtn.onclick = async () => {
      try {
        await copyText(body.textContent || bodyText);
        flashToast(t("chat.messageCopied"));
      } catch (error) {
        flashToast(error?.message || "复制失败");
      }
    };
    actions.appendChild(copyBtn);

    const branchBtn = document.createElement("button");
    branchBtn.type = "button";
    branchBtn.className = "turn-action-icon turn-branch";
    branchBtn.appendChild(actionIcon("share"));
    branchBtn.title = t("chat.branchTaskHint");
    branchBtn.setAttribute("aria-label", t("chat.branchTaskHint"));
    branchBtn.onclick = async () => {
      try {
        if (await branchFromTurn(turn)) flashToast(t("chat.branchCreated"));
      } catch (error) {
        flashToast(error?.message || "创建分支失败");
      }
    };
    actions.appendChild(branchBtn);

    const memoryBtn = document.createElement("button");
    memoryBtn.type = "button";
    memoryBtn.className = "turn-action-icon turn-memory";
    memoryBtn.appendChild(actionIcon("memory"));
    memoryBtn.title = t("chat.saveMemoryHint");
    memoryBtn.setAttribute("aria-label", t("chat.saveMemoryHint"));
    memoryBtn.onclick = async () => {
      try {
        const prefix = t(role === "user" ? "chat.memoryUserPrefix" : "chat.memoryAssistantPrefix");
        await grokDesktop.appendMemory({
          text: `${prefix}${String(body.textContent || bodyText).trim()}`.slice(0, 12000),
          scope: "global",
        });
        flashToast(t("chat.memorySaved"));
      } catch (error) {
        flashToast(error?.message || "保存记忆失败");
      }
    };
    actions.appendChild(memoryBtn);
  }

  if (!skipActions && String(bodyText || "").trim() && role === "user") {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "turn-action-icon turn-edit";
    editBtn.appendChild(actionIcon("edit"));
    editBtn.title = "编辑";
    editBtn.setAttribute("aria-label", "编辑");
    editBtn.onclick = () => void editUserTurn(turn);
    actions.appendChild(editBtn);

    const retractBtn = document.createElement("button");
    retractBtn.type = "button";
    retractBtn.className = "turn-action-icon turn-retract";
    retractBtn.appendChild(actionIcon("undo"));
    retractBtn.title = "撤回";
    retractBtn.setAttribute("aria-label", "撤回");
    retractBtn.onclick = () => void retractUserTurn(turn);
    actions.appendChild(retractBtn);
  }

  turn.appendChild(body);
  if (actions.childElementCount) turn.appendChild(actions);

  if (role !== "user" && images?.length) {
    const media = ensureTurnMedia(turn);
    for (const img of images) {
      addImgToMediaRow(media, img.dataUrl || img, img.key || img.dataUrl, state);
    }
  }

  pane.appendChild(turn);
  if (!skipScroll && sessionId === activeId) {
    // User messages always snap to bottom; streams follow pin state
    scrollThreadToBottom({ force: !stream || role === "user" });
  }
  if (stream && state) state.streamingEl = body;
  if (role === "user" && sessionId === activeId) refreshPinnedPrompt();
  return body;
}

function ensureTurnMedia(turn) {
  if (!turn) return null;
  let row = turn.querySelector(":scope > .turn-media");
  if (!row) {
    row = document.createElement("div");
    row.className = "turn-media media-row";
    const body = turn.querySelector(":scope > .body");
    const who = turn.querySelector(":scope > .turn-who");
    if (turn.classList.contains("user")) {
      // name → image → text
      if (body) turn.insertBefore(row, body);
      else turn.appendChild(row);
    } else if (body && body.nextSibling) {
      turn.insertBefore(row, body.nextSibling);
    } else if (body) {
      turn.appendChild(row);
    } else if (who && who.nextSibling) {
      turn.insertBefore(row, who.nextSibling);
    } else {
      turn.appendChild(row);
    }
  }
  return row;
}

function addImgToMediaRow(row, dataUrl, key, state = null) {
  if (!row || !dataUrl || typeof dataUrl !== "string") return null;
  const k = key || dataUrl.slice(0, 80);
  const already = [...row.querySelectorAll("img")].some(
    (el) => el.dataset.mediaKey === k || el.getAttribute("src") === dataUrl,
  );
  if (already) return null;
  const mediaSet = state?.seenMedia instanceof Set ? state.seenMedia : seenMedia;
  mediaSet.add(k);
  mediaSet.add(dataUrl);
  if (state && activeId && sessionUi.get(activeId) === state && mediaSet !== seenMedia) {
    seenMedia.add(k);
    seenMedia.add(dataUrl);
  }
  const img = document.createElement("img");
  img.src = dataUrl;
  img.dataset.mediaKey = k;
  img.alt = "图片";
  img.loading = "lazy";
  img.onclick = () => openLightbox(dataUrl);
  img.ondblclick = () => openLightbox(dataUrl);
  img.title = img.title || "点击或双击放大";
  row.appendChild(img);
  return img;
}

let historyImageObserver = null;

async function loadHistoryImagePlaceholder(placeholder) {
  if (!placeholder || placeholder.dataset.loading === "1") return;
  const asset = placeholder._asset;
  if (!asset?.path && !asset?.dataUrl) return;
  placeholder.dataset.loading = "1";
  placeholder.classList.add("loading");
  placeholder.querySelector("span").textContent = uiLocale() === "en" ? "Loading image…" : "正在加载图片…";
  historyImageObserver?.unobserve?.(placeholder);
  try {
    const loaded = asset.dataUrl ? asset : await grokDesktop.readImage?.(asset.path);
    if (!loaded?.dataUrl) throw new Error(uiLocale() === "en" ? "Image unavailable" : "图片不可用");
    asset.dataUrl = loaded.dataUrl;
    const row = placeholder.parentElement;
    if (!row) return;
    const image = addImgToMediaRow(row, loaded.dataUrl, asset.path || asset.name, placeholder._sessionState);
    if (image) row.insertBefore(image, placeholder);
    placeholder.remove();
  } catch (err) {
    placeholder.dataset.loading = "";
    placeholder.classList.remove("loading");
    placeholder.classList.add("failed");
    placeholder.querySelector("span").textContent = err?.message || (uiLocale() === "en" ? "Load failed · retry" : "加载失败 · 点击重试");
  }
}

function getHistoryImageObserver() {
  if (historyImageObserver || typeof IntersectionObserver !== "function") return historyImageObserver;
  historyImageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void loadHistoryImagePlaceholder(entry.target);
      }
    },
    { root: ui.thread || null, rootMargin: "500px 0px", threshold: 0.01 },
  );
  return historyImageObserver;
}

function addHistoryImageToMediaRow(row, asset, state = null) {
  if (!row || (!asset?.dataUrl && !asset?.path)) return null;
  if (asset.dataUrl) return addImgToMediaRow(row, asset.dataUrl, asset.path || asset.name, state);
  const placeholder = document.createElement("button");
  placeholder.type = "button";
  placeholder.className = "history-image-lazy";
  placeholder.setAttribute("aria-label", uiLocale() === "en" ? `Load image ${asset.name || ""}` : `加载图片 ${asset.name || ""}`);
  placeholder.innerHTML = `<span></span><small></small>`;
  placeholder.querySelector("span").textContent = uiLocale() === "en" ? "Image" : "历史图片";
  placeholder.querySelector("small").textContent = asset.name || fileBasename(asset.path) || "";
  placeholder._asset = asset;
  placeholder._sessionState = state;
  placeholder.onclick = () => void loadHistoryImagePlaceholder(placeholder);
  row.appendChild(placeholder);
  const observer = getHistoryImageObserver();
  if (observer) observer.observe(placeholder);
  else void loadHistoryImagePlaceholder(placeholder);
  return placeholder;
}

/**
 * Attach an image to a message bubble (never dump as a free strip at thread end).
 * Priority: explicit turn → streaming turn → last assistant turn → last turn → new.
 */
/** dataUrl / path / name of images the user attached this run */
const userSentMedia = new Set();

function rememberUserMedia(img) {
  if (!img) return;
  if (typeof img === "string") {
    userSentMedia.add(img);
    return;
  }
  for (const v of [img.dataUrl, img.path, img.name, img.key]) {
    if (v) userSentMedia.add(v);
  }
}

function isUserSentMedia(media) {
  if (!media) return false;
  for (const v of [media.dataUrl, media.path, media.name]) {
    if (v && userSentMedia.has(v)) return true;
  }
  return false;
}

function appendMedia(
  dataUrl,
  key,
  {
    turn = null,
    role = "assistant",
    prefer = "assistant",
    pane = ui.inner,
    sessionId = activeId,
  } = {},
) {
  if (!dataUrl) return;
  const k = key || dataUrl.slice(0, 80);
  const state = sessionId ? ensureSessionUi(sessionId) : null;
  pane.querySelector(".welcome")?.remove();

  let host = turn;
  if (!host && state?.streamingEl) host = state.streamingEl.closest?.(".turn");
  if (!host) {
    const turns = [...pane.querySelectorAll(":scope > .turn:not(.queued)")];
    if (prefer === "user") {
      host = [...turns].reverse().find((t) => t.classList.contains("user")) || null;
    } else if (prefer === "assistant") {
      host = [...turns].reverse().find((t) => t.classList.contains("assistant")) || null;
    }
    if (!host) host = turns.length ? turns[turns.length - 1] : null;
  }
  // User-sent images must sit under the user bubble — never the assistant.
  if (
    host?.classList.contains("assistant") &&
    (prefer === "user" || isUserSentMedia({ dataUrl, path: key, name: key }))
  ) {
    host = lastUserTurnEl(pane) || null;
  }
  if (!host) {
    host = document.createElement("div");
    host.className = `turn ${prefer === "user" || role === "user" ? "user" : role} media-only`;
    pane.appendChild(host);
  }
  const row = ensureTurnMedia(host);
  addImgToMediaRow(row, dataUrl, k, state);
  if (sessionId === activeId) scrollThreadToBottom();
}

/**
 * Place history assets into turns by session timeline (mtime).
 * CRITICAL: never dump early images onto the last visible turn (looks like "all at bottom").
 */
function renderHistoryWithAssets(messages, assets, sessionMeta, opts = {}) {
  const pinBottom = opts.pinBottom !== false;
  const list = Array.isArray(messages) ? messages : [];
  const imgs = (Array.isArray(assets) ? assets : [])
    .filter((a) => a?.dataUrl || a?.path)
    .slice()
    .sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));

  // With images, show enough history to place them mid-thread (not only last PAGE)
  if (imgs.length && list.length) {
    const byTmp = mapAssetsToMessageIndex(list, imgs, sessionMeta);
    let minIdx = list.length;
    for (const k of byTmp.keys()) minIdx = Math.min(minIdx, k);
    // Ensure earliest image's message is visible
    if (Number.isFinite(minIdx) && minIdx < historyFrom) {
      historyFrom = Math.max(0, minIdx);
    }
  }

  const byIndex = mapAssetsToMessageIndex(list, imgs, sessionMeta);
  const lastIdx = Math.max(0, list.length - 1);
  let lastUserIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "user") { lastUserIdx = i; break; }
  }
  const firstVis = Math.min(historyFrom, lastIdx);
  const lastVis = lastIdx;

  // Clamp every asset into the VISIBLE window — early → first visible, late → last visible
  // Never leave "leftovers" that appendMedia would glue to the bottom turn.
  /** @type {Map<number, any[]>} */
  const visibleMap = new Map();
  for (const [idx, arr] of byIndex) {
    const clamped = Math.min(lastVis, Math.max(firstVis, idx));
    if (!visibleMap.has(clamped)) visibleMap.set(clamped, []);
    visibleMap.get(clamped).push(...arr);
  }

  clearThread();
  if (historyFrom > 0) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "load-earlier";
    btn.textContent = `更早的 ${historyFrom} 条`;
    btn.onclick = () => {
      threadFollowBottom = false;
      historyFrom = Math.max(0, historyFrom - PAGE);
      renderHistoryWithAssets(sessionHistory, historyAssets, sessionMeta || activeMeta, { pinBottom: false });
      if (ui.thread) ui.thread.scrollTop = 0;
      updateJumpToLatest();
    };
    ui.inner.appendChild(btn);
  }

  // Images that belong before the first visible message → strip under "load earlier"
  if (historyFrom > 0) {
    const early = [];
    for (const [idx, arr] of byIndex) {
      if (idx < historyFrom) early.push(...arr);
    }
    if (early.length) {
      const gallery = document.createElement("div");
      gallery.className = "turn media-only history-media-early";
      const lab = document.createElement("div");
      lab.className = "history-media-label";
      lab.textContent = `更早的会话图片（${early.length}）· 点上方加载更早消息可对齐上下文`;
      gallery.appendChild(lab);
      const row = document.createElement("div");
      row.className = "turn-media media-row";
      gallery.appendChild(row);
      for (const a of early) {
        addHistoryImageToMediaRow(row, a, activeId ? ensureSessionUi(activeId) : null);
      }
      ui.inner.appendChild(gallery);
    }
  }

  const slice = list.slice(historyFrom);
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i];
    const globalIdx = historyFrom + i;
    if (m.role === "thought" || m.kind === "thought") {
      appendHistoryThought(m.text);
      continue;
    }
    if (m.role === "tool" || m.kind === "tool") {
      appendToolCard({
        toolCallId: m.toolCallId || `hist-tool-${globalIdx}`,
        title: m.title || m.kindName || "工具",
        kind: m.kindName || m.title || "tool",
        status: m.status || "completed",
        rawInput: m.rawInput || m.arguments,
        rawOutput: m.rawOutput || m.detail,
      });
      continue;
    }
    const role = m.role === "user" ? "user" : "assistant";
    // Prefer assets originally for this index; if we clamped early images onto
    // firstVis only for non-early strip case (historyFrom===0), use visibleMap
    let attached;
    if (historyFrom === 0) {
      attached = visibleMap.get(globalIdx) || [];
    } else {
      // early ones already shown in gallery; only attach idx >= historyFrom
      attached = (byIndex.get(globalIdx) || []).slice();
    }
    appendTurn(role, m.text, {
      clampable: role === "user" ? globalIdx !== lastUserIdx : globalIdx < lastIdx,
      skipScroll: true,
      images: attached.filter((a) => a.dataUrl).map((a) => ({ dataUrl: a.dataUrl, key: a.path || a.name })),
    });
    if (attached.some((asset) => !asset.dataUrl)) {
      const turn = ui.inner.lastElementChild;
      const row = ensureTurnMedia(turn);
      for (const asset of attached.filter((item) => !item.dataUrl)) {
        addHistoryImageToMediaRow(row, asset, activeId ? ensureSessionUi(activeId) : null);
      }
    }
  }
  if (pinBottom) {
    schedulePinThreadToBottom();
  } else {
    threadFollowBottom = false;
    updateJumpToLatest();
  }
  refreshPinnedPrompt();
  classifyAssistantTurns(ui.inner, { settled: true });
  sealTurnFileSummaries(ui.inner);
}

function appendBanner(text, kind = "", pane = ui.inner, shouldScroll = true) {
  pane.querySelector(".welcome")?.remove();
  const b = document.createElement("div");
  b.className = "banner" + (kind ? ` ${kind}` : "");
  b.textContent = text;
  pane.appendChild(b);
  if (shouldScroll) scrollThreadToBottom({ force: threadFollowBottom });
}

function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1000) return (v / 1000).toFixed(1) + "k";
  return String(Math.round(v));
}
function formatTok(n) {
  return formatTokens(n);
}

/** grok-4.6 list price (USD / 1M). prompt>=200k doubles the whole request. */
function apiRatesForModel(id) {
  const s = String(id || currentModelId || "");
  if (/4[.-]?5/.test(s)) return { input: 2, cache: 0.3, output: 6, name: "grok-4.5" };
  return { input: 2, cache: 0.5, output: 6, name: "grok-4.6" };
}

function estimateApiUsd({ input = 0, output = 0, cache = 0, promptTokens = 0, modelId } = {}) {
  const rates = apiRatesForModel(modelId);
  const long = (Number(promptTokens) || 0) >= 200000;
  const mul = long ? 2 : 1;
  const inAll = Number(input) || 0;
  const cached = Math.min(Number(cache) || 0, inAll > 0 ? inAll : Number(cache) || 0);
  const fresh = Math.max(0, inAll - cached);
  return (
    (fresh / 1e6) * rates.input * mul +
    (cached / 1e6) * rates.cache * mul +
    ((Number(output) || 0) / 1e6) * rates.output * mul
  );
}

function formatUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 0.01) return "$" + n.toFixed(3);
  if (n < 10) return "$" + n.toFixed(2);
  if (n < 100) return "$" + n.toFixed(1);
  return "$" + Math.round(n);
}

function modelPriceLabel(id) {
  const rates = apiRatesForModel(id);
  if (rates.name === "grok-4.5") return "Grok 4.5";
  if (rates.name === "grok-4.6") return "Grok 4.6";
  return (typeof shortModelName === "function" ? shortModelName(id) : "") || rates.name;
}

function hideQuotaCostTip() {
  const tip = document.getElementById("quota-cost-tip");
  if (tip) tip.hidden = true;
}

function showQuotaCostTip(anchor, lines) {
  let tip = document.getElementById("quota-cost-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "quota-cost-tip";
    document.body.appendChild(tip);
  }
  tip.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("div");
    row.textContent = line;
    tip.appendChild(row);
  }
  const r = anchor.getBoundingClientRect();
  const pad = 8;
  tip.hidden = false;
  const w = tip.offsetWidth || 180;
  let left = r.left;
  if (left + w > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - w - pad);
  tip.style.left = left + "px";
  tip.style.top = (r.bottom + 6) + "px";
}


function appendUsageCard(u) {
  ui.inner.querySelector(".welcome")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "turn system";
  const card = document.createElement("div");
  card.className = "usage-card";
  const title = document.createElement("div");
  title.className = "usage-card-title";
  title.textContent = u?.title || "额度";
  const body = document.createElement("div");
  body.className = "usage-card-body";
  if (u?.body) {
    body.textContent = u.body;
  } else {
    const lines = [];
    const week = u?.percent != null ? "周限额 " + u.percent + "%" : "";
    const reset = u?.reset ? "刷新 " + u.reset : "";
    const head = [week, reset].filter(Boolean).join(" · ");
    if (head) lines.push(head);
    const weekTok = u?.weekTokens != null ? u.weekTokens : null;
    if (weekTok != null) lines.push("本周 " + formatTokens(weekTok) + " tokens");
    const weekBits = [];
    if (u?.weekInput) weekBits.push("输入 " + formatTokens(u.weekInput));
    if (u?.weekOutput) weekBits.push("输出 " + formatTokens(u.weekOutput));
    if (u?.weekCache) weekBits.push("缓存输入 " + formatTokens(u.weekCache));
    if (weekBits.length) lines.push(weekBits.join(" · "));
    if (u?.dailyTokens != null) lines.push("当日 " + formatTokens(u.dailyTokens) + " tokens");
    const bits = [];
    if (u?.dailyInput) bits.push("输入 " + formatTokens(u.dailyInput));
    if (u?.dailyOutput) bits.push("输出 " + formatTokens(u.dailyOutput));
    if (u?.dailyCache) bits.push("缓存输入 " + formatTokens(u.dailyCache));
    if (u?.dailyReasoning) bits.push("推理 " + formatTokens(u.dailyReasoning));
    if (bits.length) lines.push(bits.join(" · "));
    if (u?.subscriptionTier) lines.push(String(u.subscriptionTier));
    if (!lines.length) lines.push("暂时读不到额度，登录后再试");
    body.textContent = lines.join("\n");
  }
  card.appendChild(title);
  card.appendChild(body);
  wrap.appendChild(card);
  ui.inner.appendChild(wrap);
  scrollThreadToBottom({ force: true });
}

function paintTurnCost(sid, { total, input, output, reasoning, cache, promptTokens, modelId }) {
  const pane = (sid && typeof getPane === "function" ? getPane(sid) : null) || ui.inner;
  if (!pane) return;
  const turns = pane.querySelectorAll(".turn.assistant");
  const last = turns[turns.length - 1];
  if (!last) return;
  const mid = modelId || currentModelId || "";
  const st = sid ? ensureSessionUi(sid) : null;
  if (st) st.lastTurnUsage = { total, input, output, reasoning, cache, promptTokens, modelId: mid };
  let actions = last.querySelector(":scope > .turn-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = "turn-actions";
    last.appendChild(actions);
  }
  let el = actions.querySelector(".turn-cost") || last.querySelector(".turn-cost");
  if (!el) {
    el = document.createElement("span");
    el.className = "turn-cost";
  }
  if (el.parentElement !== actions) actions.appendChild(el);
  const rates = apiRatesForModel(mid);
  const bits = [];
  bits.push(modelPriceLabel(mid));
  if (total) bits.push(formatTokens(total));
  if (input) bits.push("入 " + formatTok(input));
  if (output) bits.push("出 " + formatTok(output));
  if (cache) bits.push("缓存 " + formatTok(cache));
  if (reasoning) bits.push("推理 " + formatTok(reasoning));
  const usd = estimateApiUsd({ input, output, cache, promptTokens, modelId: mid });
  const money = formatUsd(usd);
  if (money) bits.push("约 " + money);
  el.textContent = bits.join(" · ");
  el.title = rates.name + " 标价估算：未缓存入 $" + rates.input + "/M · 缓存 $" + rates.cache + "/M · 出 $" + rates.output + "/M";
}

async function applyEffort(raw, sessionId, { silent = false } = {}) {
  const next = normalizeEffortId(raw);
  refreshEffortOptions(currentModelId);
  const ok = effortOptions.some((e) => e.id === next);
  if (!ok) {
    if (!silent) {
      const names = effortOptions.map((e) => e.id).join(" | ") || "low | medium | high";
      appendBanner("用法：/effort " + names, "error");
    }
    return false;
  }
  currentEffort = next;
  const sid = sessionId || activeId;
  if (sid) sessionEffortUser.set(sid, next);
  syncModelChip();
  try {
    if (grokDesktop.setEffort) await grokDesktop.setEffort(next, sid);
  } catch {
    /* chip is enough if ACP has no setter */
  }
  const lab = effortLabelText();
  setStatus("ready", "思考 · " + lab);
  if (!silent) appendBanner("思考强度已设为 " + lab);
  return true;
}

async function applyModelSlash(raw) {
  const q = String(raw || "").trim();
  if (!q) {
    const names = (availableModels || []).map((m) => m.modelId || m.id || m.name).filter(Boolean);
    appendBanner(names.length ? "可用模型：" + names.join(" · ") : "用法：/model <模型名>");
    return true;
  }
  const hit = (availableModels || []).find((m) => {
    const id = String(m.modelId || m.id || "");
    const name = String(m.name || "");
    return id === q || name === q || id.endsWith(q) || name.toLowerCase().includes(q.toLowerCase());
  });
  const modelId = hit?.modelId || hit?.id || q;
  await selectModel(modelId);
  return true;
}

/** In-session slashes the desktop must handle — never send to the model as a task. */
async function dispatchBuiltinSlash(name, args, sessionId, { echo = false } = {}) {
  const cmd = String(name || "").replace(/^\//, "").toLowerCase();
  const rest = String(args || "").trim();
  const sid = sessionId || activeId;
  const route = typeof slashCatalog.resolveDesktopRoute === "function"
    ? slashCatalog.resolveDesktopRoute(cmd, false)
    : null;
  if (route) {
    applySlash({ name: cmd, isSkill: false });
    return true;
  }
  if (cmd === "effort") return applyEffort(rest, sid);
  if (cmd === "model") return applyModelSlash(rest, sid);
  if (cmd === "always-approve" || cmd === "auto") {
    const on = !/^(off|false|0|no|close)$/i.test(rest);
    await persistComposerAccess(on ? "full" : "balanced");
    appendBanner(on ? "已打开自动批准" : "已关闭自动批准");
    return true;
  }
  if (["usage", "usages", "cost", "context", "session-info", "info", "help", "docs", "status"].includes(cmd)) {
    if (echo && sid) appendTurn("user", rest ? `/${cmd} ${rest}` : `/${cmd}`, { clampable: false });
    await handleDesktopSlash(cmd === "info" ? "session-info" : cmd === "status" ? "session-info" : cmd, rest, sid);
    return true;
  }
  if (cmd === "view-plan") {
    setPlanOpen(true);
    return true;
  }
  if (cmd === "rewind" || cmd === "undo") {
    const last = lastUserTurnEl();
    if (last) await retractUserTurn(last);
    else flashToast("没有可撤回的消息");
    return true;
  }
  if (cmd === "delete" && sid) {
    const ok = await askConfirm({ title: "删除会话", message: "永久删除此会话？", okLabel: "删除", danger: true });
    if (ok) await deleteSessionUi(sid);
    return true;
  }
  if (cmd === "login") {
    grokDesktop.openExternal?.("https://accounts.x.ai");
    appendBanner("已打开登录页");
    return true;
  }
  if (cmd === "logout") {
    appendBanner("请在设置或 grok logout 里退出登录");
    return true;
  }
  if (cmd === "privacy") {
    switchView("settings");
    return true;
  }
  if (cmd === "doctor") {
    appendBanner("诊断请在终端运行 grok doctor");
    return true;
  }
  if (cmd === "release-notes" || cmd === "docs") {
    grokDesktop.openExternal?.("https://docs.x.ai");
    return true;
  }
  return false;
}

async function handleDesktopSlash(cmd, args, sessionId) {
  const sid = sessionId || activeId;
  const name = String(cmd || "").replace(/^\//, "").toLowerCase();
  const rest = String(args || "").trim();
  const prev = ui.inner;
  const pane = sid && typeof getPane === "function" ? getPane(sid) : ui.inner;
  if (pane) ui.inner = pane;
  try {
    if (name === "usage" || name === "usages" || name === "cost") {
      if (/^manage\b/i.test(rest)) {
        grokDesktop.openExternal?.("https://grok.com");
      }
      const u = await grokDesktop.accountUsage();
      paintAccountUsage(u);
      appendUsageCard(u);
      return;
    }
    if (name === "context" || name === "session-info") {
      let body = "";
      try {
        const s = sid && grokDesktop.sessionUsage ? await grokDesktop.sessionUsage(sid) : null;
        const used = s?.used;
        const size = s?.size;
        const pct = used != null && size ? Math.round((used / size) * 100) : null;
        body = [
          (activeMeta?.model || currentModelId)
            ? "模型 " + (shortModelName(activeMeta?.model || currentModelId) || activeMeta?.model || currentModelId)
            : "",
          used != null
            ? "上下文 " + formatTok(used) + (size ? " / " + formatTok(size) : "") + (pct != null ? " · " + pct + "%" : "")
            : "",
          sid ? "会话 " + String(sid).slice(0, 8) : "",
          activeMeta?.cwd ? shortPath(activeMeta.cwd) : "",
        ]
          .filter(Boolean)
          .join("\n");
      } catch {
        body = "暂无上下文数据";
      }
      appendUsageCard({ title: name === "session-info" ? "会话信息" : "上下文", body: body || "暂无上下文数据" });
      return;
    }
    if (name === "call" || name === "send-to" || name === "invoke") {
      const parsed = parseCallSession("/call " + rest);
      if (!parsed?.sessionId || parsed.bare) {
        appendBanner("用法：/call <会话ID> 消息", "error");
        return;
      }
      await dispatchCallSession(parsed.sessionId, parsed.text);
      return;
    }
    if (name === "help" || name === "docs") {
      appendUsageCard({
        title: "斜杠命令",
        body: "/usage 额度（输入/输出/缓存）\n/context 上下文\n/call <会话ID> 任务  — 派给另一个对话，改完交回本会话审计\n/compact 压缩\n/model 换模型\n/effort 思考\n/fork /rewind /resume\n/settings 设置",
      });
    }
  } finally {
    if (prev) ui.inner = prev;
  }
}

function openLightbox(src) {
  let box = document.getElementById("lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "lightbox";
    box.className = "hidden";
    box.innerHTML = "<img alt='' />";
    box.onclick = () => box.classList.add("hidden");
    document.body.appendChild(box);
  }
  box.querySelector("img").src = src;
  box.classList.remove("hidden");
}

/** @type {any[]} */
let historyAssets = [];
let usageRefreshTimer = null;

function renderHistory() {
  if (activeId && (promptInFlight.has(activeId) || workingSessions.has(activeId)) && ui.inner?.querySelector(".turn.streaming, .thought-block.is-open, .turn.user")) {
    return;
  }
  if (!sessionHistory.length) {
    clearThread();
    appendBanner("本地没有可预览的消息，agent 上下文仍会恢复。");
    // No messages: show images as a top gallery (not glued under empty bottom)
    if (historyAssets?.length) {
      const gallery = document.createElement("div");
      gallery.className = "turn media-only history-media-early";
      const lab = document.createElement("div");
      lab.className = "history-media-label";
      lab.textContent = "本会话图片";
      gallery.appendChild(lab);
      const row = document.createElement("div");
      row.className = "turn-media media-row";
      gallery.appendChild(row);
      ui.inner.appendChild(gallery);
      for (const a of historyAssets) {
        addHistoryImageToMediaRow(row, a, activeId ? ensureSessionUi(activeId) : null);
      }
    }
    return;
  }
  renderHistoryWithAssets(sessionHistory, historyAssets, activeMeta);
}


function estimateContextUsage(sid) {
  let n = 0;
  const id = sid || activeId;
  const st = id ? sessionUi.get(id) : null;
  const hist = (id && id === activeId ? sessionHistory : null) || st?.history || [];
  for (const m of hist || []) {
    n += String(m.text || m.content || "").length;
    if (n > 400000) break;
  }
  if (st?.chunkBuf) n += pendingStreamLength(st.chunkBuf);
  if (id === activeId && ui.inner) {
    const stream = ui.inner.querySelector(".thought, .turn.assistant .body");
    if (stream) n += Math.min(80000, String(stream.textContent || "").length);
  }
  const prev = st?.usage;
  const used = Math.max(800, Math.round(n / 4) + 3500);
  return { used, size: Number(prev?.size) > 0 ? Number(prev.size) : 131072, estimated: true };
}

function bumpContextUsage(sid) {
  const id = sid || activeId;
  if (!id) return;
  const est = estimateContextUsage(id);
  const prev = sessionUi.get(id)?.usage;
  if (prev && !prev.estimated && Number(prev.used) >= est.used) {
    applyContextUsage(prev, id);
    return;
  }
  applyContextUsage({
    used: Math.max(est.used, Number(prev?.used) || 0),
    size: Number(prev?.size) > 0 ? Number(prev.size) : est.size,
    estimated: !prev || prev.estimated,
  }, id);
}

function applyContextUsage(usage, sid) {
  if (!usage || !ui.ctxChip) return;
  const prev = sid ? sessionUi.get(sid)?.usage : null;
  let used = Number(usage.used);
  let size = Number(usage.size);
  if (!Number.isFinite(size) || size <= 0) size = Number(prev?.size) > 0 ? Number(prev.size) : 131072;
  if (!Number.isFinite(used)) used = Number(prev?.used);
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
  if (usage.estimated && prev && !prev.estimated && used < prev.used) {
    used = prev.used;
  }
  if (sid) {
    const st = ensureSessionUi(sid);
    st.usage = { ...prev, ...usage, used, size };
  }
  if (sid && activeId && sid !== activeId) return;
  const pct = Math.min(100, Math.max(0, (used / size) * 100));
  const est = usage.estimated ? "约 " : "";
  ui.ctxChip.hidden = false;
  ui.ctxChip.classList.toggle("warn", pct >= 75 && pct < 90);
  ui.ctxChip.classList.toggle("hot", pct >= 90);
  const fg = ui.ctxChip.querySelector(".ctx-ring-fg");
  if (fg) {
    const circ = 43.98;
    fg.style.strokeDasharray = String(circ);
    fg.style.strokeDashoffset = String(circ * (1 - pct / 100));
  }
  if (ui.ctxChipLabel) ui.ctxChipLabel.textContent = `${est}${formatTok(used)} / ${formatTok(size)} · ${pct.toFixed(0)}%`;
  const cost = usage.cost;
  const costTxt = cost && Number.isFinite(Number(cost.amount))
    ? ` · ${cost.currency || ""} ${Number(cost.amount).toFixed(3)}`
    : "";
  ui.ctxChip.title = `上下文 ${formatTok(used)} / ${formatTok(size)}（${pct.toFixed(1)}%）${costTxt}${usage.estimated ? " · 估算" : ""} · 点击查看 /context`;
}


function applyProxyForm(ds) {
  const url = (ds?.proxyUrl || desktopSettings.proxyUrl || "").trim();
  const on = ds?.proxyEnabled != null ? !!ds.proxyEnabled : !!url;
  if ($("set-proxy")) $("set-proxy").value = url;
  if ($("set-proxy-on")) $("set-proxy-on").checked = on;
  refreshProxyUi();
}

function refreshProxyUi() {
  const on = !!$("set-proxy-on")?.checked;
  const url = ($("set-proxy")?.value || "").trim();
  const st = $("set-proxy-status");
  if (st) st.textContent = on && url ? "已启用" : "未启用";
}

async function refreshSessionUsage(sid) {
  const id = sid || activeId;
  if (!id || !grokDesktop.sessionUsage) return;
  try {
    const u = await grokDesktop.sessionUsage(id);
    if (u?.ok) applyContextUsage({ used: u.used, size: u.size, estimated: false }, id);
  } catch {
    /* ignore */
  }
}

function applyHeader(s, opts = {}) {
  if (!opts.soft) activeMeta = s || null;
  else if (s) activeMeta = { ...(activeMeta || {}), ...s };
  else activeMeta = s || null;

  const meta = activeMeta;
  if (meta?.id && !opts.soft) {
    const st = ensureSessionUi(meta.id);
    const prevTitle = st.meta?.title;
    st.meta = { ...(st.meta || {}), ...meta };
    // Only refresh the visible sidebar when the title changes.
    if (meta.title && meta.title !== prevTitle) refreshSidebarSessionState();
  }
  ui.title.textContent = meta?.title || (uiLocale() === "en" ? "Session" : "会话");

  // Mac-style subtitle: path · absolute time · run duration
  const en = uiLocale() === "en";
  const bits = [];
  if (meta?.cwd) bits.push(shortPath(meta.cwd));
  if (meta?.updatedAt) {
    const abs = formatAbsoluteTime(meta.updatedAt);
    if (abs) bits.push(abs);
  }
  if (meta?.id && runStartedAt.has(meta.id)) {
    const clock = formatElapsedClock(Date.now() - runStartedAt.get(meta.id));
    bits.push(en ? `Processing ${clock}` : `处理中 ${clock}`);
  } else if (meta?.id && lastRunDurationMs.has(meta.id)) {
    const d = formatDuration(lastRunDurationMs.get(meta.id));
    if (d) bits.push(en ? `Last run ${d}` : `本次用时 ${d}`);
  } else if (meta?.model) {
    bits.push(shortModelName(meta.model) || meta.model);
  }
  ui.sub.textContent = bits.join(" · ") || (en ? "Pick a session or start a new chat" : "选择左侧会话继续，或开始新对话");
  if (meta?.updatedAt) ui.sub.title = formatFullDateTime(meta.updatedAt);

  const cwdShow = meta?.cwd || sessions.find((x) => x.id === (meta?.id || activeId))?.cwd || lastUsedCwd;
  if (ui.cwdChip) {
    ui.cwdChip.textContent = shortPath(cwdShow);
    ui.cwdChip.title = cwdShow || "";
  }
  if (!opts.soft) {
    const stUse = meta?.id ? ensureSessionUi(meta.id) : (activeId ? ensureSessionUi(activeId) : null);
    if (stUse?.usage) applyContextUsage(stUse.usage, meta?.id || activeId);
    else applyContextUsage(estimateContextUsage(), meta?.id || activeId);
    void refreshSessionUsage(meta?.id || activeId);
  }
  ui.sessionActions.classList.toggle("hidden", !meta?.id);
  if (!opts.soft) updateLiveStrip();
  else {
    // soft: only duration bits on strip
    updateLiveStripDurationOnly();
  }
}

// images
function renderAttachPreview() {
  ui.attachPreview.replaceChildren();
  if (!pendingImages.length) {
    ui.attachPreview.classList.add("hidden");
    setComposerEnabled(!!activeId && !connecting);
    return;
  }
  ui.attachPreview.classList.remove("hidden");
  pendingImages.forEach((img, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "attach-thumb";
    const el = document.createElement("img");
    el.src = img.dataUrl;
    el.alt = img.name || "图片";
    el.title = "点击放大";
    el.onclick = (e) => { e.stopPropagation(); openLightbox(img.dataUrl); };
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.onclick = () => {
      pendingImages.splice(idx, 1);
      renderAttachPreview();
    };
    wrap.append(el, rm);
    ui.attachPreview.appendChild(wrap);
  });
  setComposerEnabled(!!activeId && !connecting);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  for (const file of files) {
    if (!file.type?.startsWith("image/")) continue;
    const dataUrl = await readFileAsDataUrl(file);
    const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) continue;
    pendingImages.push({ name: file.name, mimeType: m[1], dataBase64: m[2], dataUrl });
  }
  renderAttachPreview();
}

async function addDroppedFiles(fileList) {
  const dropped = [...(fileList || [])];
  if (!dropped.length) return;
  const imageFiles = dropped.filter((file) => file.type?.startsWith("image/") && file.size > 0);
  if (imageFiles.length) await addImageFiles(imageFiles);

  const paths = dropped
    .map((file) => grokDesktop.getPathForFile?.(file) || file.path || "")
    .filter(Boolean);
  if (!paths.length) return;
  const descriptors = await grokDesktop.describeFilePaths?.([...new Set(paths)]) || [];
  for (const f of descriptors) {
    if (f.isImage) {
      const image = await grokDesktop.readImage?.(f.path);
      if (image?.dataUrl && !pendingImages.some((x) => x.path === f.path || x.name === f.name)) {
        pendingImages.push(image);
      }
    } else if (!pendingFiles.some((x) => x.path === f.path)) {
      pendingFiles.push(f);
    }
  }
  renderAttachPreview();
  renderContextChips();
  setComposerEnabled(!!activeId && !connecting);
}

ui.fileBtn?.addEventListener("click", async () => {
  try {
    const files = await grokDesktop.pickFiles();
    const list = files || [];
    const paths = list.map((f) => f.path).filter(Boolean);
    const descriptors = paths.length
      ? (await grokDesktop.describeFilePaths?.([...new Set(paths)])) || []
      : [];
    const byPath = new Map(descriptors.map((d) => [d.path, d]));
    for (const f of list) {
      const desc = byPath.get(f.path) || f;
      if (looksLikeImageFile(desc) || looksLikeImageFile(f)) {
        let image = null;
        try { image = await grokDesktop.readImage?.(f.path); } catch { /* gone */ }
        if (image?.dataUrl && !pendingImages.some((x) => x.path === f.path || x.name === (image.name || f.name))) {
          pendingImages.push({ ...image, path: image.path || f.path, name: image.name || f.name });
        } else if (!image?.dataUrl && !pendingFiles.some((x) => x.path === f.path)) {
          pendingFiles.push(desc);
        }
      } else if (!pendingFiles.some((x) => x.path === f.path)) {
        pendingFiles.push(desc);
      }
    }
    renderAttachPreview();
    renderContextChips();
    setComposerEnabled(!!activeId);
  } catch (err) {
    appendBanner(`附加文件失败：${err.message}`, "error");
  }
});

function insertTextAtCursor(text) {
  const el = ui.input;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + text + after;
  const pos = start + text.length;
  el.selectionStart = el.selectionEnd = pos;
  el.focus();
  el.dispatchEvent(new Event("input", { bubbles: true }));
  autosize();
}

/** Clipboard read for native context-menu "粘贴到输入框" (no toolbar button). */
async function addNativeClipboardImage() {
  if (!grokDesktop.readClipboardImage) return false;
  try {
    const img = await grokDesktop.readClipboardImage();
    if (!img?.ok || !img.dataUrl) return false;
    if (pendingImages.some((x) => x.dataUrl === img.dataUrl)) return true;
    pendingImages.push({
      name: img.name || "paste.png",
      mimeType: img.mimeType || "image/png",
      dataBase64: img.dataBase64,
      dataUrl: img.dataUrl,
    });
    renderAttachPreview();
    return true;
  } catch {
    return false;
  }
}

async function pasteFromClipboard() {
  if (ui.input?.disabled && !activeId) return false;
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      const files = [];
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            files.push(new File([blob], `paste.${type.split("/")[1] || "png"}`, { type }));
          }
        }
      }
      if (files.length) {
        await addImageFiles(files);
        return true;
      }
    }
    if (await addNativeClipboardImage()) return true;
    if (navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (text) {
        insertTextAtCursor(text);
        return true;
      }
    }
  } catch {
    /* permission / empty clipboard */
  }
  return false;
}

// From main-process native context menu
grokDesktop.onInsertText?.((text) => {
  if (typeof text === "string" && text) insertTextAtCursor(text);
});
grokDesktop.onTrayNewSession?.(() => {
  void newSession();
});

grokDesktop.onOpenSession?.(({ sessionId } = {}) => {
  if (sessionId) void selectSession(sessionId);
});

grokDesktop.onTrayHint?.(() => {
  flashToast(t("tray.hint"));
});

grokDesktop.onAppCommand?.(({ command } = {}) => {
  if (command === "new-session") void newSession();
  else if (command === "open-settings") switchView("settings");
  else if (command === "open-about") {
    switchView("settings");
    showSettingsPanel("about");
  } else if (command === "toggle-plan") {
    if (activeId && view === "chat") setPlanOpen(!planOpen);
  } else if (command === "check-update") {
    switchView("settings");
    showSettingsPanel("about");
    void checkForUpdates(true);
  }
});

/** Debounce completion toasts (sendPrompt + status events can both fire) */
const recentDoneNotify = new Map();

/** Notify when done if the user is not looking at this session / window */
async function maybeNotifyDone(sessionId, title) {
  if (desktopSettings.notifyOnDone === false) return;
  const key = sessionId || "_";
  const now = Date.now();
  if (recentDoneNotify.has(key) && now - recentDoneNotify.get(key) < 4000) return;
  let occluded = document.hidden;
  try {
    if (typeof grokDesktop.isOccluded === "function") {
      occluded = !!(await grokDesktop.isOccluded());
    }
  } catch {
    occluded = document.hidden;
  }
  const backgroundTab = sessionId && sessionId !== activeId;
  if (!occluded && !backgroundTab) return;
  recentDoneNotify.set(key, now);
  void grokDesktop.notify?.({
    title: t("notify.doneTitle"),
    body: t("notify.doneBody", { title: title || sessionId?.slice(0, 8) || "session" }),
    sessionId,
  });
  void grokDesktop.flashFrame?.(true);
}

function syncBusyChrome() {
  const n = workingSessions.size;
  void grokDesktop.setBusyCount?.(n);
  const busy = !!(activeId && (workingSessions.has(activeId) || promptInFlight.has(activeId)));
  document.body.classList.toggle("agent-busy", busy);
  if (!busy && activeId) ensureLastTurnActions(activeId);
  paintRunStatus();
}

function ensureLastTurnActions(sid) {
  const turnUsage = sid ? ensureSessionUi(sid).lastTurnUsage : null;
  if (turnUsage) paintTurnCost(sid, turnUsage);
}

grokDesktop.onPasteRequest?.(() => {
  void pasteFromClipboard();
});

// Ctrl/Cmd+V and system paste (voice IME often injects text here)
document.addEventListener("paste", (e) => {
  if (view !== "chat" && view !== "welcome") return;
  const files = [];
  for (const it of e.clipboardData?.items || []) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    void addImageFiles(files);
    return;
  }
  // Windows screenshots often skip clipboardData.items — read via Electron.
  if (e.clipboardData && !e.clipboardData.getData("text/plain")) {
    e.preventDefault();
    void addNativeClipboardImage();
    return;
  }
  if (document.activeElement !== ui.input && e.clipboardData) {
    const text = e.clipboardData.getData("text/plain");
    if (text) {
      e.preventDefault();
      insertTextAtCursor(text);
    }
  }
});

// Drag & drop images, files, and folders into chat / composer.
["thread", "composer-dock"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("dragenter", () => el.classList.add("drop-target-active"));
  el.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove("drop-target-active");
  });
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop-target-active");
    if (!activeId) return;
    void addDroppedFiles(e.dataTransfer?.files || []);
  });
});


function adoptHistoryPlan(st, hist, isActive) {
  if (!st) return;
  const sid = st.meta?.id || activeId;
  if (hist?.plan) {
    st.plan = hist.plan;
    if (isPlanAllDone(hist.plan)) {
      clearFinishedGoal(sid, { paint: false });
      if (isActive) {
        setPlanOpen(false);
        renderPlan(null);
      }
    } else if (isActive) {
      renderPlan(hist.plan);
    }
  }
  if (hist?.goal && hist.goal.kind === "goal" && !isPlanAllDone(st.plan)) {
    if (sid) setSessionAutomation(sid, "goal", hist.goal.label || "goal", { paused: !!hist.goal.paused });
  }
  if (isActive) renderWorkCard();
}

const SESSION_LOAD_STAGES = ["history", "runtime", "ready"];

function clearScheduledSessionLoadStage(state) {
  if (!state?.loadStageTimer) return;
  clearTimeout(state.loadStageTimer);
  state.loadStageTimer = 0;
}

function scheduleSessionLoadStage(sessionId, stage = "history", detail = "", delay = 500) {
  const context = sessionRenderContext(sessionId);
  const { pane, state } = context;
  if (!pane || !state) return;
  clearScheduledSessionLoadStage(state);
  // Existing conversation content is already the useful loading state. Keep
  // connection progress in the compact status pill instead of covering chat.
  if (pane.querySelector(".turn, .tool-group, .diff-card, .banner")) return;
  state.loadStageTimer = setTimeout(() => {
    state.loadStageTimer = 0;
    setSessionLoadStage(sessionId, stage, detail);
  }, delay);
}

function setSessionLoadStage(sessionId, stage, detail = "") {
  if (!sessionId) return;
  const context = sessionRenderContext(sessionId);
  const { pane, state } = context;
  if (!pane || !state) return;
  clearScheduledSessionLoadStage(state);
  let card = state.loadStageEl;
  if (stage === "ready" && !card?.isConnected) return;
  if (stage === "runtime" && !card?.isConnected && pane.querySelector(".turn, .tool-group, .diff-card, .banner")) return;
  if (!card?.isConnected) {
    card = document.createElement("aside");
    card.className = "session-load-stage";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");
    card.innerHTML = `
      <div class="session-load-title"></div>
      <ol>
        <li data-stage="history"><span></span></li>
        <li data-stage="runtime"><span></span></li>
        <li data-stage="ready"><span></span></li>
      </ol>
      <div class="session-load-detail"></div>`;
    const labels = { history: t("load.history"), runtime: t("load.runtime"), ready: t("load.usable") };
    for (const item of card.querySelectorAll("li")) item.querySelector("span").textContent = labels[item.dataset.stage];
    pane.prepend(card);
    state.loadStageEl = card;
  }
  card.className = `session-load-stage stage-${stage}`;
  const index = SESSION_LOAD_STAGES.indexOf(stage);
  for (const item of card.querySelectorAll("li")) {
    const itemIndex = SESSION_LOAD_STAGES.indexOf(item.dataset.stage);
    item.classList.toggle("done", stage !== "error" && itemIndex < index);
    item.classList.toggle("active", stage !== "error" && itemIndex === index);
  }
  const title = card.querySelector(".session-load-title");
  if (title) {
    title.textContent = stage === "error"
      ? t("load.failed")
      : stage === "history"
        ? t("load.opening")
        : stage === "runtime"
          ? t("load.historyReady")
          : t("load.ready");
  }
  const detailEl = card.querySelector(".session-load-detail");
  if (detailEl) detailEl.textContent = detail || "";
  if (stage === "ready") {
    card.classList.add("complete");
    setTimeout(() => {
      if (state.loadStageEl === card) state.loadStageEl = null;
      card.remove();
    }, 250);
  }
}

// session open / send
async function selectSession(sessionId) {
  if (!sessionId) return;
  // Already focused + live → just focus input
  if (sessionId === activeId && !connecting && liveAgents.has(sessionId) && activeMeta) {
    ui.input.focus();
    return;
  }

  const seq = ++openSeq;
  const prevId = activeId;
  const wasLive = liveAgents.has(sessionId);
  const stTarget = ensureSessionUi(sessionId);

  // Stash composer for previous session (attachments / queue stay per-tab)
  if (prevId && prevId !== sessionId) stashComposer(prevId);

  // Instant UI: switch pane + header before any await
  activatePane(sessionId);
  activeId = sessionId;
  addOpenTab(sessionId);
  markActive(sessionId);
  void persistOpenTabs();

  const cachedMeta =
    stTarget.meta || sessions.find((x) => x.id === sessionId) || null;
  if (cachedMeta) applyHeader(cachedMeta);
  if (cachedMeta?.model) {
    currentModelId = cachedMeta.model;
    syncModelChip();
  }
  restoreComposer(sessionId);
  restoreComposerModeForSession(sessionId);
  setBusy(promptInFlight.has(sessionId) || workingSessions.has(sessionId));
  renderPlan(stTarget.plan);

  const paneHasContent =
    ui.inner &&
    !ui.inner.querySelector(".welcome") &&
    !!ui.inner.querySelector(".turn.user");
  paintRunStatus();

  // Restore per-session history assets when soft-switching
  if (stTarget.historyAssets) historyAssets = stTarget.historyAssets;

  // ── Soft switch: agent already live ─────────────────
  if (wasLive) {
    // One-time: re-place session images if older open left them stuck at the bottom
    if (
      paneHasContent &&
      !workingSessions.has(sessionId) &&
      !stTarget.mediaPlacedV2 &&
      (stTarget.historyAssets?.length || 0) > 0
    ) {
      try {
        const hist = await grokDesktop.loadHistory(sessionId);
        if (seq !== openSeq) return;
        if (hist.session) {
          applyHeader(hist.session);
          stTarget.meta = hist.session;
        }
        const uiState = applyHistorySidecar(hist, stTarget);
        sessionHistory = (hist.messages || []).map((m) => ({ ...m }));
        restoreDraftFromUi(uiState);
        historyAssets = hist.assets || [];
        stTarget.history = sessionHistory.slice();
        stTarget.historyAssets = historyAssets;
        historyFrom = tailHistoryFrom(sessionHistory);
        stTarget.historyFrom = historyFrom;
        stTarget.toolCardMap = new Map();
        stTarget.diffCardMap = new Map();
        stTarget.diffPathMap = new Map();
        stTarget.streamingEl = null;
        stTarget.mediaPlacedV2 = true;
        seenMedia = new Set();
        stTarget.seenMedia = seenMedia;
        renderHistory();
        adoptHistoryPlan(stTarget, hist, true);
        restoreComposerModeForSession(sessionId);
        schedulePinThreadToBottom();
      } catch {
        stTarget.mediaPlacedV2 = true; // don't loop
      }
    } else if (paneHasContent) {
      stTarget.mediaPlacedV2 = true;
    }

    // Pane was discarded (e.g. tab closed earlier) — hydrate history without reconnect flash
    if (!paneHasContent) {
      scheduleSessionLoadStage(sessionId, "history");
      try {
        const hist = await grokDesktop.loadHistory(sessionId);
        if (seq !== openSeq) return;
        if (hist.session) {
          applyHeader(hist.session);
          stTarget.meta = hist.session;
        }
        const uiState = applyHistorySidecar(hist, stTarget);
        sessionHistory = (hist.messages || []).map((m) => ({ ...m }));
        restoreDraftFromUi(uiState);
        historyAssets = hist.assets || [];
        // With images: start window early enough to place them mid-thread
        historyFrom = tailHistoryFrom(sessionHistory);
        stTarget.history = sessionHistory.slice();
        stTarget.historyFrom = historyFrom;
        stTarget.toolCardMap = new Map();
        stTarget.diffCardMap = new Map();
        stTarget.diffPathMap = new Map();
        stTarget.historyAssets = historyAssets;
        stTarget.mediaPlacedV2 = true;
        seenMedia = new Set();
        stTarget.seenMedia = seenMedia;
        stTarget.streamingEl = null;
        renderHistory();
        setSessionLoadStage(sessionId, "ready");
        adoptHistoryPlan(stTarget, hist, true);
        restoreComposerModeForSession(sessionId);
        schedulePinThreadToBottom();
      } catch {
        /* keep empty pane */
        setSessionLoadStage(sessionId, "error", uiLocale() === "en" ? "Local history could not be read" : "本地历史读取失败");
      }
    }

    connecting = false;
    scheduleTurnFileSummary(sessionId);
    const working = workingSessions.has(sessionId);
    setBusy(working);
    setStatus(
      working ? "working" : stTarget.statusState || "ready",
      working
        ? "思考中…"
        : localizeStatus(stTarget.statusState || "ready", stTarget.statusDetail || "已连接"),
    );
    setComposerEnabled(true);
    if (stTarget.models) setModelsState(stTarget.models);
    if (commandsLookLocalized(stTarget.commands)) {
      adoptSlashCommands(stTarget.commands);
    }
    renderWorkCard();
    ui.input.focus();
    schedulePinThreadToBottom();
    maybeFlushIdleQueue(sessionId);

    // Silent focus in main — no "connecting…" status
    try {
      let res = null;
      if (typeof grokDesktop.activateSession === "function") {
        res = await grokDesktop.activateSession(sessionId);
        if (!res?.ok) {
          res = await grokDesktop.openSession(sessionId, { soft: true });
        }
      } else {
        res = await grokDesktop.openSession(sessionId, { soft: true });
      }
      if (seq !== openSeq) return;
      if (res?.session) {
        applyHeader(res.session);
        stTarget.meta = { ...(stTarget.meta || {}), ...res.session };
      }
      // Prefer IPC payload only when already localized (main.commandsForRenderer)
      if (!applySlashCatalog(res?.commands, stTarget)) {
        await refreshSlashCatalog(sessionId, stTarget, seq);
      }
      if (res?.models) {
        stTarget.models = res.models;
        setModelsState(res.models);
      }
      void applyPreferredDefaults(sessionId);
      if (res?.openIds) liveAgents = new Set(res.openIds);
      else liveAgents.add(sessionId);
      renderWorkCard();
    } catch {
      /* soft failures ignored — UI already usable */
    }
    return;
  }

  // ── Cold open: need history + spawn agent ───────────
  connecting = true;
  setBusy(false);
  setStatus("connecting", "加载中…");
  scheduleSessionLoadStage(sessionId, "history");
  setComposerEnabled(true);

  let meta = cachedMeta;
  if (!paneHasContent) {
    try {
      const hist = await grokDesktop.loadHistory(sessionId);
      if (seq !== openSeq) return;
      if (hist.session) meta = hist.session;
      applyHeader(meta);
      stTarget.meta = meta;
      const uiState = applyHistorySidecar(hist, stTarget);
        sessionHistory = (hist.messages || []).map((m) => ({ ...m }));
        restoreDraftFromUi(uiState);
      historyAssets = hist.assets || [];
      historyFrom = tailHistoryFrom(sessionHistory);
      stTarget.history = sessionHistory.slice();
      stTarget.historyFrom = historyFrom;
      stTarget.toolCardMap = new Map();
      stTarget.diffCardMap = new Map();
      stTarget.diffPathMap = new Map();
      stTarget.historyAssets = historyAssets;
      stTarget.mediaPlacedV2 = true;
      seenMedia = new Set();
      stTarget.seenMedia = seenMedia;
      stTarget.streamingEl = null;
      stTarget.replayOpen = false;
      renderHistory();
      setSessionLoadStage(sessionId, "ready");
      adoptHistoryPlan(stTarget, hist, true);
      restoreComposerModeForSession(sessionId);
    } catch (err) {
      if (seq !== openSeq) return;
      applyHeader(meta);
      clearThread();
      appendBanner(`读取历史失败：${err?.message || err}`, "error");
      setSessionLoadStage(sessionId, "error", err?.message || String(err));
    }
  } else if (meta) {
    applyHeader(meta);
  }

  connecting = false;
  stTarget.replayOpen = false;
  stTarget.statusState = "idle";
  stTarget.statusDetail = "就绪";
  setStatus("idle", "就绪");
  setBusy(false);
  setComposerEnabled(true);
  addOpenTab(sessionId);
  renderPlan(stTarget.plan);
  renderWorkCard();
  ui.input.focus();
  schedulePinThreadToBottom();
  maybeFlushIdleQueue(sessionId);
  void ensureSessionConnected(sessionId);
}

const connectInFlight = new Map();

async function ensureSessionConnected(sessionId) {
  if (!sessionId) return null;
  if (liveAgents.has(sessionId)) return { ok: true, reused: true };
  if (connectInFlight.has(sessionId)) return connectInFlight.get(sessionId);
  const job = (async () => {
    if (sessionId === activeId) setStatus("connecting", "连接助手…");
    scheduleSessionLoadStage(
      sessionId,
      "runtime",
      uiLocale() === "en" ? "Local history stays available" : "本地历史仍可查看",
      700,
    );
    try {
      const res = await grokDesktop.openSession(sessionId, { soft: true });
      if (res?.cancelled) return res;
      if (res?.ok !== false) liveAgents.add(sessionId);
      if (res?.openIds) liveAgents = new Set(res.openIds);
      if (res?.models) setModelsState(res.models);
      void applyPreferredDefaults(sessionId);
      if (sessionId === activeId && !promptInFlight.has(sessionId)) {
        setStatus("ready", "已连接");
      }
      setSessionLoadStage(sessionId, "ready");
      if (res?.ok !== false && !res?.reused) {
        const st = ensureSessionUi(sessionId);
        const q = sessionId === activeId ? messageQueue : st.messageQueue;
        if (!st.stopped && !st.skipGoalResume && !st.desktopUi?.stopped && !(q || []).length) {
          void maybeResumeGoal(sessionId);
        }
      }
      return res;
    } catch (err) {
      if (sessionId === activeId) setStatus("error", err?.message || "连接失败");
      setSessionLoadStage(sessionId, "error", err?.message || (uiLocale() === "en" ? "Connection failed" : "连接失败"));
      throw err;
    }
  })();
  connectInFlight.set(sessionId, job);
  try {
    return await job;
  } finally {
    connectInFlight.delete(sessionId);
  }
}

function listKnownProjectCwds() {
  const seen = new Map();
  const add = (cwd) => {
    if (!cwd) return;
    const key = String(cwd).replace(/[\\/]+$/, "").toLowerCase();
    if (!seen.has(key)) seen.set(key, cwd);
  };
  for (const sess of sessions || []) add(sess.cwd);
  add(lastUsedCwd);
  add(activeMeta?.cwd);
  return [...seen.values()];
}

function pickNewSessionCwd() {
  const known = listKnownProjectCwds();
  if (!known.length) return grokDesktop.pickDirectory();
  return new Promise((resolve) => {
    const root = $("cwd-picker");
    const list = $("cwd-picker-list");
    const browse = $("cwd-picker-browse");
    const cancel = $("cwd-picker-cancel");
    const backdrop = $("cwd-picker-backdrop");
    if (!root || !list) {
      resolve(grokDesktop.pickDirectory());
      return;
    }
    const priorFocus = document.activeElement;
    list.replaceChildren();
    const recent = lastUsedCwd || activeMeta?.cwd || "";
    const finish = (value) => {
      root.classList.add("hidden");
      root.setAttribute("aria-hidden", "true");
      syncModalInert();
      browse.onclick = null;
      cancel.onclick = null;
      backdrop.onclick = null;
      document.removeEventListener("keydown", onKey);
      a11y.restoreFocus?.(priorFocus);
      resolve(value || null);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "Tab") {
        a11y.trapTabKey?.(root, e);
      }
    };
    for (const cwd of known) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cwd-picker-item" + (cwd === recent ? " is-recent" : "");
      const name = document.createElement("span");
      name.className = "cwd-picker-name";
      name.textContent = fileBasename(cwd);
      const path = document.createElement("span");
      path.className = "cwd-picker-path";
      path.textContent = cwd;
      if (cwd === recent) {
        const tag = document.createElement("span");
        tag.className = "cwd-picker-tag";
        tag.textContent = "最近";
        btn.append(name, path, tag);
      } else {
        btn.append(name, path);
      }
      btn.title = cwd + "\n右键从文件夹打开";
      btn.setAttribute("aria-label", `${fileBasename(cwd)}，${cwd}${cwd === recent ? "，最近使用" : ""}`);
      btn.onclick = () => finish(cwd);
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void openProjectFolder(cwd);
      });
      list.appendChild(btn);
    }
    browse.onclick = async () => {
      root.classList.add("hidden");
      const picked = await grokDesktop.pickDirectory();
      finish(picked || null);
    };
    cancel.onclick = () => finish(null);
    backdrop.onclick = () => finish(null);
    document.addEventListener("keydown", onKey);
    root.classList.remove("hidden");
    root.setAttribute("aria-hidden", "false");
    syncModalInert();
    requestAnimationFrame(() => {
      (list.querySelector("button:not([disabled])") || browse || cancel)?.focus();
    });
  });
}

async function newSession(options = {}) {
  if (connecting) return;
  switchView("chat");
  let cwd = options.cwd || null;
  if (!cwd) cwd = await pickNewSessionCwd();
  if (!cwd) return null;
  lastUsedCwd = cwd;
  const prevId = activeId;
  if (prevId) stashComposer(prevId);
  const seq = ++openSeq;
  connecting = true;
  setStatus("connecting", "创建中…");
  setBusy(false);
  setComposerEnabled(true);
  pendingImages = [];
  pendingFiles = [];
  messageQueue = [];
  removeQueuedTurns();
  renderAttachPreview();
  renderContextChips();
  try {
    const res = await grokDesktop.newSession(cwd);
    if (seq !== openSeq) return;
    const sid = res.session.id;
    // Mount a fresh pane for the new session
    ensureSessionUi(sid);
    ensurePane(sid);
    activatePane(sid);
    activeId = sid;
    sessionHistory = [];
    historyFrom = 0;
    historyAssets = [];
    seenMedia = new Set();
    messageQueue = [];
    const stNew = ensureSessionUi(sid);
    stNew.history = [];
    stNew.historyFrom = 0;
    stNew.historyAssets = [];
    stNew.seenMedia = seenMedia;
    stNew.messageQueue = [];
    rerenderQueuedTurns();
    stNew.composerMode = "task";
    sessionAutomation.delete(sid);
    planModePending = false;
    paintComposerMode("task");
    hideAutoBar();
    let meta = { ...res.session, title: res.session.title || "新对话", cwd: res.session.cwd || cwd };
    if (options.desiredTitle) {
      try {
        await grokDesktop.renameSession(sid, options.desiredTitle);
        meta = { ...meta, title: options.desiredTitle };
      } catch {
        /* keep the server-provided title */
      }
    }
    applyHeader(meta);
    if (lastAccountUsage) paintAccountUsage(lastAccountUsage);
    void refreshAccountUsage();
    // Optimistic insert so it shows even before disk scan
    sessions = [
      {
        id: meta.id,
        cwd: meta.cwd,
        title: meta.title || "新对话",
        summary: meta.title || "新对话",
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        numMessages: 0,
      },
      ...sessions.filter((s) => s.id !== meta.id),
    ];
    if (res?.openIds) liveAgents = new Set(res.openIds);
    else liveAgents.add(sid);
    addOpenTab(sid);
    renderSidebar(ui.search.value);
    markActive(activeId);
    clearThread();
    appendBanner("新对话已创建，已出现在左侧列表。可同时开多个会话并行运行。");
    setStatus("ready", "新对话");
    connecting = false;
    setComposerEnabled(true);
    await refreshSessions();
  bootMark("refreshSessions");
    markActive(activeId);
    try {
      const cl = await grokDesktop.listCommands(sid);
      if (cl?.commands?.length) adoptSlashCommands(cl.commands);
      else adoptSlashCommands([]);
    } catch {
      adoptSlashCommands([]);
    }
    if (res?.models) setModelsState(res.models);
    void applyPreferredDefaults(sid);
    setTimeout(async () => {
      try {
        const cl = await grokDesktop.listCommands(sid);
        if (cl?.commands?.length) adoptSlashCommands(cl.commands);
        else adoptSlashCommands([]);
        const ml = await grokDesktop.listModels(sid);
        setModelsState(ml);
        void applyPreferredDefaults(sid);
      } catch {
        /* ignore */
      }
    }, 800);
    if (options.initialPrompt) {
      await sendNow({
        text: options.initialPrompt,
        images: [],
        files: [],
        sessionId: sid,
        displayText: options.initialDisplayText || options.initialPrompt,
      });
    }
    ui.input.focus();
    return sid;
  } catch (err) {
    connecting = false;
    setStatus("error", err?.message || "创建失败");
    appendBanner(`创建失败：${err?.message || err}`, "error");
    return null;
  }
}

/**
 * CLI 风格插话：停掉当前轮 → 立刻发新话上屏，助手马上读到。
 * （不是排队等本轮结束）
 */
async function interruptAndSend({ text, images, files, displayText = null }) {
  const sid = activeId;
  if (!sid) return;
  const st = ensureSessionUi(sid);
  st.goalResumeTried = true;
  const sendText = unwrapGoalWrap(text, displayText);

  // 作废旧 sendNow 的 finally（避免旧轮 flush/抢状态）
  const myGen = nextSendGeneration(sid);

  setStatus("working", "打断中…");
  try {
    await grokDesktop.cancel(sid);
  } catch {
    /* 无进行中的轮次也没关系 */
  }

  promptInFlight.delete(sid);
  workingSessions.delete(sid);
  markRunEnd(sid);

  await new Promise((r) => setTimeout(r, 200));
  if (myGen !== currentSendGeneration(sid)) return;

  setBusy(false);
  await sendNow({
    text: sendText,
    images,
    files,
    sessionId: sid,
    generation: myGen,
    displayText: displayText || sendText,
  });
}

const CALL_MAX_DEPTH = 6;
const callMonitors = new Map();

function noteCallActivity(sid, line) {
  const rec = callMonitors.get(sid);
  if (!rec || !line) return;
  const text = String(line).replace(/\s+/g, " ").trim().slice(0, 160);
  if (!text) return;
  const now = Date.now();
  if (text === rec.lastLine && now - rec.lastAt < 1600) return;
  rec.lastLine = text;
  rec.lastAt = now;
  const log = rec.card?.querySelector(".cc-log");
  if (!log) return;
  const li = document.createElement("li");
  li.textContent = text;
  log.appendChild(li);
  while (log.children.length > 28) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  if (rec.callerId === activeId) {
    const clock = formatWaitClock(now - rec.startedAt);
    setStatus("working", `等待线程 · ${sessionTitleOf(sid)} · ${clock}`);
  }
}

function tickCallMonitor(rec) {
  if (!rec?.card) return;
  const clock = formatWaitClock(Date.now() - rec.startedAt);
  const el = rec.card.querySelector(".cc-clock");
  if (el) el.textContent = "耗时 " + clock;
  if (rec.callerId === activeId) {
    setStatus("working", `等待线程 · ${sessionTitleOf(rec.calleeId)} · ${clock}`);
  }
}

function startCallMonitor(callerId, calleeId, task) {
  const prev = callMonitors.get(calleeId);
  if (prev?.timer) clearInterval(prev.timer);
  let card = prev?.card;
  const context = sessionRenderContext(callerId);
  const pane = context.pane;
  if (pane) {
    pane.querySelector(".welcome")?.remove();
    if (!card || !card.isConnected) {
      card = document.createElement("div");
      pane.appendChild(card);
    }
    card.className = "call-card watching";
    card.innerHTML = `
      <div class="cc-top">
        <span class="cc-tag">等待线程</span>
        <button type="button" class="cc-jump" data-jump=""></button>
        <span class="cc-clock">耗时 0秒</span>
      </div>
      <div class="cc-task"></div>
      <ul class="cc-log"></ul>`;
    const jump = card.querySelector(".cc-jump");
    jump.dataset.jump = calleeId;
    jump.textContent = `${sessionTitleOf(calleeId)} · ${sessionModelOf(calleeId)}`;
    jump.onclick = () => { if (calleeId) void selectSession(calleeId); };
    if (task) card.querySelector(".cc-task").textContent = String(task).slice(0, 240);
    else card.querySelector(".cc-task").remove();
    if (context.isActive) scrollThreadToBottom?.({ force: threadFollowBottom });
  }
  const rec = {
    callerId,
    calleeId,
    card,
    startedAt: Date.now(),
    lastLine: "",
    lastAt: 0,
    timer: null,
  };
  rec.timer = setInterval(() => tickCallMonitor(rec), 1000);
  callMonitors.set(calleeId, rec);
  noteCallActivity(calleeId, "已派出，正在对方会话里跑");
  tickCallMonitor(rec);
}

function finishCallMonitor(calleeId, { files = [], reply = "", error = "" } = {}) {
  const rec = callMonitors.get(calleeId);
  if (!rec) return;
  if (rec.timer) clearInterval(rec.timer);
  const card = rec.card;
  if (card) {
    card.classList.remove("watching", "pending");
    card.classList.add(error ? "failed" : "done");
    const tag = card.querySelector(".cc-tag");
    if (tag) tag.textContent = error ? "对方失败" : "对方已完成";
    const clock = card.querySelector(".cc-clock");
    if (clock) clock.textContent = "耗时 " + formatWaitClock(Date.now() - rec.startedAt);
    const log = card.querySelector(".cc-log");
    if (files.length) {
      const ul = document.createElement("ul");
      ul.className = "cc-files";
      for (const f of files.slice(0, 12)) {
        const li = document.createElement("li");
        li.innerHTML = `<code></code> <span class="cc-k"></span>`;
        li.querySelector("code").textContent = f.label || f.path || "";
        li.querySelector(".cc-k").textContent = f.stats || "";
        ul.appendChild(li);
      }
      card.appendChild(ul);
    } else if (!error) {
      const empty = document.createElement("div");
      empty.className = "cc-k";
      empty.textContent = "没有文件改动";
      card.appendChild(empty);
    }
    if (reply) {
      const pre = document.createElement("pre");
      pre.className = "cc-reply";
      pre.textContent = String(reply).slice(0, 900);
      card.appendChild(pre);
    }
    if (error) {
      const err = document.createElement("div");
      err.className = "cc-k";
      err.textContent = String(error).slice(0, 240);
      card.appendChild(err);
    }
    if (log) log.scrollTop = log.scrollHeight;
  }
  callMonitors.delete(calleeId);
}


function sessionTitleOf(id) {
  return sessionTabTitle(id) || String(id || "").slice(0, 8);
}

function sessionModelOf(id) {
  const st = id ? sessionUi.get(id) : null;
  const mid =
    (id === activeId ? currentModelId : null) ||
    st?.meta?.model ||
    sessions.find((x) => x.id === id)?.model ||
    "";
  return shortModelName(mid) || mid || "Grok";
}

function lastAssistantText(sessionId) {
  const pane = typeof getPane === "function" ? getPane(sessionId) : null;
  if (!pane) return "";
  const turns = pane.querySelectorAll(".turn.assistant .body");
  const last = turns[turns.length - 1];
  return String(last?.innerText || "").trim();
}

function listDiffSummaries(sessionId) {
  const st = sessionUi.get(sessionId);
  if (!st?.diffCardMap) return [];
  const out = [];
  for (const card of new Set(st.diffCardMap.values())) {
    out.push({
      path: card.dataset.path || card.querySelector(".d-path")?.textContent || "",
      label: card.querySelector(".d-path")?.textContent || "",
      stats: String(card.querySelector(".d-stats")?.innerText || "").replace(/\s+/g, " ").trim(),
    });
  }
  return out.filter((x) => x.path || x.label);
}

function diffKey(d) {
  return `${d.path}|${d.stats}`;
}

function extractCallFromAssistant(sessionId) {
  const text = lastAssistantText(sessionId);
  if (!text) return null;
  const re =
    /\/call\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S[\s\S]*)$/gim;
  let last = null;
  let m;
  while ((m = re.exec(text))) {
    const task = String(m[2] || "")
      .replace(/\n\/[a-z].*$/i, "")
      .trim()
      .slice(0, 1500);
    if (task.length >= 2 && task !== "具体修正") last = { sessionId: m[1], text: task };
  }
  return last;
}

function formatCallReturn(calleeId, result, task) {
  const files = result.files || [];
  const fileLines = files.length
    ? files.map((f) => `- ${f.label || f.path} ${f.stats || ""}`).join("\n")
    : "- （没有文件改动）";
  const reply = String(result.reply || "").trim().slice(0, 3500);
  return [
    "[会话互调回报]",
    `被调会话：${sessionTitleOf(calleeId)} (${calleeId})`,
    `模型：${sessionModelOf(calleeId)}`,
    `任务：${String(task || "").slice(0, 400)}`,
    "",
    "改动文件：",
    fileLines,
    "",
    "对方回复：",
    reply || "（无文字回复）",
    "",
    "请只根据以上改动做审计，不要重读整份仓库。不对就再发一行：",
    `/call ${calleeId} 具体修正`,
    "对了就直接说结论，不要再 /call。",
  ].join("\n");
}

async function waitSessionIdle(id, ms = 8 * 60 * 1000) {
  const start = Date.now();
  while (id && (isAgentBusy(id) || promptInFlight.has(id))) {
    if (Date.now() - start > ms) throw new Error("对方还在忙，等不及了");
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function dispatchCallSession(sessionId, text, { callerId = null, depth = 0 } = {}) {
  if (!sessionId) throw new Error("没有会话 ID");
  const caller = callerId || activeId;
  const task = String(text || "").trim();
  if (!caller) throw new Error("先打开一个对话再调用");
  if (!task) throw new Error("用法：/call <会话ID> 消息");
  if (sessionId === caller) throw new Error("不能调用当前会话");
  if (depth >= CALL_MAX_DEPTH) {
    appendBanner("互调次数太多，先停一下", "error");
    return;
  }

  addOpenTab(sessionId);
  ensureSessionUi(sessionId);
  await ensureSessionConnected(sessionId);
  if (isAgentBusy(sessionId) || promptInFlight.has(sessionId)) {
    await waitSessionIdle(sessionId);
  }

  const beforeKeys = new Set(listDiffSummaries(sessionId).map(diffKey));
  startCallMonitor(caller, sessionId, task);
  if (caller === activeId) {
    setStatus("working", `等待线程 · ${sessionTitleOf(sessionId)}`);
    setBusy(true);
  }

  try {
    await sendNow({ text: task, sessionId, skipCall: true });
  } catch (err) {
    finishCallMonitor(sessionId, { error: err?.message || "调用失败" });
    if (caller === activeId) {
      setBusy(false);
      setStatus("error", err?.message || "调用失败");
    }
    throw err;
  }

  const files = listDiffSummaries(sessionId).filter((d) => !beforeKeys.has(diffKey(d)));
  const reply = lastAssistantText(sessionId);
  const result = { files, reply };
  finishCallMonitor(sessionId, { files, reply: reply.slice(0, 900) });

  if (isAgentBusy(caller) || promptInFlight.has(caller)) {
    if (caller === activeId) {
      setBusy(false);
      setStatus("ready", "对方已完成，当前这轮还在跑");
    }
    return;
  }

  const display = `${sessionModelOf(sessionId)} 回报 · ${files.length} 个文件`;
  await sendNow({
    text: formatCallReturn(sessionId, result, task),
    sessionId: caller,
    skipCall: true,
    displayText: display,
  });

  const next = extractCallFromAssistant(caller);
  if (next?.sessionId && next.sessionId !== caller && next.text) {
    await dispatchCallSession(next.sessionId, next.text, { callerId: caller, depth: depth + 1 });
  }
}

async function send() {
  const raw = ui.input.value.trim();
  if (!pendingImages.length && !pendingFiles.length) {
    const call = parseCallSession(raw);
    if (call?.sessionId) {
      ui.input.value = "";
      pendingImages = [];
      pendingFiles = [];
      renderAttachPreview();
      renderContextChips();
      autosize();
      try {
        if (call.bare) await selectSession(call.sessionId);
        else await dispatchCallSession(call.sessionId, call.text);
      } catch (err) {
        appendBanner(`调用会话失败：${err?.message || err}`, "error");
      }
      ui.input.focus();
      refreshSendButtonState();
      return;
    }
  }
  const text = applyWorkModeToPrompt(raw, { images: pendingImages, files: pendingFiles });
  // Bubble shows what the user typed; agent still receives official /goal · /plan forms
  const displayText =
    composerMode === "goal" && text !== raw && !/^\/goal\b/i.test(raw)
      ? raw
      : composerMode === "plan" && text !== raw && !/^\/plan\b/i.test(raw)
        ? raw
        : text;
  if ((!text && !pendingImages.length && !pendingFiles.length) || !activeId) return;
  if (connecting && !isAgentBusy(activeId) && !promptInFlight.has(activeId)) return;

  const images = pendingImages.slice();
  const files = pendingFiles.slice();

  // 任务进行中 + Enter/排队按钮 → 只排队，不打断
  if (isAgentBusy(activeId)) {
    ui.input.value = "";
    pendingImages = [];
    pendingFiles = [];
    renderAttachPreview();
    renderContextChips();
    autosize();
    enqueueFollowUp({ text, images, files, displayText });
    ui.input.focus();
    refreshSendButtonState();
    return;
  }

  try {
    await sendNow({ text, images, files, displayText });
  } catch (err) {
    const msg = formatSendError(err);
    // 主进程仍忙 → 先进排队，由用户点「引导」
    if (/仍在处理|上一轮|busy|处理中/i.test(msg)) {
      enqueueFollowUp({ text, images, files, displayText });
      ui.input.focus();
      refreshSendButtonState();
      return;
    }
    appendBanner(`发送失败：${msg}`, "error");
  }
}

/**
 * Send a prompt for a specific session (may not be the focused tab).
 * Fixes: queue was only flushed when user stayed on the same tab.
 */
async function sendNow({
  text,
  images,
  files,
  sessionId = null,
  generation = null,
  displayText: displayOverride = null,
  skipCall = false,
}) {
  if (!skipCall && !images?.length && !files?.length) {
    const call = parseCallSession(text);
    if (call?.sessionId && (call.bare || call.sessionId !== (sessionId || activeId))) {
      if (call.bare) {
        await selectSession(call.sessionId);
        return;
      }
      await dispatchCallSession(call.sessionId, call.text);
      return;
    }
  }
  const sentTo = sessionId || activeId;
  if (!sentTo) return;
  const isActive = sentTo === activeId;
  if (!liveAgents.has(sentTo)) {
    await ensureSessionConnected(sentTo);
  }
  const st = ensureSessionUi(sentTo);
  const myGen = generation != null ? generation : nextSendGeneration(sentTo);

  if (isActive && generation == null) {
    // 非打断路径：在这里清输入；打断路径已在 send() 清过
    ui.input.value = "";
    pendingImages = [];
    pendingFiles = [];
    renderAttachPreview();
    renderContextChips();
    autosize();
  }

  // Keep all writes bound to the target session even if focus changes while
  // image reads or the prompt request are awaiting.
  const context = sessionRenderContext(sentTo);
  const pane = context.pane;
  dispatchSessionEvent(sentTo, { type: "turn.start", detail: "发送中" });
  const displayText =
    (displayOverride != null && String(displayOverride).trim() !== ""
      ? String(displayOverride).trim()
      : text) || (images?.length ? `（${images.length} 张图片）` : "");
  const userImages = [];
  const seenImgKeys = new Set();
  const pushUserImage = (img, fallbackKey) => {
    if (!img?.dataUrl) return false;
    const key = img.path || img.name || img.key || fallbackKey || img.dataUrl;
    if (seenImgKeys.has(key) || seenImgKeys.has(img.dataUrl)) return true;
    seenImgKeys.add(key);
    seenImgKeys.add(img.dataUrl);
    userImages.push({ dataUrl: img.dataUrl, key });
    rememberUserMedia(img);
    rememberUserMedia({ dataUrl: img.dataUrl, key, path: img.path, name: img.name });
    return true;
  };
  for (const img of images || []) {
    if (img?.dataUrl) {
      pushUserImage(img);
      continue;
    }
    const p = img?.path || "";
    if (p) {
      try {
        const loaded = await grokDesktop.readImage?.(p);
        if (loaded?.dataUrl) {
          pushUserImage(loaded, p);
          rememberUserMedia(img);
          continue;
        }
      } catch { /* gone */ }
    }
    rememberUserMedia(img);
  }
  const fileChips = [];
  for (const f of files || []) {
    const filePath = f.path || f.name || "";
    const name = f.name || fileBasename(f.path);
    if (looksLikeImageFile(f) || looksLikeImageFile({ path: filePath, name })) {
      const already = seenImgKeys.has(filePath) || seenImgKeys.has(name);
      if (!already && filePath) {
        try {
          const loaded = await grokDesktop.readImage?.(filePath);
          if (loaded?.dataUrl) {
            pushUserImage(loaded, filePath);
            continue;
          }
        } catch { /* gone */ }
      }
      if (already) continue;
    }
    fileChips.push({ path: filePath, name });
  }
  if (displayText || userImages.length || fileChips.length) {
    appendTurn("user", displayText || "", {
      clampable: false,
      images: userImages,
      files: fileChips,
      pane,
      sessionId: sentTo,
    });
    st.stopped = false;
    persistSessionUi(sentTo, {
      stopped: false,
      lastUser: displayText || "",
      draft: "",
    });
  }

  // Auto-title only for focused session
  if (isActive && text && looksLikeAutoTitle(activeMeta?.title)) {
    const short = titleFromUserText(text);
    if (short) {
      try {
        await grokDesktop.renameSession(sentTo, short);
        applyHeader({ ...activeMeta, title: short, id: sentTo });
        sessions = sessions.map((x) =>
          x.id === sentTo ? { ...x, title: short, summary: short } : x,
        );
        renderSidebar(ui.search.value);
      } catch {
        /* ignore */
      }
    }
  }

  const promptText = buildPromptWithFiles(text, files);
  finishThoughtClock(sentTo);
  st.streamingEl = null;
  st.assistantBody = null;

  // Track Goal / Loop from what the user actually sent; keep mode bar in sync
  const slashHead = String(text || "")
    .trim()
    .match(/^\/(goal|loop|plan)\b([\s\S]*)/i);
  if (slashHead) {
    const cmd = slashHead[1].toLowerCase();
    noteAutomationFromSlash(cmd, (slashHead[2] || "").trim());
    if (isActive && (cmd === "goal" || cmd === "plan")) paintComposerMode(cmd);
    if (cmd === "plan") planModePending = false;
    if (cmd === "goal" && !/^(status|pause|resume|clear)$/i.test((slashHead[2] || "").trim())) {
      /* objective set — stay in goal mode */
    }
  }

  if (/^\/(usage|usages|cost)\b/i.test(String(text || "").trim()) && !(images && images.length) && !(files && files.length)) {
    try {
      const u = await grokDesktop.accountUsage();
      paintAccountUsage(u);
      appendUsageCard(u);
    } catch {
      /* still send /usage to the agent */
    }
  }

  // 仍有旧轮在飞且非引导路径：改排队，等用户点「引导」
  if (promptInFlight.has(sentTo) && generation == null) {
    if (isActive) enqueueFollowUp({ text, images, files });
    return;
  }

  promptInFlight.add(sentTo);
  workingSessions.add(sentTo);
  beginTurnFileWatch(sentTo);
  const compactNow = /^\/compact\b/i.test(String(text || "").trim());
  resetSubagents(sentTo);
  markRunStart(sentTo, compactNow ? { compact: true } : {});
  everWorkedSessions.add(sentTo);
  doneSessions.delete(sentTo);
  refreshSidebarSessionState();
  syncBusyChrome();
  if (isActive) {
    setBusy(true);
    setStatus("working", "思考中…");
    refreshWorkingStatusClock();
    refreshSendButtonState();
    updateLiveStrip();
    threadFollowBottom = true;
    scrollThreadToBottom({ force: true });
  }
  const stSend = ensureSessionUi(sentTo);
  stSend.pendingTurnTokens = 0;
  stSend.turnTokenBase = stSend.lastTotalTokens;
  let promptFailure = "";
  try {
    const slash = String(text || "").trim().match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
    if (slash && !(images && images.length) && !(files && files.length)) {
      const handled = await dispatchBuiltinSlash(slash[1], (slash[2] || "").trim(), sentTo, { echo: false });
      if (handled) {
        /* already applied — do not send to the model as a task */
      } else if (/^(goal|plan|loop|compact)$/i.test(slash[1]) && typeof grokDesktop.runSlash === "function") {
        if (/^compact$/i.test(slash[1])) markCompacting(sentTo);
        await grokDesktop.runSlash(slash[1].toLowerCase(), (slash[2] || "").trim() || undefined, sentTo);
      } else {
        await grokDesktop.prompt({
          text: promptText,
          images: (images || []).map((i) => ({ mimeType: i.mimeType, dataBase64: i.dataBase64 })),
          sessionId: sentTo,
        });
      }
    } else {
      await grokDesktop.prompt({
        text: promptText,
        images: (images || []).map((i) => ({ mimeType: i.mimeType, dataBase64: i.dataBase64 })),
        sessionId: sentTo,
      });
    }
    if (myGen !== currentSendGeneration(sentTo)) return;
    if (activeId === sentTo) setStatus("ready", "就绪");
    refreshSidebarSessionState();
    void refreshSessions()
      .then(() => {
        // 不要 markActive：会清掉刚打上的「已完成」绿点
        refreshSidebarSessionState();
      })
      .catch(() => {});
  } catch (err) {
    if (myGen !== currentSendGeneration(sentTo)) return; // 已被新一轮打断，忽略
    const msg = formatSendError(err);
    refreshSidebarSessionState();
    // cancel 导致的中止不算失败
    if (/cancel|abort|中断|停止|disposed/i.test(msg)) {
      /* ignore */
    } else if (/仍在处理|上一轮|busy|处理中/i.test(msg)) {
      if (isActive) enqueueFollowUp({ text, images, files });
    } else {
      promptFailure = msg || "发送失败";
      dispatchSessionEvent(sentTo, { type: "status", state: "error", detail: promptFailure });
      if (activeId === sentTo) setStatus("error", promptFailure);
      appendBanner(`发送失败：${promptFailure}`, "error", pane, activeId === sentTo);
    }
  } finally {
    if (myGen === currentSendGeneration(sentTo)) {
      // The prompt promise can settle before the last animation-frame paint.
      // Flush synchronously while promptInFlight still marks this turn active,
      // otherwise the final thought line can remain stranded in chunkBuf.
      flushSessionStream(sentTo, { finish: true });
      promptInFlight.delete(sentTo);
      workingSessions.delete(sentTo);
      markRunEnd(sentTo);
      dispatchSessionEvent(sentTo, {
        type: "run.finish",
        state: promptFailure ? "error" : "ready",
        detail: promptFailure || st.statusDetail || "",
      });
      settleToolCards(sentTo, {
        state: promptFailure ? "error" : "ready",
        detail: st.statusDetail || "",
      });
      // 跑完打绿点；点开该会话时再清
      doneSessions.add(sentTo);
      everWorkedSessions.delete(sentTo);
      if (activeId === sentTo) {
        setBusy(false);
        if (!promptFailure) {
          st.statusState = "ready";
          st.statusDetail = completedRunStatusDetail(sentTo);
        }
        setStatus(st.statusState, st.statusDetail);
        updateLiveStrip();
        if (activeMeta) applyHeader(activeMeta, { soft: true });
      }
      const title =
        sessions.find((x) => x.id === sentTo)?.title ||
        st.meta?.title ||
        sentTo.slice(0, 8);
      await maybeNotifyDone(sentTo, title);
      st.streamingEl = null;
      st.pendingTurnTokens = 0;
      void refreshAccountUsage();
      refreshSendButtonState();
      renderSidebar(ui.search?.value || "");
      syncBusyChrome();
      scheduleTurnFileSummary(sentTo);
      await flushSessionQueue(sentTo);
    }
  }
}

function maybeFlushIdleQueue(sessionId) {
  if (!sessionId || connecting) return;
  if (isAgentBusy(sessionId)) return;
  const st = ensureSessionUi(sessionId);
  if (sessionId === activeId) st.messageQueue = messageQueue.slice();
  if (!(st.messageQueue || []).length) return;
  void flushSessionQueue(sessionId);
}

/** Drain queued follow-ups for a session (works in background tabs). */
async function flushSessionQueue(sessionId) {
  if (!sessionId) return;
  if (promptInFlight.has(sessionId)) return;
  const st = ensureSessionUi(sessionId);
  if (sessionId === activeId) st.messageQueue = messageQueue.slice();
  const q = (st.messageQueue || []).slice();
  if (!q.length) {
    if (sessionId === activeId) {
      rerenderQueuedTurns();
      renderSubagentBar();
      updateLiveStrip();
      refreshSendButtonState();
    }
    return;
  }
  const item = q.shift();
  st.messageQueue = q;
  if (sessionId === activeId) {
    messageQueue = q.slice();
    rerenderQueuedTurns();
    renderSubagentBar();
    updateLiveStrip();
    refreshSendButtonState();
  }
  const text = item?.text || "";
  const images = (item?.images || []).slice();
  const files = (item?.files || []).slice();
  if (!text && !images.length && !files.length) {
    await flushSessionQueue(sessionId);
    return;
  }
  await sendNow({
    text,
    images,
    files,
    sessionId,
    displayText: item.displayText != null ? item.displayText : text,
  });
}

async function renameSessionUi(sessionId, currentTitle) {
  if (!sessionId) return false;
  const title = await askText({
    title: "重命名会话",
    message: "给这个会话起一个好认的名字。",
    defaultValue: currentTitle || "",
    placeholder: "例如：桌面端 UI 优化",
    okLabel: "保存",
  });
  if (!title) return false;
  try {
    const s = await grokDesktop.renameSession(sessionId, title);
    // Update local session list immediately
    sessions = sessions.map((x) =>
      x.id === sessionId ? { ...x, title, summary: title, updatedAt: s?.updatedAt || x.updatedAt } : x,
    );
    const st = ensureSessionUi(sessionId);
    if (st) st.meta = { ...(st.meta || {}), title, id: sessionId };
    if (sessionId === activeId) {
      applyHeader({ ...activeMeta, ...s, title, id: sessionId });
    }
    renderSidebar(ui.search.value);
    markActive(activeId);
    return true;
  } catch (err) {
    alert(err.message || err);
    return false;
  }
}

ui.rename.onclick = async () => {
  if (!activeId) return;
  await renameSessionUi(activeId, activeMeta?.title || "");
};

ui.del.onclick = async () => {
  if (!activeId) return;
  const ok = await askConfirm({
    title: "删除会话",
    message: "永久删除此会话？此操作不可恢复。",
    okLabel: "删除",
    danger: true,
  });
  if (!ok) return;
  await deleteSessionUi(activeId);
};

// streams — batched per frame so long chats don't reflow on every token
grokDesktop.onChunk((payload) => {
  enqueueStreamChunk(payload);
});
function pickSubagentText(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

function resetSubagents(sid) {
  const st = sid ? sessionUi.get(sid) : null;
  if (!st) return;
  if (st.subagentEls) {
    for (const el of st.subagentEls.values()) {
      try { el.remove(); } catch { /* ignore */ }
    }
  }
  st.subagents = new Map();
  st.subagentEls = new Map();
  st.subagentSeq = 0;
  st.subagentAlias = new Map();
  if (sid === activeId) paintSubagentTurns(sid);
}

function subagentUniqueIds(payload, opts = {}) {
  const u = payload?.update && typeof payload.update === "object" ? payload.update : payload || {};
  const keys = [
    payload?.childSessionId,
    u.childSessionId,
    u.subagentId,
    u.agentId,
    u.taskId,
  ];
  if (opts.allowToolId) keys.push(payload?.toolCallId, u.toolCallId);
  const out = [];
  for (const v of keys) {
    const s = pickSubagentText(v);
    if (s && !out.includes(s) && !/^(sa|subagent|task|agent)$/i.test(s)) out.push(s);
  }
  return out;
}

function resolveSubagentId(st, payload, preferNew) {
  if (!st.subagents) st.subagents = new Map();
  if (!st.subagentAlias) st.subagentAlias = new Map();
  const ids = subagentUniqueIds(payload, { allowToolId: !!preferNew });
  for (const id of ids) {
    if (st.subagents.has(id)) return id;
    if (st.subagentAlias.has(id)) return st.subagentAlias.get(id);
  }
  if (payload?.childSessionId) {
    const unbound = [...st.subagents.values()].find((x) => x.status === "running" && x.fromTool && !x.childSessionId);
    if (unbound) {
      unbound.childSessionId = String(payload.childSessionId);
      st.subagentAlias.set(unbound.childSessionId, unbound.id);
      return unbound.id;
    }
  }
  if (ids[0]) return ids[0];
  if (!preferNew) return "";
  st.subagentSeq = (st.subagentSeq || 0) + 1;
  return "sa-" + st.subagentSeq;
}

function looksLikeSubagentSpawn(title, kind) {
  const s = `${title || ""} ${kind || ""}`;
  if (/kill\s*task|permission|grep|read_file|write_file|str_replace|bash|shell/i.test(s) && !/subagent|spawn|delegate/i.test(s)) {
    return false;
  }
  return /subagent|spawn(?:_agent)?|delegate|child.?agent|task_backgrounded|taskBackgrounded/i.test(s);
}

function normalizeSubagent(payload, sid) {
  const st = sid ? ensureSessionUi(sid) : { subagents: new Map(), subagentAlias: new Map(), subagentSeq: 0 };
  const u = payload?.update && typeof payload.update === "object" ? payload.update : payload || {};
  const id = resolveSubagentId(st, payload, false);
  if (!id) return null;
  const kind = String(u.sessionUpdate || u.type || payload?.kind || "");
  let status = String(u.status || "").toLowerCase();
  if (/finish|complete|done|exit/i.test(kind)) status = "completed";
  else if (/fail|error/i.test(kind)) status = "failed";
  else if (/spawn|start|running|progress/i.test(kind)) status = status || "running";
  if (!status) status = "running";
  const name = pickSubagentText(
    u.title,
    u.name,
    u.label,
    u.description,
    u.task,
    payload?.title,
  );
  let activity = pickSubagentText(
    u.activity,
    u.currentTool,
    u.tool,
    u.rawInput?.command,
    u.rawInput?.description,
  );
  const childUpdate = payload?.update;
  if (!activity && childUpdate && typeof childUpdate === "object") {
    activity = pickSubagentText(
      childUpdate.title,
      childUpdate.content?.text,
      childUpdate.text,
      childUpdate.kind,
    );
  }
  return {
    id: String(id),
    name,
    status,
    activity: String(activity || "").replace(/\s+/g, " ").trim().slice(0, 240),
    childSessionId: payload?.childSessionId || u.childSessionId || "",
    toolCallId: payload?.toolCallId || u.toolCallId || "",
  };
}

function settleSubagents(sid) {
  const st = sid ? sessionUi.get(sid) : null;
  if (!st?.subagents?.size) {
    if (sid === activeId) renderSubagentBar();
    return;
  }
  for (const item of st.subagents.values()) {
    if (item.status === "running") item.status = "completed";
  }
  if (sid === activeId) renderSubagentBar();
}

function upsertSubagent(sid, info) {
  if (!sid || !info?.id) return;
  const st = ensureSessionUi(sid);
  if (!st.subagents) st.subagents = new Map();
  if (!st.subagentAlias) st.subagentAlias = new Map();
  const prev = st.subagents.get(info.id) || {};
  const isNew = !st.subagents.has(info.id);
  const index = prev.index || (isNew
    ? (Math.max(0, ...[...st.subagents.values()].map((x) => x.index || 0)) + 1)
    : 1);
  const log = Array.isArray(prev.log) ? prev.log.slice() : [];
  if (info.logEntry) {
    const last = log[log.length - 1];
    const bit = String(info.logEntry.text || "");
    if ((info.logEntry.kind === "text" || info.logEntry.kind === "thought") && last?.kind === info.logEntry.kind) {
      last.text += bit;
    } else if (bit && !(last && last.kind === info.logEntry.kind && last.text === bit)) {
      log.push(info.logEntry);
    }
    if (log.length > 200) log.splice(0, log.length - 200);
  }
  const next = {
    id: info.id,
    index,
    name: info.name || prev.name || ("子代理 " + index),
    status: info.status || prev.status || "running",
    activity: info.activity || prev.activity || "",
    log,
    open: prev.open !== undefined ? prev.open : true,
    fromTool: !!(info.fromTool || prev.fromTool),
    childSessionId: info.childSessionId || prev.childSessionId || "",
    toolCallId: info.toolCallId || prev.toolCallId || "",
    updatedAt: Date.now(),
  };
  st.subagents.set(info.id, next);
  if (next.childSessionId) st.subagentAlias.set(next.childSessionId, info.id);
  if (next.toolCallId) st.subagentAlias.set(next.toolCallId, info.id);
  if (sid === activeId) scheduleSubagentPaint(sid);
}

function noteSubagentFromTool(sid, payload) {
  const title = String(payload?.title || payload?.kind || "");
  const kind = String(payload?.kind || "");
  if (!looksLikeSubagentSpawn(title, kind)) return;
  const st = ensureSessionUi(sid);
  const id = resolveSubagentId(st, payload, true);
  const status = String(payload.status || "running").toLowerCase();
  const activity = String(
    payload.rawInput?.description ||
    payload.rawInput?.prompt ||
    payload.rawInput?.task ||
    payload.rawInput?.command ||
    title,
  ).replace(/\s+/g, " ").trim().slice(0, 240);
  upsertSubagent(sid, {
    id: String(id),
    name: title || "",
    status: /complete|fail|error|cancel/i.test(status) ? (/fail|error/i.test(status) ? "failed" : "completed") : "running",
    activity,
    fromTool: true,
    toolCallId: payload.toolCallId || "",
    logEntry: activity ? { kind: "tool", text: activity, status } : null,
  });
}

function shortSubagentName(item) {
  const raw = String(item?.name || "子代理").replace(/\s+/g, " ").trim();
  if (/Goal Plan Writer/i.test(raw)) return "写计划";
  if (/You are the /i.test(raw)) return "子代理";
  if (/^[0-9a-f-]{8,}$/i.test(raw)) return "子代理 " + raw.slice(0, 8);
  return raw.length > 18 ? raw.slice(0, 16) + "…" : raw || "子代理";
}

function shortSubagentActivity(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (/Goal Plan Writer/i.test(s) || /You are the /i.test(s)) return "正在写计划";
  return s.length > 64 ? s.slice(0, 64) + "…" : s;
}

function paintSubagentTurns(sid) {
  const id = sid || activeId;
  const st = id ? ensureSessionUi(id) : null;
  if (!st) return;
  if (!st.subagentEls) st.subagentEls = new Map();
  for (const [k, item] of [...(st.subagents || [])]) {
    const blob = `${item.name || ""} ${item.activity || ""}`;
    if (/\b(grep|permission|kill task|read_file|write_file)\b/i.test(blob) && !/subagent|spawn/i.test(blob)) {
      st.subagents.delete(k);
      st.subagentEls.delete(item.id);
    }
  }
  const pane = typeof getPane === "function" ? getPane(id) : ui.inner;
  pane?.querySelectorAll(".subagent-turn").forEach((el) => {
    try { el.remove(); } catch { /* ignore */ }
  });

  const items = [...(st.subagents?.values() || [])].sort((a, b) => (a.index || 0) - (b.index || 0));
  const total = items.length;
  const running = items.filter((x) => x.status === "running").length;
  const badge = $("subagent-badge");
  const toggle = ui.subagentToggle || $("btn-subagent-toggle");
  const progress = $("subagent-progress");
  if (badge) {
    badge.textContent = String(total);
    badge.classList.toggle("hidden", total <= 0);
    badge.classList.toggle("done", total > 0 && running === 0);
  }
  toggle?.classList.toggle("has-sa", total > 0);
  toggle?.classList.toggle("has-run", running > 0);
  if (progress) {
    if (!total) {
      progress.textContent = "";
      progress.classList.add("hidden");
    } else {
      progress.textContent = running ? `${running}/${total}` : `${total}/${total}`;
      progress.classList.remove("hidden");
    }
  }

  if (id !== activeId) return;
  const list = ui.subagentList || $("subagent-list");
  if (!list) return;
  if (!total) {
    const empty = typeof t === "function" ? t("chat.subagentEmpty") : "还没有子代理。助手开了子代理会出现在这里。";
    list.innerHTML = `<div class="plan-empty">${empty}</div>`;
    st.subagentEls = new Map();
    return;
  }
  if (!st.subagentPanelSeen) {
    st.subagentPanelSeen = true;
    setSubagentOpen(true);
  }
  list.replaceChildren();
  st.subagentEls = new Map();
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "sa-card";
    el.dataset.subagentId = item.id;
    el.classList.toggle("is-running", item.status === "running");
    el.classList.toggle("is-open", item.open !== false);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "sa-head";
    const stEl = document.createElement("span");
    stEl.className = "sa-st";
    stEl.textContent = item.status === "completed" ? "完成" : item.status === "failed" ? "失败" : "进行中";
    const name = document.createElement("span");
    name.className = "sa-name";
    name.textContent = "子代理 " + (item.index || 1) + " / " + total;
    const act = document.createElement("span");
    act.className = "sa-act";
    act.textContent = shortSubagentActivity(item.activity) || shortSubagentName(item);
    const chev = document.createElement("span");
    chev.className = "t-chev";
    chev.textContent = "▾";
    row.append(stEl, name, act, chev);
    row.onclick = (e) => {
      e.stopPropagation();
      const rec = ensureSessionUi(id).subagents?.get(item.id);
      if (!rec) return;
      rec.open = rec.open === false;
      paintSubagentTurns(id);
    };
    el.appendChild(row);
    if (item.open !== false) {
      const log = document.createElement("div");
      log.className = "sa-log";
      const chunks = item.log || [];
      const lines = [];
      for (const e of chunks) {
        const bit = String(e.text || "").replace(/\s+/g, " ").trim();
        if (!bit) continue;
        if (/You are the |Goal Plan Writer/i.test(bit) && bit.length > 80) continue;
        if (e.kind === "tool") lines.push("⚙ " + bit);
        else if (e.kind === "thought") lines.push("… " + bit);
        else lines.push(bit);
      }
      log.textContent = lines.join("\n") || shortSubagentActivity(item.activity) || "已启动，等待工作记录";
      el.appendChild(log);
    }
    list.appendChild(el);
    st.subagentEls.set(item.id, el);
  }
}

let subagentPaintTimer = 0;
function scheduleSubagentPaint(sid) {
  const id = sid || activeId;
  clearTimeout(subagentPaintTimer);
  subagentPaintTimer = setTimeout(() => paintSubagentTurns(id), 40);
}

function renderSubagentBar() {
  const bar = ui.subagentBar || $("subagent-bar");
  if (bar) {
    bar.replaceChildren();
    bar.classList.add("hidden");
    bar.hidden = true;
  }
  if (activeId) scheduleSubagentPaint(activeId);
}

grokDesktop.onSubagent?.((payload) => {
  const sid = payload?.sessionId || activeId;
  if (!sid) return;
  try {
    if (payload?.compact || looksLikeCompact(payload?.kind) || looksLikeCompact(payload?.title)) markCompacting(sid);
  } catch {
    /* ignore */
  }
  if (payload?.kind === "child") {
    const child = payload.update || {};
    if (!payload.childSessionId) return;
    const ck = child.sessionUpdate || child.type;
    if (ck === "user_message_chunk" || ck === "user_message") return;
    const st = ensureSessionUi(sid);
    const cid = String(payload.childSessionId);
    const known = !!(
      st.subagents?.has(cid) ||
      st.subagentAlias?.has(cid) ||
      [...(st.subagents?.values() || [])].some((x) => String(x.childSessionId || "") === cid)
    );
    if (!known) return;
    const info = normalizeSubagent(payload, sid);
    if (!info || !info.id) return;
    if (ck === "tool_call" || ck === "tool_call_update") {
      info.activity = pickSubagentText(child.title, child.kind, child.rawInput?.command, child.rawInput?.description) || info.activity;
      info.status = "running";
      const title = info.activity || child.title || "工具";
      info.logEntry = { kind: "tool", text: title, status: String(child.status || "") };
    } else if (ck === "agent_thought_chunk") {
      const text = pickSubagentText(child.content?.text, child.text);
      if (text) {
        info.activity = text.slice(0, 180);
        info.logEntry = { kind: "thought", text };
      }
      info.status = "running";
    } else if (ck === "agent_message_chunk") {
      const text = pickSubagentText(child.content?.text, child.text);
      if (text) {
        info.activity = text.slice(0, 180);
        info.logEntry = { kind: "text", text };
      }
      info.status = "running";
    }
    upsertSubagent(sid, info);
    return;
  }
  const u = payload?.update || payload || {};
  const kind = String(u.sessionUpdate || u.type || u.kind || payload?.kind || "");
  if (!/subagent|task_backgrounded|task_completed|taskBackgrounded|taskCompleted/i.test(kind)) return;
  const info = normalizeSubagent(payload, sid);
  if (info && info.id) upsertSubagent(sid, info);
});

function countFileIndexDelta(delta) {
  if (!delta || typeof delta !== "object") return { addN: 0, delN: 0 };
  const op = String(delta.op || "");
  if (op === "add") {
    return { addN: Array.isArray(delta.entries) ? delta.entries.length : 0, delN: 0 };
  }
  if (op === "remove") {
    return { addN: 0, delN: Array.isArray(delta.paths) ? delta.paths.length : 0 };
  }
  if (op === "batch" && Array.isArray(delta.deltas)) {
    return delta.deltas.reduce((acc, d) => {
      const x = countFileIndexDelta(d);
      return { addN: acc.addN + x.addN, delN: acc.delN + x.delN };
    }, { addN: 0, delN: 0 });
  }
  return { addN: 0, delN: 0 };
}

function summarizeCodebase(payload) {
  const kind = String(payload?.kind || "");
  const en = uiLocale() === "en";
  if (kind === "index") {
    const n = Number(payload.totalFiles ?? (Array.isArray(payload.files) ? payload.files.length : 0)) || 0;
    return { n, label: n ? (en ? `Indexed ${n}` : `已索引 ${n}`) : "" };
  }
  if (kind === "delta") {
    const { addN, delN } = countFileIndexDelta(payload.delta);
    if (!addN && !delN) return { n: 0, label: "" };
    return { n: addN + delN, label: (en ? "Codebase" : "工程") + ` +${addN} −${delN}` };
  }
  if (kind === "notify") {
    const ev = payload.event && typeof payload.event === "object" ? payload.event : {};
    const paths = Array.isArray(ev.paths) ? ev.paths : [];
    const k = String(ev.kind || "");
    let addN = 0;
    let delN = 0;
    if (/^Create$/i.test(k)) addN = paths.length;
    else if (/^Remove$/i.test(k)) delN = paths.length;
    else if (/^Rename$/i.test(k)) {
      delN = paths.length ? 1 : 0;
      addN = paths.length > 1 ? paths.length - 1 : paths.length ? 1 : 0;
    }
    if (addN || delN) return { n: paths.length, label: (en ? "Codebase" : "工程") + ` +${addN} −${delN}` };
    return { n: paths.length, label: en ? "Codebase" : "工程有更新" };
  }
  if (kind === "git-head") {
    return { n: 0, label: en ? "Git" : "Git 已更新" };
  }
  return { n: 0, label: "" };
}

grokDesktop.onCodebase?.((payload) => {
  const sid = payload?.sessionId || activeId;
  if (!sid) return;
  const st = ensureSessionUi(sid);
  const { n, label } = summarizeCodebase(payload || {});
  if (label) st.codebaseLabel = label;
  if (n) st.codebaseCount = n;
  if (sid === activeId) updateLiveStrip();
});

grokDesktop.onTool((payload) => {
  forSession(
    payload || {},
    (sid, st, isActive, context) => {
      if (isActive && connecting && !st.replayOpen && !promptInFlight.has(sid)) return;
      // Flush pending text before tool card so order stays correct.
      flushSessionStream(sid);
      if (payload?.phase === "start") holdThoughtForTools(sid);
      dispatchSessionEvent(sid, {
        type: payload?.phase === "start" ? "tool.start" : "tool.update",
        tool: payload || {},
      });
      const priorReply = currentAssistantBody(st)?.closest?.(".turn");
      if (priorReply && payload?.phase === "start") setAssistantTurnKind(priorReply, "commentary");
      st.streamingEl = null;
      if (payload?.phase === "start") st.assistantBody = null;
      appendToolCard({ ...(payload || { title: "tool" }), sessionId: sid }, context);
      noteSubagentFromTool(sid, payload || {});
    },
    { scroll: true, tabs: true },
  );
});
grokDesktop.onDiff?.((change) => {
  forSession(
    change || {},
    (sid, st, isActive, context) => {
      if (isActive && connecting && !st.replayOpen && !promptInFlight.has(sid)) return;
      st.streamingEl = null;
      appendDiffCard({ ...(change || {}), sessionId: sid }, context);
    },
    { scroll: true },
  );
});
grokDesktop.onMedia((media) => {
  forSession(
    media || {},
    (sid, st, isActive, context) => {
      const userOwned = isUserSentMedia(media);
      // Session hydrate used to drop the CLI echo; user-owned images still belong
      // on the user bubble even while connecting.
      if (isActive && connecting && !userOwned) return;
      if (media?.dataUrl) {
        if (userOwned) rememberUserMedia(media);
        const host = userOwned ? lastUserTurnEl(context.pane) : null;
        appendMedia(media.dataUrl, media.path || media.name || media.dataUrl, {
          turn: host,
          role: userOwned ? "user" : "assistant",
          prefer: userOwned ? "user" : "assistant",
          pane: context.pane,
          sessionId: sid,
        });
      }
    },
    { scroll: true },
  );
});
grokDesktop.onPermission?.((req) => {
  forSession(
    req || {},
    (sid, st, isActive, context) => {
      if (isActive && connecting) return;
      st.streamingEl = null;
      appendPermissionCard({ ...(req || {}), sessionId: sid }, context);
    },
    { scroll: true },
  );
});
grokDesktop.onPlan?.((update) => {
  const sid = update?.sessionId || activeId;
  if (!sid) return;
  const st = ensureSessionUi(sid);
  st.plan = update;
  if (isPlanAllDone(update)) {
    clearFinishedGoal(sid, { paint: sid === activeId });
    return;
  }
  if (sid === activeId) {
    renderPlan(update);
    renderWorkCard();
  }
});
grokDesktop.onAgents?.((info) => {
  if (Array.isArray(info?.openIds)) {
    liveAgents = new Set(info.openIds);
    // keep tabs that are either live or currently listed
    for (const id of info.openIds) {
      if (!openTabs.includes(id)) openTabs.push(id);
    }
  }
});
grokDesktop.onUsage?.((usage) => {
  const sid = usage?.sessionId || activeId;
  const contextSize = usage?.contextWindowTokens ?? usage?.size;
  const turnProbe = (usage?.inputTokens || 0) + (usage?.outputTokens || 0) + (usage?.reasoningTokens || 0) || usage?.totalTokens;
  const looksLikeTurn = contextSize == null && usage?.used != null && turnProbe && Number(usage.used) === Number(turnProbe);
  const contextUsed = usage?.contextTokensUsed ?? (looksLikeTurn ? null : usage?.used);
  if (contextUsed != null || contextSize != null) {
    applyContextUsage({ used: contextUsed, size: contextSize, estimated: false }, sid);
  } else {
    bumpContextUsage(sid);
  }
  if (!sid) return;
  const st = ensureSessionUi(sid);
  let turnTotal = null;
  if (usage?.inputTokens != null || usage?.outputTokens != null) {
    turnTotal = (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.reasoningTokens || 0);
  } else if (usage?.totalTokens != null) {
    const base = st.turnTokenBase ?? st.lastTotalTokens;
    if (typeof base === "number") turnTotal = Math.max(0, usage.totalTokens - base);
    st.lastTotalTokens = usage.totalTokens;
  }
  if (turnTotal > 0) {
    st.pendingTurnTokens = turnTotal;
    paintTurnCost(sid, {
      total: turnTotal,
      input: usage.inputTokens,
      output: usage.outputTokens,
      reasoning: usage.reasoningTokens,
      cache: usage.cacheReadTokens,
      promptTokens: usage.used || usage.inputTokens,
      modelId: usage.modelId || usage.model || currentModelId,
    });
  }
  clearTimeout(usageRefreshTimer);
  usageRefreshTimer = setTimeout(() => void refreshAccountUsage(), 1000);
});
grokDesktop.onStatus((payload) => {
  const { state, detail, session, sessionId } = payload || {};
  const sid = sessionId || session?.id || null;
  if (sid) {
    const terminal = state === "ready" || state === "error" || state === "disconnected";
    const st = dispatchSessionEvent(sid, {
      type: terminal ? "run.finish" : "status",
      state,
      detail,
    }) || ensureSessionUi(sid);
    if (state === "working") {
      if (st.stopped && !promptInFlight.has(sid)) {
        return;
      }
      workingSessions.add(sid);
      if (payload?.compact) markCompacting(sid);
      else if (!runStartedAt.has(sid)) markRunStart(sid);
      else renderSidebar(ui.search?.value || "");
      everWorkedSessions.add(sid);
      doneSessions.delete(sid);
      syncBusyChrome();
    } else if (state === "ready" || state === "error" || state === "disconnected") {
      // 本轮 prompt 还在 await 时，忽略中途的 ready，避免误判为空闲导致插不进去
      if (!promptInFlight.has(sid)) {
        const wasWorking = workingSessions.has(sid) || everWorkedSessions.has(sid);
        workingSessions.delete(sid);
        if (wasWorking) markRunEnd(sid);
        // 跑完 → 绿点（当前会话也显示，点开/再点一次清）
        if (wasWorking && (state === "ready" || state === "error")) {
          doneSessions.add(sid);
          // 失焦 / 托盘 / 后台 tab → 系统通知（sendPrompt finally 也会通知，这里补 ACP 路径）
          if (state === "ready") {
            const title =
              sessions.find((x) => x.id === sid)?.title ||
              sessionUi.get(sid)?.meta?.title ||
              sid.slice(0, 8);
            void maybeNotifyDone(sid, title);
            scheduleTurnFileSummary(sid);
          }
        }
        if (state === "ready" || state === "error") {
          everWorkedSessions.delete(sid);
        }
        syncBusyChrome();
      }
      if (state === "ready") {
        st.statusDetail = completedRunStatusDetail(sid, detail || st.statusDetail);
      }
      flushSessionStream(sid, { finish: true });
      settleToolCards(sid, { state, detail: detail || st.statusDetail || "" });
      st.streamingEl = null;
    }
    if (session) st.meta = { ...(st.meta || {}), ...session };
    refreshSidebarSessionState();
    if (sid && callMonitors.has(sid) && state === "working" && detail) {
      noteCallActivity(sid, detail);
    }
  }
  // 状态栏：仅当焦点会话，且不要在 promptInFlight 时被 ready 冲掉
  if (!sid || sid === activeId) {
    if (state === "working") {
      if (state) setStatus(state, detail);
      setBusy(true);
      refreshSendButtonState();
    } else if (state === "ready" || state === "error" || state === "disconnected") {
      if (!promptInFlight.has(sid || activeId)) {
        const visibleDetail =
          state === "ready"
            ? completedRunStatusDetail(sid || activeId, detail)
            : detail;
        if (state) setStatus(state, visibleDetail);
        setBusy(false);
        refreshSendButtonState();
      }
    } else if (state) {
      setStatus(state, detail);
    }
  }
  if (session?.id && session.id === activeId) {
    applyHeader({ ...activeMeta, ...session });
    updateLiveStrip();
  }
});

// Plan panel — Bootstrap Offcanvas (toolbar toggle; close via btn / backdrop / Esc)
ui.planToggle?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setPlanOpen(!planOpen);
});
ui.subagentToggle?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setSubagentOpen(!subagentOpen);
});
ui.subagentClose?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setSubagentOpen(false);
});
ui.planClose?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  setPlanOpen(false);
});

// Access mode cards
document.querySelectorAll("#access-mode-cards .mode-card").forEach((card) => {
  card.addEventListener("click", () => {
    setAccessModeUi(card.getAttribute("data-mode"));
  });
});

// Live language switch
$("set-locale")?.addEventListener("change", () => {
  applyLocale($("set-locale").value, { persist: true });
});

// ── Memory ─────────────────────────────────────────────

/** @type {'all'|'note'|'experience'} */
let memFilter = "all";
/** @type {string|null} */
let memSelectedId = null;
/** @type {Array<object>} */
let memEntriesCache = [];

const MEM_CAT_LABELS = {
  frontend: { zh: "前端", en: "Frontend" },
  backend: { zh: "后端", en: "Backend" },
  api: { zh: "接口", en: "API" },
  desktop: { zh: "桌面", en: "Desktop" },
  build: { zh: "打包/构建", en: "Build" },
  ops: { zh: "运维", en: "Ops" },
  other: { zh: "其他", en: "Other" },
};

function memCatLabel(cat) {
  const loc = desktopSettings.locale === "en" ? "en" : "zh";
  return MEM_CAT_LABELS[cat]?.[loc] || cat || MEM_CAT_LABELS.other[loc];
}

function experienceMemoryOn() {
  return desktopSettings.experienceMemory !== false;
}

function showMemEmptyDetail() {
  if (!ui.memoryDetail) return;
  ui.memoryDetail.innerHTML = `
    <div class="welcome-mini">
      <h2>${t("page.memory.emptyTitle")}</h2>
      <p>${t("page.memory.emptyBody")}</p>
      <ul>
        <li>${t("page.memory.tipGlobal")}</li>
        <li>${t("page.memory.tipProject")}</li>
      </ul>
    </div>`;
}

async function loadMemory() {
  if (!ui.memoryList) return;
  ui.memoryList.innerHTML = `<div class="list-empty">${t("page.memory.loading")}</div>`;
  try {
    // sync toggles
    try {
      const data = await grokDesktop.listMemory();
      if (ui.memoryEnabled) ui.memoryEnabled.checked = !!data.enabled;
    } catch {
      /* ignore */
    }
    const expEl = $("memory-experience-enabled");
    if (expEl) expEl.checked = experienceMemoryOn();
    const setExp = $("set-experience-memory");
    if (setExp) setExp.checked = experienceMemoryOn();

    const res = await grokDesktop.listMemoryEntries?.({});
    memEntriesCache = Array.isArray(res?.entries) ? res.entries : [];
    renderMemoryList();
  } catch (err) {
    ui.memoryList.innerHTML = `<div class="list-error">${err.message || err}</div>`;
  }
}

function filteredMemoryEntries() {
  let list = memEntriesCache.slice();
  if (memFilter === "note") list = list.filter((e) => e.type === "note");
  if (memFilter === "experience") list = list.filter((e) => e.type === "experience");
  // When experience switch is off: hide from "all" to reduce noise; "经验" tab still shows for management
  if (!experienceMemoryOn() && memFilter === "all") {
    list = list.filter((e) => e.type !== "experience");
  }
  const cat = $("mem-category-filter")?.value || "";
  if (cat) list = list.filter((e) => e.type !== "experience" || e.category === cat);
  return list;
}

function renderMemoryList() {
  if (!ui.memoryList) return;
  const list = filteredMemoryEntries();
  ui.memoryList.replaceChildren();
  if (!list.length) {
    const enabled = !!ui.memoryEnabled?.checked;
    ui.memoryList.innerHTML = `<div class="list-empty">${
      !enabled
        ? t("page.memory.emptyDisabled")
        : memFilter === "experience" && !experienceMemoryOn()
          ? t("page.memory.emptyExpOff")
          : t("page.memory.emptyList")
    }</div>`;
    if (!memSelectedId || !memEntriesCache.some((e) => e.id === memSelectedId)) {
      showMemEmptyDetail();
    }
    return;
  }
  for (const e of list) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card mem-card" + (e.id === memSelectedId ? " active" : "");
    card.dataset.id = e.id;
    const preview = String(e.body || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 96);
    card.innerHTML = `<h3></h3><p></p><div class="meta"><span class="badge"></span><span class="mem-cat"></span><span class="mem-time"></span></div>`;
    card.querySelector("h3").textContent = e.title || preview.slice(0, 32) || "—";
    card.querySelector("p").textContent = preview || "—";
    const badge = card.querySelector(".badge");
    badge.textContent = e.type === "experience" ? t("page.memory.badgeExp") : t("page.memory.badgeNote");
    badge.classList.add(e.type === "experience" ? "badge-exp" : "badge-note");
    const catEl = card.querySelector(".mem-cat");
    if (e.type === "experience" && e.category) {
      catEl.textContent = memCatLabel(e.category);
    } else {
      catEl.remove();
    }
    card.querySelector(".mem-time").textContent = relativeTime(e.updatedAt);
    card.onclick = () => {
      memSelectedId = e.id;
      ui.memoryList.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
      card.classList.add("active");
      showMemoryEntry(e);
    };
    ui.memoryList.appendChild(card);
  }
  if (memSelectedId) {
    const still = list.find((x) => x.id === memSelectedId) || memEntriesCache.find((x) => x.id === memSelectedId);
    const editing = ui.memoryDetail?.querySelector("#mem-body");
    if (still && !editing) showMemoryEntry(still);
    else if (!still) {
      memSelectedId = null;
      showMemEmptyDetail();
    }
  }
}

function showMemoryEntry(entry) {
  if (!ui.memoryDetail || !entry) return;
  const isExp = entry.type === "experience";
  ui.memoryDetail.innerHTML = `
    <div class="mem-detail-head">
      <div class="mem-detail-badges">
        <span class="badge ${isExp ? "badge-exp" : "badge-note"}"></span>
        ${isExp ? '<span class="mem-cat-pill" id="mem-cat-pill"></span>' : ""}
      </div>
      <p class="page-desc mem-detail-hint"></p>
    </div>
    <label class="mem-field">
      <span data-i18n-skip>${t("page.memory.fieldTitle")}</span>
      <input type="text" id="mem-title" class="mem-input" />
    </label>
    ${
      isExp
        ? `<label class="mem-field">
      <span>${t("page.memory.fieldCategory")}</span>
      <select id="mem-category" class="mem-select mem-input">
        <option value="frontend">${memCatLabel("frontend")}</option>
        <option value="backend">${memCatLabel("backend")}</option>
        <option value="api">${memCatLabel("api")}</option>
        <option value="desktop">${memCatLabel("desktop")}</option>
        <option value="build">${memCatLabel("build")}</option>
        <option value="ops">${memCatLabel("ops")}</option>
        <option value="other">${memCatLabel("other")}</option>
      </select>
    </label>`
        : ""
    }
    <label class="mem-field mem-field-body">
      <span>${t("page.memory.fieldBody")}</span>
      <textarea class="editor mem-editor" id="mem-editor"></textarea>
    </label>
    <div class="actions mem-detail-actions">
      <button type="button" class="btn primary" id="mem-save">${t("page.memory.save")}</button>
      <button type="button" class="btn danger" id="mem-delete">${t("page.memory.delete")}</button>
    </div>
    <p class="mem-meta-line" id="mem-meta-line"></p>`;

  ui.memoryDetail.querySelector(".badge").textContent = isExp
    ? t("page.memory.badgeExp")
    : t("page.memory.badgeNote");
  ui.memoryDetail.querySelector(".mem-detail-hint").textContent = isExp
    ? t("page.memory.hintExp")
    : t("page.memory.hintNote");
  const titleEl = ui.memoryDetail.querySelector("#mem-title");
  const editor = ui.memoryDetail.querySelector("#mem-editor");
  titleEl.value = entry.title || "";
  editor.value = entry.body || "";
  if (isExp) {
    const cat = ui.memoryDetail.querySelector("#mem-category");
    if (cat) cat.value = entry.category || "other";
    const pill = ui.memoryDetail.querySelector("#mem-cat-pill");
    if (pill) pill.textContent = memCatLabel(entry.category || "other");
  }
  const meta = ui.memoryDetail.querySelector("#mem-meta-line");
  if (meta) {
    meta.textContent = `${t("page.memory.updated")}: ${relativeTime(entry.updatedAt)}`;
  }

  ui.memoryDetail.querySelector("#mem-save").onclick = async () => {
    try {
      const payload = {
        id: entry.id,
        type: entry.type,
        title: titleEl.value.trim(),
        body: editor.value,
        category: isExp ? ui.memoryDetail.querySelector("#mem-category")?.value : null,
      };
      const r = await grokDesktop.upsertMemoryEntry(payload);
      memSelectedId = r.entry?.id || entry.id;
      flashToast(t("page.memory.saved"));
      await loadMemory();
    } catch (err) {
      alert(err.message || err);
    }
  };
  ui.memoryDetail.querySelector("#mem-delete").onclick = async () => {
    if (!confirm(t("page.memory.deleteConfirm"))) return;
    try {
      await grokDesktop.deleteMemoryEntry(entry.id);
      memSelectedId = null;
      flashToast(t("page.memory.deleted"));
      await loadMemory();
      showMemEmptyDetail();
    } catch (err) {
      alert(err.message || err);
    }
  };
}

async function ensureMemoryEnabled() {
  if (!ui.memoryEnabled?.checked) {
    await grokDesktop.setMemoryEnabled(true);
    if (ui.memoryEnabled) ui.memoryEnabled.checked = true;
    const s = $("set-memory");
    if (s) s.checked = true;
  }
}

async function addMemoryEntry(type) {
  const isExp = type === "experience";
  if (isExp && !experienceMemoryOn()) {
    const on = confirm(t("page.memory.expOffPrompt"));
    if (!on) return;
    desktopSettings.experienceMemory = true;
    try {
      await grokDesktop.saveDesktopSettings({ experienceMemory: true });
    } catch {
      /* ignore */
    }
    const expEl = $("memory-experience-enabled");
    if (expEl) expEl.checked = true;
    const setExp = $("set-experience-memory");
    if (setExp) setExp.checked = true;
  }
  const body = await askText({
    title: isExp ? t("page.memory.addExpTitle") : t("page.memory.addNoteTitle"),
    message: isExp ? t("page.memory.addExpMsg") : t("page.memory.addNoteMsg"),
    placeholder: isExp ? t("page.memory.addExpPh") : t("page.memory.addNotePh"),
    okLabel: t("page.memory.write"),
  });
  if (!body?.trim()) return;
  let category = "other";
  let title = body.trim().slice(0, 48);
  if (isExp) {
    const catPick = await askText({
      title: t("page.memory.fieldCategory"),
      message: t("page.memory.catPickMsg"),
      placeholder: "frontend / backend / api / desktop / build / ops / other",
      okLabel: t("page.memory.write"),
      defaultValue: "desktop",
    });
    if (catPick?.trim()) category = catPick.trim().toLowerCase();
  }
  try {
    await ensureMemoryEnabled();
    const r = await grokDesktop.upsertMemoryEntry({
      type: isExp ? "experience" : "note",
      title,
      body: body.trim(),
      category: isExp ? category : null,
    });
    memSelectedId = r.entry?.id || null;
    if (isExp) memFilter = "experience";
    else memFilter = "note";
    document.querySelectorAll(".mem-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-mem-filter") === memFilter);
    });
    await loadMemory();
    flashToast(t("page.memory.saved"));
  } catch (err) {
    alert(err.message || err);
  }
}

ui.memoryEnabled?.addEventListener("change", async () => {
  try {
    await grokDesktop.setMemoryEnabled(ui.memoryEnabled.checked);
    const s = $("set-memory");
    if (s) s.checked = ui.memoryEnabled.checked;
    await loadMemory();
  } catch (err) {
    alert(err.message || err);
    ui.memoryEnabled.checked = !ui.memoryEnabled.checked;
  }
});

$("memory-experience-enabled")?.addEventListener("change", async () => {
  const on = !!$("memory-experience-enabled").checked;
  desktopSettings.experienceMemory = on;
  try {
    await grokDesktop.saveDesktopSettings({ experienceMemory: on });
    const s = $("set-experience-memory");
    if (s) s.checked = on;
    await loadMemory();
  } catch (err) {
    alert(err.message || err);
    $("memory-experience-enabled").checked = !on;
  }
});

$("set-experience-memory")?.addEventListener("change", async () => {
  const on = !!$("set-experience-memory").checked;
  desktopSettings.experienceMemory = on;
  try {
    await grokDesktop.saveDesktopSettings({ experienceMemory: on });
    const s = $("memory-experience-enabled");
    if (s) s.checked = on;
    if (view === "memory") await loadMemory();
  } catch (err) {
    alert(err.message || err);
    $("set-experience-memory").checked = !on;
  }
});

document.querySelectorAll(".mem-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    memFilter = btn.getAttribute("data-mem-filter") || "all";
    document.querySelectorAll(".mem-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderMemoryList();
  });
});
$("mem-category-filter")?.addEventListener("change", () => renderMemoryList());
$("btn-memory-refresh")?.addEventListener("click", () => loadMemory());
$("btn-memory-add")?.addEventListener("click", () => void addMemoryEntry("note"));
$("btn-memory-add-exp")?.addEventListener("click", () => void addMemoryEntry("experience"));

// ── Skills ─────────────────────────────────────────────

async function loadSkills() {
  ui.skillsList.innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const list = await grokDesktop.listSkills({ cwd: activeMeta?.cwd || lastUsedCwd || undefined });
    ui.skillsList.replaceChildren();
    if (!list.length) {
      ui.skillsList.innerHTML = '<div class="list-empty">未发现 Skill</div>';
      return;
    }
    for (const s of list) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.innerHTML = `<h3></h3><p></p><div class="meta"><span class="badge"></span></div>`;
      card.querySelector("h3").textContent = s.name;
      card.querySelector("p").textContent = s.description || "";
      card.querySelector(".badge").textContent = s.scope;
      card.onclick = () => {
        ui.skillsList.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        void showSkill(s.name);
      };
      ui.skillsList.appendChild(card);
    }
  } catch (err) {
    ui.skillsList.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

async function showSkill(name) {
  ui.skillDetail.innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const s = await grokDesktop.readSkill(name);
    if (!s) {
      ui.skillDetail.innerHTML = '<div class="list-error">未找到</div>';
      return;
    }
    ui.skillDetail.innerHTML = `
      <h2></h2>
      <p class="page-desc"></p>
      <div class="actions">
        <button type="button" class="btn primary" id="skill-run">在当前对话调用</button>
        <button type="button" class="btn" id="skill-save">保存</button>
        <button type="button" class="btn" id="skill-open-dir">打开目录</button>
        <button type="button" class="btn" id="skill-open-file">打开 SKILL.md</button>
      </div>
      <textarea id="skill-md" class="skill-editor" spellcheck="false"></textarea>`;
    ui.skillDetail.querySelector("h2").textContent = s.name;
    ui.skillDetail.querySelector(".page-desc").textContent = `${s.scope || ""} · ${s.description || s.path || ""}`;
    const editor = $("skill-md");
    editor.value = s.markdown || s.body || "";
    $("skill-open-dir").onclick = () => grokDesktop.openSkill(s.path);
    $("skill-open-file").onclick = () => grokDesktop.openSkill(s.skillFile);
    $("skill-save").onclick = async () => {
      try {
        await grokDesktop.writeSkill(s.name, editor.value);
        flashToast("已保存");
      } catch (err) {
        alert(err.message || err);
      }
    };
    $("skill-run").onclick = async () => {
      switchView("chat");
      if (!activeId) {
        appendBanner("请先打开会话，再调用 Skill", "error");
        return;
      }
      await runRealSlash(s.name);
    };
  } catch (err) {
    ui.skillDetail.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

$("btn-skill-refresh")?.addEventListener("click", () => loadSkills());
$("btn-skill-create")?.addEventListener("click", async () => {
  const name = await askText({
    title: "新建 Skill",
    message: "只能用英文、数字和短横线，例如 my-helper（中文名会无效）",
    placeholder: "my-helper",
    okLabel: "下一步",
  });
  if (!name) return;
  const description =
    (await askText({
      title: "Skill 描述",
      message: "一句话说明这个 Skill 做什么（可留空）",
      placeholder: "简短描述",
      okLabel: "创建",
    })) || "";
  try {
    const s = await grokDesktop.createSkill({ name, description });
    await loadSkills();
    if (s?.name) await showSkill(s.name);
  } catch (err) {
    alert(err.message || err);
  }
});

// ── Plugins ────────────────────────────────────────────

async function loadPlugins() {
  ui.pluginsInstalled.innerHTML = '<div class="list-empty">加载中…</div>';
  try {
    const installed = await grokDesktop.listInstalledPlugins();
    if (installed && !Array.isArray(installed) && installed.error) {
      ui.pluginsInstalled.innerHTML = `<div class="list-error">${installed.error}</div>`;
      return;
    }
    renderPluginCards(ui.pluginsInstalled, Array.isArray(installed) ? installed : installed?.items || [], "installed");
  } catch (err) {
    ui.pluginsInstalled.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

async function loadMarketplace() {
  ui.pluginsMarket.innerHTML = '<div class="list-empty">拉取市场…</div>';
  try {
    const r = await grokDesktop.listAvailablePlugins();
    const items = Array.isArray(r) ? r : r.items || [];
    if (r?.error && !items.length) {
      ui.pluginsMarket.innerHTML = `<div class="list-error">${r.error}</div>`;
      return;
    }
    renderPluginCards(ui.pluginsMarket, items, "market");
  } catch (err) {
    ui.pluginsMarket.innerHTML = `<div class="list-error">${err.message}</div>`;
  }
}

function renderPluginCards(container, items, mode) {
  container.replaceChildren();
  if (!items?.length) {
    container.innerHTML =
      mode === "installed"
        ? '<div class="list-empty">尚未安装插件。可从市场安装，或在上方输入 git URL。</div>'
        : '<div class="list-empty">市场暂无数据</div>';
    return;
  }
  for (const p of items) {
    const card = document.createElement("div");
    card.className = "plugin-row";
    const name = p.name || "plugin";
    const status = p.status || (p.enabled === false ? "disabled" : "installed");
    card.innerHTML = `
      <div class="plugin-top">
        <div class="plugin-name"></div>
        <div class="plugin-meta"><span class="badge"></span><span class="badge scope"></span></div>
        <div class="plugin-actions"></div>
      </div>
      <p class="plugin-desc"></p>`;
    card.querySelector(".plugin-name").textContent = name;
    card.querySelector(".plugin-desc").textContent = p.description || "";
    const badge = card.querySelector(".badge");
    badge.textContent = status;
    badge.classList.add(/disable|available/i.test(status) ? "off" : "on");
    card.querySelector(".scope").textContent = p.marketplace || p.scope || mode;
    const actions = card.querySelector(".plugin-actions");
    if (mode === "market" || status === "available") {
      const btn = document.createElement("button");
      btn.className = "btn ghost plugin-install-btn";
      btn.textContent = "安装";
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "安装中…";
        try {
          await grokDesktop.installPlugin(name);
          await loadPlugins();
          await loadMarketplace();
        } catch (err) {
          alert(err.message || err);
          btn.disabled = false;
          btn.textContent = "安装";
        }
      };
      actions.appendChild(btn);
    } else {
      const en = document.createElement("button");
      en.className = "btn";
      en.textContent = status === "disabled" ? "启用" : "禁用";
      en.onclick = async () => {
        try {
          if (status === "disabled") await grokDesktop.enablePlugin(name);
          else await grokDesktop.disablePlugin(name);
          await loadPlugins();
        } catch (err) {
          alert(err.message || err);
        }
      };
      const un = document.createElement("button");
      un.className = "btn danger";
      un.textContent = "卸载";
      un.onclick = async () => {
        if (!confirm(`卸载 ${name}？`)) return;
        try {
          await grokDesktop.uninstallPlugin(name);
          await loadPlugins();
        } catch (err) {
          alert(err.message || err);
        }
      };
      actions.append(en, un);
    }
    container.appendChild(card);
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const pt = tab.dataset.ptab;
    ui.pluginsInstalled.classList.toggle("hidden", pt !== "installed");
    ui.pluginsMarket.classList.toggle("hidden", pt !== "market");
    if (pt === "market") void loadMarketplace();
  });
});
$("btn-plugin-refresh")?.addEventListener("click", () => {
  void loadPlugins();
  if (!ui.pluginsMarket.classList.contains("hidden")) void loadMarketplace();
});
$("btn-plugin-install")?.addEventListener("click", async () => {
  const spec = ui.pluginSpec.value.trim();
  if (!spec) return;
  const btn = $("btn-plugin-install");
  btn.disabled = true;
  btn.textContent = "安装中…";
  try {
    await grokDesktop.installPlugin(spec);
    ui.pluginSpec.value = "";
    await loadPlugins();
  } catch (err) {
    alert(err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "安装";
  }
});

// ── Settings ───────────────────────────────────────────

function syncProfileAvatarPreview() {
  const img = $("profile-avatar-preview");
  if (!img) return;
  const url = desktopSettings.profileAvatarUrl;
  if (url) {
    img.src = url;
    img.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
  }
}

async function fillSettingsProfile() {
  if ($("set-nickname")) $("set-nickname").value = desktopSettings.profileNickname || "";
  await hydrateProfileAvatar();
  syncProfileAvatarPreview();
  const login = $("profile-login");
  const email = $("profile-email");
  const name = $("profile-name");
  const plan = $("profile-plan");
  if (login) login.textContent = uiLocale() === "en" ? "Checking…" : "检测中…";
  try {
    const acc = await grokDesktop.accountProfile?.();
    if (login) {
      login.textContent = acc?.loggedIn
        ? (uiLocale() === "en" ? "Signed in" : "已登录")
        : (uiLocale() === "en" ? "Not signed in" : "未登录");
    }
    if (email) email.textContent = acc?.email || "—";
    if (name) name.textContent = acc?.name || acc?.userId || "—";
    if (plan) plan.textContent = acc?.subscriptionTier || "—";
  } catch {
    if (login) login.textContent = uiLocale() === "en" ? "Unavailable" : "读不到账号";
  }
  renderUsageHeat(lastAccountUsage);
  void refreshAccountUsage();
}

async function persistNickname() {
  const n = ($("set-nickname")?.value || "").trim();
  desktopSettings.profileNickname = n;
  try {
    desktopSettings = { ...desktopSettings, ...(await grokDesktop.saveDesktopSettings({ profileNickname: n })) };
  } catch {
    /* keep local */
  }
  refreshTurnWho();
}

async function pickProfileAvatar() {
  try {
    const imgs = await grokDesktop.pickImages();
    const one = Array.isArray(imgs) ? imgs[0] : null;
    if (!one?.dataBase64) return;
    const next = await grokDesktop.setProfileAvatar({
      dataBase64: one.dataBase64,
      mimeType: one.mimeType || "image/png",
    });
    desktopSettings = { ...desktopSettings, ...next };
    desktopSettings.profileAvatarUrl = one.dataUrl || "";
    syncProfileAvatarPreview();
    refreshTurnWho();
    flashToast(uiLocale() === "en" ? "Avatar saved" : "头像已保存");
  } catch (err) {
    flashToast(err?.message || String(err));
  }
}

async function clearProfileAvatar() {
  try {
    const next = await grokDesktop.clearProfileAvatar();
    desktopSettings = { ...desktopSettings, ...next };
  } catch {
    desktopSettings.profileAvatar = "";
  }
  desktopSettings.profileAvatarUrl = "";
  syncProfileAvatarPreview();
  refreshTurnWho();
}

async function loadSettings() {
  const msg = $("settings-msg");
  try {
    const s = await grokDesktop.getSettings();
    desktopSettings = { ...desktopSettings, ...(s.desktop || {}) };
    if ($("set-show-thinking")) $("set-show-thinking").checked = !!desktopSettings.showThinking;
    if ($("set-enter-send")) $("set-enter-send").checked = desktopSettings.enterToSend !== false;
    if ($("set-notify-done")) $("set-notify-done").checked = desktopSettings.notifyOnDone !== false;
    if ($("set-close-to-tray")) $("set-close-to-tray").checked = desktopSettings.closeToTray !== false;
    if ($("set-minimize-to-tray"))
      $("set-minimize-to-tray").checked = !!desktopSettings.minimizeToTray;
    if ($("set-open-at-login")) $("set-open-at-login").checked = !!desktopSettings.openAtLogin;
    if ($("set-check-updates")) $("set-check-updates").checked = desktopSettings.checkUpdates !== false;
    if ($("set-density")) $("set-density").value = desktopSettings.density || "comfortable";
    if ($("set-theme")) $("set-theme").value = desktopSettings.theme || "dark";
    desktopSettings.palette = normalizePalette(desktopSettings.palette);
    syncPaletteGrid();
    applyProxyForm(desktopSettings);
    applyDensity(desktopSettings.density);
    applyThinkingVisibility();
    applyTheme(desktopSettings.theme);
    applyWallpaper();

    const grok = s.grok || {};
    const mode = deriveAccessMode(desktopSettings, grok);
    desktopSettings.accessMode = mode;
    if ($("set-yolo")) $("set-yolo").checked = !!grok.yolo;
    setAccessModeUi(mode);

    const loc = desktopSettings.locale === "en" ? "en" : "zh";
    if ($("set-locale")) $("set-locale").value = loc;
    applyLocale(loc);
    await hydrateProfileAvatar();
    if ($("set-nickname")) $("set-nickname").value = desktopSettings.profileNickname || "";
    syncProfileAvatarPreview();

    const info = await grokDesktop.appInfo();
    if ($("set-memory")) $("set-memory").checked = !!info.memoryEnabled;
    if ($("set-experience-memory"))
      $("set-experience-memory").checked = desktopSettings.experienceMemory !== false;
    if ($("memory-experience-enabled"))
      $("memory-experience-enabled").checked = desktopSettings.experienceMemory !== false;
    if ($("set-cli")) $("set-cli").textContent = info.grokCli || "—";
    if ($("set-grok-home")) $("set-grok-home").textContent = s.grokHome || info.grokHome || "—";
    if ($("set-config-path")) $("set-config-path").textContent = grok.path || "—";
    if ($("set-desktop-ver")) $("set-desktop-ver").textContent = info.desktopVersion || "—";
    // Refresh health card whenever settings open
    void runDiagnose().then((d) => renderCliHealth(d)).catch(() => {});

    // default model dropdown
    const sel = $("set-model");
    if (sel) {
      sel.replaceChildren();
      const models = s.models?.models || [];
      if (!models.length) {
        const o = document.createElement("option");
        o.value = currentModelId || "";
        o.textContent = currentModelId || "—";
        sel.appendChild(o);
      } else {
        for (const m of models) {
          const o = document.createElement("option");
          o.value = m.id;
          o.textContent = m.id + (m.isDefault ? " ★" : "");
          sel.appendChild(o);
        }
        sel.value = grok.defaultModel || s.models?.defaultModel || models[0].id;
      }
    }

    if (msg) {
      msg.textContent = "";
      msg.classList.remove("error");
    }
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || String(err);
      msg.classList.add("error");
    }
  }
}

function applyDensity(d) {
  document.body.classList.toggle("compact", d === "compact");
}

function applyThinkingVisibility() {
  document.body.classList.toggle("hide-thinking", desktopSettings.showThinking === false);
}

/** Resolve effective theme: dark | light (system → prefers-color-scheme). */
function resolveTheme(pref) {
  const p = pref === "light" || pref === "system" || pref === "dark" ? pref : "dark";
  if (p === "system") {
    try {
      return window.matchMedia?.("(prefers-color-scheme: light)")?.matches
        ? "light"
        : "dark";
    } catch {
      return "dark";
    }
  }
  return p;
}

const PALETTE_IDS = ["paper", "stone", "ink", "sage", "dusk", "clay"];

function normalizePalette(id) {
  return PALETTE_IDS.includes(id) ? id : "paper";
}

function applyPalette(id) {
  const p = normalizePalette(id);
  for (const name of PALETTE_IDS) document.body.classList.remove("palette-" + name);
  document.body.classList.add("palette-" + p);
}

function syncPaletteGrid() {
  const cur = normalizePalette(desktopSettings.palette);
  document.querySelectorAll("#palette-grid .pal-swatch").forEach((b) => {
    const active = b.getAttribute("data-palette") === cur;
    b.classList.toggle("active", active);
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", active ? "true" : "false");
    b.tabIndex = active ? 0 : -1;
  });
}

function rememberChrome(theme, palette) {
  try {
    localStorage.setItem("gd-theme", theme || desktopSettings.theme || "light");
    localStorage.setItem("gd-palette", normalizePalette(palette || desktopSettings.palette));
  } catch {
    /* ignore */
  }
}

function applyTheme(pref) {
  const mode = resolveTheme(pref || desktopSettings.theme || "light");
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(mode === "light" ? "theme-light" : "theme-dark");
  applyPalette(desktopSettings.palette || "paper");
  rememberChrome(pref || desktopSettings.theme || "light", desktopSettings.palette);
  try {
    document.documentElement.style.colorScheme = mode;
  } catch {
    /* ignore */
  }
}

async function persistPalette(id) {
  const palette = normalizePalette(id);
  desktopSettings.palette = palette;
  applyPalette(palette);
  syncPaletteGrid();
  try {
    await grokDesktop.saveDesktopSettings({ palette });
  } catch {
    /* ignore */
  }
}

/** Persist theme immediately so switch feels instant without full Save. */
async function persistTheme(theme) {
  desktopSettings.theme = theme;
  applyTheme(theme);
  try {
    await grokDesktop.saveDesktopSettings({ theme });
  } catch {
    /* ignore */
  }
}

const WALLPAPER_GRADIENTS = {
  none: null,
  aurora: "linear-gradient(145deg, #1a1030 0%, #0f172a 40%, #134e4a 100%)",
  ember: "linear-gradient(160deg, #1c1010 0%, #3b1d1d 45%, #1a1020 100%)",
  ocean: "linear-gradient(150deg, #0b1220 0%, #0e2a4a 50%, #0f172a 100%)",
  mist: "linear-gradient(180deg, #18181b 0%, #27272a 50%, #1e1b2e 100%)",
};
const WALLPAPER_GRADIENTS_LIGHT = {
  none: null,
  aurora: "linear-gradient(145deg, #ede9fe 0%, #e0f2fe 45%, #ccfbf1 100%)",
  ember: "linear-gradient(160deg, #fff1f2 0%, #ffedd5 50%, #fafafa 100%)",
  ocean: "linear-gradient(150deg, #eff6ff 0%, #dbeafe 50%, #f8fafc 100%)",
  mist: "linear-gradient(180deg, #f4f4f5 0%, #e4e4e7 55%, #fafafa 100%)",
};
function wallpaperGradient(kind) {
  const table = document.body.classList.contains("theme-light")
    ? WALLPAPER_GRADIENTS_LIGHT
    : WALLPAPER_GRADIENTS;
  return table[kind] || WALLPAPER_GRADIENTS[kind];
}

/** 云端生成的黑白航天主题：id → 本地绝对路径 */
/** @type {Record<string, {path:string,thumbPath?:string,name:string}>} */
let wallpaperAssets = {};

function pathToFileUrl(p) {
  if (!p) return "";
  const s = String(p);
  if (s.startsWith("data:") || s.startsWith("file:") || s.startsWith("http")) return s;
  return "file://" + s.replace(/\\/g, "/");
}

function applyWallpaper() {
  const bg = $("thread-bg");
  const dim = $("thread-bg-dim");
  if (!bg || !dim) return;
  const kind = desktopSettings.wallpaper || "none";
  const dimVal = Math.min(80, Math.max(0, Number(desktopSettings.wallpaperDim) || 45));

  bg.style.backgroundImage = "none";
  bg.style.background = "none";
  bg.style.backgroundSize = "cover";
  bg.style.backgroundPosition = "center";
  bg.style.backgroundRepeat = "no-repeat";

  if (kind === "none" || !kind) {
    bg.style.display = "none";
    dim.style.display = "none";
  } else if (kind === "custom" && (desktopSettings.wallpaperDataUrl || desktopSettings.wallpaperPath)) {
    const src = desktopSettings.wallpaperDataUrl || desktopSettings.wallpaperPath;
    bg.style.display = "block";
    dim.style.display = "block";
    bg.style.backgroundImage = `url("${pathToFileUrl(src).replace(/"/g, '\\"')}")`;
    dim.style.opacity = String(dimVal / 100);
  } else if (wallpaperAssets[kind]?.path) {
    bg.style.display = "block";
    dim.style.display = "block";
    bg.style.backgroundImage = `url("${pathToFileUrl(wallpaperAssets[kind].path).replace(/"/g, '\\"')}")`;
    dim.style.opacity = String(dimVal / 100);
  } else if (wallpaperGradient(kind)) {
    bg.style.display = "block";
    dim.style.display = "block";
    bg.style.backgroundImage = "none";
    bg.style.background = wallpaperGradient(kind);
    dim.style.opacity = String(dimVal / 100);
  } else {
    bg.style.display = "none";
    dim.style.display = "none";
  }

  document.querySelectorAll(".wp-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.wp === kind);
  });
  if ($("set-wallpaper-dim")) $("set-wallpaper-dim").value = String(dimVal);
  if ($("set-wallpaper-dim-val")) $("set-wallpaper-dim-val").textContent = String(dimVal);
  const lab = $("wallpaper-custom-label");
  if (lab) {
    if (kind === "custom" && desktopSettings.wallpaperPath) {
      lab.textContent = String(desktopSettings.wallpaperPath).split(/[/\\]/).pop();
    } else if (kind === "custom" && desktopSettings.wallpaperDataUrl) {
      lab.textContent = "已选图片";
    } else if (wallpaperAssets[kind]) {
      lab.textContent = wallpaperAssets[kind].name || kind;
    } else {
      lab.textContent = "未选择";
    }
  }
}

async function loadWallpaperAssets() {
  try {
    const list = (await grokDesktop.listWallpapers?.()) || [];
    wallpaperAssets = {};
    const grid = $("wallpaper-grid");
    const customBtn = grid?.querySelector('[data-wp="custom"]');
    for (const p of list) {
      if (!p?.id || !p.path) continue;
      wallpaperAssets[p.id] = p;
      if (!grid) continue;
      // 已有则更新背景，没有则插入
      let btn = grid.querySelector(`[data-wp="${p.id}"]`);
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "wp-swatch wp-photo";
        btn.dataset.wp = p.id;
        btn.title = p.name || p.id;
        if (customBtn) grid.insertBefore(btn, customBtn);
        else grid.appendChild(btn);
      }
      const thumb = p.thumbPath || p.path;
      btn.style.backgroundImage = `url("${pathToFileUrl(thumb).replace(/"/g, '\\"')}")`;
      btn.style.backgroundSize = "cover";
      btn.style.backgroundPosition = "center";
      btn.textContent = "";
    }
  } catch (err) {
    console.warn("loadWallpaperAssets", err);
  }
}

function wireWallpaperUi() {
  const grid = $("wallpaper-grid");
  if (grid && !grid._wpBound) {
    grid._wpBound = true;
    grid.addEventListener("click", async (e) => {
      const btn = e.target.closest(".wp-swatch");
      if (!btn) return;
      const kind = btn.dataset.wp;
      if (!kind) return;
      if (kind === "custom") {
        try {
          const imgs = await grokDesktop.pickImages();
          const one = Array.isArray(imgs) ? imgs[0] : null;
          if (!one?.dataUrl) return;
          desktopSettings = {
            ...desktopSettings,
            ...(await grokDesktop.saveDesktopSettings({
              wallpaper: "custom",
              wallpaperPath: one.path || one.name,
              wallpaperDataUrl: one.dataUrl,
              wallpaperDim: desktopSettings.wallpaperDim ?? 45,
            })),
          };
        } catch (err) {
          appendBanner(`选择图片失败：${err.message || err}`, "error");
          return;
        }
      } else {
        desktopSettings.wallpaper = kind;
        try {
          desktopSettings = {
            ...desktopSettings,
            ...(await grokDesktop.saveDesktopSettings({
              wallpaper: kind,
              wallpaperDim: desktopSettings.wallpaperDim ?? 45,
            })),
          };
        } catch {
          /* 本地预览优先 */
        }
      }
      applyWallpaper();
    });
  }
  $("btn-wallpaper-pick")?.addEventListener("click", async () => {
    try {
      const imgs = await grokDesktop.pickImages();
      const one = Array.isArray(imgs) ? imgs[0] : null;
      if (!one?.dataUrl) return;
      desktopSettings = {
        ...desktopSettings,
        ...(await grokDesktop.saveDesktopSettings({
          wallpaper: "custom",
          wallpaperPath: one.path || one.name,
          wallpaperDataUrl: one.dataUrl,
        })),
      };
      applyWallpaper();
    } catch (err) {
      appendBanner(`选择图片失败：${err.message || err}`, "error");
    }
  });
  $("set-wallpaper-dim")?.addEventListener("input", () => {
    const v = Number($("set-wallpaper-dim").value) || 0;
    if ($("set-wallpaper-dim-val")) $("set-wallpaper-dim-val").textContent = String(v);
    desktopSettings.wallpaperDim = v;
    applyWallpaper();
  });
  $("set-wallpaper-dim")?.addEventListener("change", async () => {
    const v = Number($("set-wallpaper-dim").value) || 0;
    try {
      desktopSettings = {
        ...desktopSettings,
        ...(await grokDesktop.saveDesktopSettings({ wallpaperDim: v })),
      };
    } catch {
      desktopSettings.wallpaperDim = v;
    }
    applyWallpaper();
  });
}

$("set-nickname")?.addEventListener("change", () => void persistNickname());
$("set-avatar-pick")?.addEventListener("click", () => void pickProfileAvatar());
$("set-avatar-clear")?.addEventListener("click", () => void clearProfileAvatar());

$("btn-settings-save")?.addEventListener("click", async () => {
  const msg = $("settings-msg");
  if (msg) {
    msg.classList.remove("error");
    msg.textContent = t("settings.saving");
  }
  try {
    const mode = normalizeAccessMode(
      document.querySelector("#access-mode-cards .mode-card.active")?.getAttribute("data-mode") ||
        desktopSettings.accessMode,
    );
    const mapped = accessModeToSettings(mode, !!$("set-yolo")?.checked);
    const locale = $("set-locale")?.value === "en" ? "en" : "zh";

    desktopSettings = await grokDesktop.saveDesktopSettings({
      profileNickname: ($("set-nickname")?.value || "").trim(),
      showThinking: !!$("set-show-thinking")?.checked,
      enterToSend: !!$("set-enter-send")?.checked,
      notifyOnDone: !!$("set-notify-done")?.checked,
      closeToTray: !!$("set-close-to-tray")?.checked,
      minimizeToTray: !!$("set-minimize-to-tray")?.checked,
      openAtLogin: !!$("set-open-at-login")?.checked,
      checkUpdates: !!$("set-check-updates")?.checked,
      experienceMemory: $("set-experience-memory")
        ? !!$("set-experience-memory").checked
        : desktopSettings.experienceMemory !== false,
      density: $("set-density")?.value || "comfortable",
      theme: $("set-theme")?.value || desktopSettings.theme || "dark",
      palette: normalizePalette(desktopSettings.palette),
      proxyUrl: ($("set-proxy")?.value || "").trim() || desktopSettings.proxyUrl || "",
      proxyEnabled: $("set-proxy-on")
        ? !!$("set-proxy-on").checked
        : desktopSettings.proxyEnabled !== false,
      autoApprove: mapped.autoApprove,
      accessMode: mapped.accessMode,
      locale,
      wallpaper: desktopSettings.wallpaper || "none",
      wallpaperPath: desktopSettings.wallpaperPath || null,
      wallpaperDataUrl: desktopSettings.wallpaperDataUrl || null,
      wallpaperDim: Number($("set-wallpaper-dim")?.value) || desktopSettings.wallpaperDim || 45,
      setupDismissed: desktopSettings.setupDismissed,
    });
    if ($("memory-experience-enabled")) {
      $("memory-experience-enabled").checked = desktopSettings.experienceMemory !== false;
    }
    applyDensity(desktopSettings.density);
    applyThinkingVisibility();
    applyTheme(desktopSettings.theme);
    applyWallpaper();
    applyLocale(locale);
    refreshTurnWho();
    setAccessModeUi(mapped.accessMode);
    try {
      await grokDesktop.setAutoApprove(mapped.autoApprove);
    } catch {
      /* ignore */
    }
    await grokDesktop.saveGrokSettings({
      permissionMode: mapped.permissionMode,
      yolo: mapped.yolo,
      defaultModel: $("set-model")?.value || undefined,
    });
    if ($("set-memory")) {
      await grokDesktop.setMemoryEnabled($("set-memory").checked);
      if (ui.memoryEnabled) ui.memoryEnabled.checked = $("set-memory").checked;
    }
    if (msg) msg.textContent = t("settings.saved");
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || String(err);
      msg.classList.add("error");
    }
  }
});

// ── Automation bar (Goal / Loop visibility) ────────────

/** @type {Map<string, { kind: 'goal'|'loop', label: string, at: number }>} */
const sessionAutomation = new Map();

function setSessionAutomation(sid, kind, label, extra = {}) {
  if (!sid || !kind) return;
  const prev = sessionAutomation.get(sid) || {};
  const nextLabel = label || prev.label || kind;
  const next = {
    kind,
    label: nextLabel,
    paused: extra.paused != null
      ? extra.paused
      : (kind === "goal" && label && label !== prev.label ? false : !!prev.paused),
    at: Date.now(),
  };
  sessionAutomation.set(sid, next);
  if (kind === "goal" && typeof grokDesktop?.saveSessionGoal === "function") {
    void grokDesktop.saveSessionGoal(sid, next);
  }
  if (sid === activeId) renderWorkCard();
}

function clearSessionAutomation(sid) {
  if (sid) sessionAutomation.delete(sid);
  if (sid && typeof grokDesktop?.saveSessionGoal === "function") {
    void grokDesktop.saveSessionGoal(sid, null);
  }
  if (!sid || sid === activeId) renderWorkCard();
}

function hideAutoBar() {
  const card = $("work-card");
  if (!card) return;
  card.classList.add("hidden");
  card.hidden = true;
}

function setWorkSec(id, on) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("hidden", !on);
  el.hidden = !on;
}

function planStepKind(status) {
  const st = String(status || "pending").toLowerCase().replace(/\s+/g, "_");
  if (/completed|complete|done|success/.test(st)) return "done";
  if (/in_progress|inprogress|running|active/.test(st)) return "now";
  return "todo";
}

function paintWorkPlan(entries) {
  const list = $("work-plan-steps");
  const more = $("work-plan-more");
  const pill = $("work-plan-pill");
  const pillText = $("work-plan-pill-text");
  if (!entries.length) {
    setWorkSec("work-plan", false);
    return;
  }
  setWorkSec("work-plan", true);
  const kinds = entries.map((e) => planStepKind(e.status));
  const done = kinds.filter((k) => k === "done").length;
  const nowIdx = kinds.findIndex((k) => k === "now");
  const focus = nowIdx >= 0 ? nowIdx : kinds.findIndex((k) => k === "todo");
  const windowSize = 5;
  let start = 0;
  if (entries.length > windowSize && focus >= 0) {
    start = Math.max(0, Math.min(focus - 1, entries.length - windowSize));
  }
  const slice = entries.slice(start, start + windowSize);
  if (list) {
    list.replaceChildren();
    for (const e of slice) {
      const kind = planStepKind(e.status);
      const li = document.createElement("li");
      li.className = "work-step is-" + kind;
      const mark = document.createElement("span");
      mark.className = "work-mark";
      mark.setAttribute("aria-hidden", "true");
      const txt = document.createElement("span");
      txt.className = "work-step-text";
      txt.textContent = e.content || "";
      li.append(mark, txt);
      list.appendChild(li);
    }
  }
  const stepN = nowIdx >= 0 ? nowIdx + 1 : Math.min(entries.length, done + 1);
  const allDone = done >= entries.length && entries.length > 0;
  if (pill && pillText) {
    const en = uiLocale() === "en";
    const tpl = typeof t === "function"
      ? t(allDone ? "work.stepDone" : "work.stepN")
      : (allDone
        ? (en ? "Done {m} / {m}" : "已完成 {m} / {m}")
        : (en ? "Step {n} / {m}" : "第 {n} / {m} 步"));
    pillText.textContent = String(tpl)
      .replace("{n}", String(stepN))
      .split("{m}").join(String(entries.length));
    pill.classList.toggle("is-done", allDone);
    pill.classList.remove("hidden");
    pill.hidden = false;
  }
  const hiddenN = entries.length - slice.length;
  if (more) {
    if (hiddenN > 0) {
      const tpl = typeof t === "function" ? t("work.more") : "还有 {n} 步";
      more.textContent = String(tpl).replace("{n}", String(hiddenN));
      more.classList.remove("hidden");
      more.hidden = false;
    } else {
      more.classList.add("hidden");
      more.hidden = true;
    }
  }
}

function renderWorkCard() {
  const card = $("work-card");
  if (!card) return;
  const info = activeId ? sessionAutomation.get(activeId) : null;
  const hasLoop = info?.kind === "loop";

  setWorkSec("work-goal", false);
  const wait = $("work-goal-wait");
  const waitText = $("work-goal-wait-text");
  const acts = $("work-goal-acts");
  if (wait) {
    wait.classList.add("hidden");
    wait.hidden = true;
  }
  if (waitText) waitText.textContent = "";
  if (acts) {
    acts.classList.add("hidden");
    acts.hidden = true;
    acts.replaceChildren();
  }

  if (hasLoop) {
    setWorkSec("work-loop", true);
    const text = $("work-loop-text");
    const stopBtn = $("work-loop-stop");
    if (text) text.textContent = info.label && info.label !== "loop" ? info.label : "";
    if (stopBtn) stopBtn.textContent = typeof t === "function" ? t("work.stop") : "停掉";
  } else {
    setWorkSec("work-loop", false);
  }

  paintWorkPlan([]); // plan card lives in the right list

  const show = hasLoop;
  card.classList.toggle("hidden", !show);
  card.hidden = !show;
}

function noteAutomationFromSlash(name, rawArgs) {
  if (!activeId) return;
  const n = String(name || "").replace(/^\//, "");
  const args = String(rawArgs || "").trim();
  if (n === "goal") {
    if (/^clear$/i.test(args)) {
      clearSessionAutomation(activeId);
      paintComposerMode("task");
      return;
    }
    if (/^pause$/i.test(args)) {
      const prev = sessionAutomation.get(activeId);
      setSessionAutomation(activeId, "goal", prev?.label || "goal", { paused: true });
      paintComposerMode("goal");
      return;
    }
    if (/^resume$/i.test(args)) {
      const prev = sessionAutomation.get(activeId);
      setSessionAutomation(activeId, "goal", prev?.label || "goal", { paused: false });
      paintComposerMode("goal");
      return;
    }
    if (!args || /^status$/i.test(args)) {
      if (!sessionAutomation.has(activeId)) {
        setSessionAutomation(activeId, "goal", "goal");
      } else {
        renderWorkCard();
      }
      paintComposerMode("goal");
      return;
    }
    setSessionAutomation(activeId, "goal", args);
    paintComposerMode("goal");
    const stGoal = ensureSessionUi(activeId);
    stGoal.plan = { entries: [] };
    renderPlan({ entries: [] });
  } else if (n === "loop") {
    if (/^(clear|stop|cancel)$/i.test(args)) {
      clearSessionAutomation(activeId);
      return;
    }
    setSessionAutomation(activeId, "loop", args || "loop");
  } else if (n === "plan") {
    paintComposerMode("plan");
    planModePending = false;
    renderWorkCard();
  }
}

// ── Composer work mode (Goal / Task / Plan) — compact popover next to effort ──

/** True after user selects Plan until the first /plan-bearing send (official Pending). */
let planModePending = false;

function modeIco(mode) {
  return mode === "goal" ? "◎" : mode === "plan" ? "💡" : "⚡";
}

function paintComposerMode(mode) {
  const next = mode === "goal" || mode === "plan" ? mode : "task";
  composerMode = next;
  if (activeId) {
    const st = ensureSessionUi(activeId);
    st.composerMode = next;
  }
  const icoEl = $("mode-ico");
  if (icoEl) icoEl.textContent = modeIco(next);
  paintComposerAccess();
  $("composer")?.setAttribute("data-work-mode", next);
  // Reflect selection inside open popover
  if (ui.modePop && !ui.modePop.classList.contains("hidden")) renderModePop();
  refreshSendButtonState();
  const st = activeId ? sessionUi.get(activeId) : null;
  syncPlanChrome(normalizePlanEntries(st?.plan).length);
}

const ACCESS_OPTIONS = [
  { id: "safe", titleKey: "access.safe", descKey: "access.safeDesc", badgeKey: "access.badge.safe" },
  { id: "balanced", titleKey: "access.balanced", descKey: "access.balancedDesc", badgeKey: "access.badge.balanced" },
  { id: "full", titleKey: "access.full", descKey: "access.fullDesc", badgeKey: "access.badge.full" },
];

function paintComposerAccess() {
  const m = normalizeAccessMode(desktopSettings.accessMode);
  if (ui.modeLabel) ui.modeLabel.textContent = t("access.badge." + m);
  if (ui.modeBtn) {
    ui.modeBtn.setAttribute("data-access", m);
    ui.modeBtn.title = t("access." + m + "Desc");
    ui.modeBtn.setAttribute("aria-label", t("access." + m));
  }
  if (ui.modePop && !ui.modePop.classList.contains("hidden")) renderModePop();
}

async function persistComposerAccess(mode) {
  const m = normalizeAccessMode(mode);
  setAccessModeUi(m);
  const mapped = accessModeToSettings(m, !!$("set-yolo")?.checked);
  try {
    await grokDesktop.saveDesktopSettings({
      accessMode: mapped.accessMode,
      autoApprove: mapped.autoApprove,
    });
    if (grokDesktop.setAutoApprove) await grokDesktop.setAutoApprove(mapped.autoApprove);
    if (grokDesktop.saveGrokSettings) {
      await grokDesktop.saveGrokSettings({
        permissionMode: mapped.permissionMode,
        yolo: mapped.yolo,
      });
    }
  } catch {
    /* ignore */
  }
}

function renderModePop() {
  if (!ui.modePop) return;
  const cur = normalizeAccessMode(desktopSettings.accessMode);
  ui.modePop.replaceChildren();
  for (const m of ACCESS_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mode-item" + (m.id === cur ? " active" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", m.id === cur ? "true" : "false");
    btn.dataset.access = m.id;
    const title = t(m.titleKey);
    const desc = t(m.descKey);
    btn.title = desc || title;
    btn.innerHTML =
      `<span class="mode-item-title"><span>${title}</span><span class="mode-item-check">✓</span></span>` +
      `<span class="mode-item-desc">${desc}</span>`;
    btn.onclick = (e) => {
      e.stopPropagation();
      closeModePop();
      void persistComposerAccess(m.id);
    };
    ui.modePop.appendChild(btn);
  }
}

function openModePop() {
  modeOpen = true;
  modelOpen = false;
  effortOpen = false;
  ui.modelPop?.classList.add("hidden");
  ui.effortPop?.classList.add("hidden");
  hideSlash();
  renderModePop();
  ui.modePop?.classList.remove("hidden");
}

function closeModePop() {
  modeOpen = false;
  ui.modePop?.classList.add("hidden");
}

function toggleModePop() {
  if (modeOpen) closeModePop();
  else openModePop();
}

ui.modeBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleModePop();
});

/**
 * Map free-form input to official CLI slash forms for the active work mode.
 * Task (Normal): passthrough
 * Plan: first message after selecting Plan → `/plan <text>` (official entry)
 * Goal: plain text → `/goal <text>` (unless already a slash command)
 */
function applyWorkModeToPrompt(rawText, extras = {}) {
  const text = String(rawText || "").trim();
  if (!text) return text;
  // Multimodal: never wrap a picture send as /goal — the model should see the image.
  if (extras.images?.length || extras.files?.length) return text;
  if (composerMode === "goal") {
    if (/^\//.test(text)) return text;
    return `/goal ${text}`;
  }
  if (composerMode === "plan" && planModePending) {
    if (/^\/(plan|view-plan|show-plan|plan-view)\b/i.test(text)) return text;
    if (/^\//.test(text)) return text;
    return `/plan ${text}`;
  }
  return text;
}

function inferGoalFromSession(sessionId, meta, messages) {
  const title = String(
    (meta && meta.title) ||
      (sessions.find((s) => s.id === sessionId) || {}).title ||
      "",
  );
  if (/^\/goal\b/i.test(title)) {
    const label = title.replace(/^\/goal\s*/i, "").trim();
    if (!/^clear$/i.test(label)) return { mode: "goal", label: label || "goal" };
  }
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const raw = String(msgs[i].text || "");
    if (!/^\/goal\b/i.test(raw)) continue;
    const rest = raw.replace(/^\/goal\s*/i, "").trim();
    if (/^clear$/i.test(rest)) return { mode: "task" };
    if (/^pause$/i.test(rest)) return { mode: "goal", label: "goal", paused: true };
    if (/^(resume|status)$/i.test(rest)) return { mode: "goal", label: "goal" };
    return { mode: "goal", label: rest || "goal" };
  }
  if (meta?.title && /^\/goal\b/i.test(String(meta.title))) {
    const rest = String(meta.title).replace(/^\/goal\s*/i, "").trim();
    if (rest && !/^(clear|pause|resume|status)$/i.test(rest)) return { mode: "goal", label: rest };
  }
  return { mode: "task" };
}

function restoreComposerModeForSession(sessionId) {
  if (!sessionId) {
    paintComposerMode("task");
    hideAutoBar();
    return;
  }
  const st = ensureSessionUi(sessionId);
  if (isPlanAllDone(st.plan)) {
    clearFinishedGoal(sessionId, { paint: sessionId === activeId });
    paintComposerMode("task");
    hideAutoBar();
    return;
  }
  const mode = st.composerMode === "goal" || st.composerMode === "plan" ? st.composerMode : "task";
  if (mode === "goal") {
    paintComposerMode("goal");
    renderWorkCard();
    return;
  }
  if (mode === "plan") {
    paintComposerMode("plan");
    return;
  }
  paintComposerMode("task");
}

function insertSlashIntoComposer(prefix) {
  switchView("chat");
  if (!activeId) {
    appendBanner(
      uiLocale() === "en"
        ? "Open or create a chat first, then use /goal or /loop"
        : "请先打开或新建对话，再使用 /goal 或 /loop",
      "error",
    );
    return;
  }
  ui.input.value = prefix;
  ui.input.disabled = false;
  setComposerEnabled(true);
  ui.input.focus();
  const len = ui.input.value.length;
  ui.input.setSelectionRange(len, len);
  autosize();
  updateSlashFromInput();
}

function handleWelcomeAuto(kind) {
  if (kind === "skills") {
    switchView("skills");
    return;
  }
  if (kind === "hooks") {
    switchView("settings");
    showSettingsPanel("automation");
    return;
  }
  if (kind === "goal") {
    insertSlashIntoComposer("/goal ");
    return;
  }
  if (kind === "loop") {
    insertSlashIntoComposer("/loop ");
  }
}

// ── Slash command palette (/) ──────────────────────────

/**
 * True when catalog went through main localizeAll / commandsForRenderer
 * (titleZh/group present). Raw ACP is only { name, description, _meta? }.
 */
function commandsLookLocalized(cmds) {
  if (!Array.isArray(cmds) || !cmds.length) return false;
  return cmds.some(
    (c) =>
      c &&
      (typeof c.titleZh === "string" ||
        typeof c.group === "string" ||
        c.desktop === true ||
        c.isSkill === true),
  );
}

/** Apply localized slash catalog into session state + live palette. */
function applySlashCatalog(cmds, stTarget) {
  if (!commandsLookLocalized(cmds)) return false;
  const merged = adoptSlashCommands(cmds);
  if (stTarget) stTarget.commands = merged;
  return true;
}

/** Fallback: commands:list (always localizeAll on main). */
async function refreshSlashCatalog(sessionId, stTarget, seq) {
  try {
    const cl = await grokDesktop.listCommands(sessionId);
    if (seq != null && seq !== openSeq) return false;
    return applySlashCatalog(cl?.commands, stTarget);
  } catch {
    return false;
  }
}

function hideSlash() {
  slashOpen = false;
  slashIndex = 0;
  slashFiltered = [];
  if (ui.slashMenu) {
    ui.slashMenu.classList.add("hidden");
    ui.slashMenu.replaceChildren();
  }
}

function filterSlash(query) {
  seedSlashCatalog();
  const list = slashCommands.length ? slashCommands : localSlashCatalog();
  // Prefer shipped pure helper (preload); fallback keeps palette usable offline.
  const token = String(query || "").replace(/^\//, "").split(/\s+/, 1)[0];
  if (typeof slashCatalog.filterSlashCommands === "function") {
    return slashCatalog.filterSlashCommands(list, token, { limit: 40 });
  }
  const q = token.toLowerCase();
  if (!q) return list.slice(0, 40);
  const hits = list.filter((c) => {
    const name = String(c.name || "").toLowerCase();
    const hay = `${c.name} ${c.titleZh || ""} ${c.descZh || ""} ${c.description || ""}`.toLowerCase();
    return name.startsWith(q) || hay.includes(q);
  });
  if (!hits.some((c) => String(c.name || "").toLowerCase() === q) && /^[a-z0-9][a-z0-9_-]*$/i.test(q)) {
    hits.unshift({ name: token, titleZh: "发送到 CLI", descZh: "任意官方斜杠，回车发出", group: "agent" });
  }
  return hits.slice(0, 40);
}

function slashGroupTitle(group, meta) {
  const loc = window.GrokI18n?.getLocale?.() || "zh";
  if (meta) return loc === "en" ? meta.titleEn || meta.titleZh : meta.titleZh || meta.titleEn;
  try {
    const all = slashCatalog.GROUP_META || {};
    const m = all[group];
    if (m) return loc === "en" ? m.titleEn : m.titleZh;
  } catch {
    /* ignore */
  }
  return group;
}

function renderSlashMenu() {
  if (!ui.slashMenu) return;
  ui.slashMenu.replaceChildren();
  if (!slashFiltered.length) {
    hideSlash();
    return;
  }

  const groups =
    typeof slashCatalog.groupSlashCommands === "function"
      ? slashCatalog.groupSlashCommands(slashFiltered)
      : [{ group: "all", titleZh: "", titleEn: "", items: slashFiltered }];

  // Flat index across groups for keyboard selection
  let flatIdx = 0;
  for (const g of groups) {
    if (g.titleZh || g.titleEn) {
      const head = document.createElement("div");
      head.className = "slash-group";
      head.textContent = slashGroupTitle(g.group, g);
      ui.slashMenu.appendChild(head);
    }
    for (const cmd of g.items) {
      const i = flatIdx++;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slash-item" + (i === slashIndex ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === slashIndex ? "true" : "false");

      const cmdEl = document.createElement("span");
      cmdEl.className = "cmd";
      cmdEl.textContent = `/${cmd.name}`;

      const titleEl = document.createElement("span");
      titleEl.className = "title";
      titleEl.textContent = cmd.titleZh || cmd.name;

      const descEl = document.createElement("span");
      descEl.className = "desc";
      descEl.textContent = cmd.descZh || cmd.description || "";

      btn.appendChild(cmdEl);
      btn.appendChild(titleEl);

      const desktopRoute =
        typeof slashCatalog.resolveDesktopRoute === "function"
          ? slashCatalog.resolveDesktopRoute(cmd.name, !!cmd.isSkill)
          : null;
      if (cmd.isSkill) {
        const badge = document.createElement("span");
        badge.className = "slash-badge badge-skill";
        badge.textContent = typeof t === "function" ? t("slash.badgeSkill") : "Skill";
        btn.appendChild(badge);
      } else if (desktopRoute) {
        const badge = document.createElement("span");
        badge.className = "slash-badge badge-desktop";
        badge.textContent = typeof t === "function" ? t("slash.badgeDesktop") : "桌面";
        btn.appendChild(badge);
      }

      btn.appendChild(descEl);
      btn.onmousedown = (e) => {
        e.preventDefault();
        applySlash(cmd);
      };
      ui.slashMenu.appendChild(btn);
    }
  }

  ui.slashMenu.classList.remove("hidden");
  slashOpen = true;
  const active = ui.slashMenu.querySelector(".slash-item.active");
  active?.scrollIntoView({ block: "nearest" });
}

function updateSlashFromInput() {
  const val = ui.input.value;
  // only when line starts with /
  const m = val.match(/^\/([^\n]*)$/);
  if (!m || !activeId) {
    hideSlash();
    return;
  }
  const rest = m[1] || "";
  const token = rest.split(/\s+/, 1)[0] || "";
  // Any "/cmd args": command is already chosen. Hide palette so Enter sends
  // the full line instead of rewriting the input.
  if (/\s/.test(rest)) {
    hideSlash();
    return;
  }
  slashFiltered = filterSlash(token);
  if (slashIndex >= slashFiltered.length) slashIndex = Math.max(0, slashFiltered.length - 1);
  renderSlashMenu();
}

/**
 * Desktop-local routes vs real agent slash commands.
 * Pure UI routes use DESKTOP_UI_ROUTES from commands-zh (via preload) and never
 * send a fake agent prompt for those slash names.
 * Skills and CLI builtins always hit the live agent (no placeholders).
 */
function applySlash(cmd) {
  hideSlash();
  if (!cmd) return;
  const name = cmd.name;
  const typed = String(ui.input?.value || "");
  if (new RegExp("^/" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+\\S", "i").test(typed)) {
    void send();
    return;
  }
  const route =
    typeof slashCatalog.resolveDesktopRoute === "function"
      ? slashCatalog.resolveDesktopRoute(name, !!cmd.isSkill)
      : null;

  if (route && !cmd.isSkill) {
    ui.input.value = "";
    switch (route) {
      case "open-settings":
        switchView("settings");
        return;
      case "open-skills":
        switchView("skills");
        return;
      case "open-plugins":
        switchView("plugins");
        return;
      case "open-mcp":
        switchView("settings");
        showSettingsPanel("mcp");
        return;
      case "open-memory":
        switchView("memory");
        return;
      case "call-session":
        ui.input.value = "/" + name + " ";
        autosize();
        ui.input.focus();
        return;
      case "new-session":
        void newSession();
        return;
      case "home":
        showWelcome();
        setStatus("idle", typeof t === "function" ? t("status.idle") : "就绪");
        return;
      case "rename":
        ui.rename?.click();
        return;
      case "export":
        $("btn-act-export")?.click();
        return;
      case "show-usage":
        if (activeId) appendTurn("user", "/" + name, { clampable: false });
        void handleDesktopSlash(name, "", activeId);
        return;
      case "show-context":
        if (activeId) appendTurn("user", "/" + name, { clampable: false });
        void handleDesktopSlash(name, "", activeId);
        return;
      case "show-help":
        if (activeId) appendTurn("user", "/" + name, { clampable: false });
        void handleDesktopSlash(name, "", activeId);
        return;
      case "copy-last": {
        const msgs = [...ui.inner.querySelectorAll(".turn.assistant .body")];
        const last = msgs[msgs.length - 1];
        if (last?.textContent) {
          navigator.clipboard?.writeText(last.textContent);
          appendBanner(typeof t === "function" ? t("slash.copied") : "已复制最近一条回复");
        } else {
          void runRealSlash("copy");
        }
        return;
      }
      default:
        break;
    }
  }

  // Hybrid desktop status → real session-info on agent
  if (name === "status" && !cmd.isSkill) {
    ui.input.value = "";
    void runRealSlash("session-info");
    return;
  }

  // Needs arguments → leave in input for user to complete
  const hint = cmd.input?.hint;
  if (hint) {
    ui.input.value = `/${name} `;
    ui.input.focus();
    const len = ui.input.value.length;
    ui.input.setSelectionRange(len, len);
    autosize();
    hideSlash();
    return;
  }

  // Fire real slash to agent
  ui.input.value = "";
  void runRealSlash(name);
}

grokDesktop.onCommands?.((payload) => {
  if (payload?.sessionId && payload.sessionId !== activeId) return;
  const next = payload?.commands || [];
  adoptSlashCommands(next);
  if (!slashCommands.length) seedSlashCatalog();
  if (slashOpen) updateSlashFromInput();
});

// ── Wire ───────────────────────────────────────────────

function renderSnippetWithMark(el, snippet, query) {
  el.replaceChildren();
  const snip = String(snippet || "");
  const q = String(query || "").trim();
  if (!q) {
    el.textContent = snip;
    return;
  }
  const low = snip.toLowerCase();
  const qLow = q.toLowerCase();
  const idx = low.indexOf(qLow);
  if (idx < 0) {
    el.textContent = snip;
    return;
  }
  el.appendChild(document.createTextNode(snip.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.textContent = snip.slice(idx, idx + q.length);
  el.appendChild(mark);
  el.appendChild(document.createTextNode(snip.slice(idx + q.length)));
}

async function runContentSearch(q) {
  if (!ui.searchHits) return;
  const query = (q || "").trim();
  lastSearchQuery = query;
  const seq = ++contentSearchSeq;
  if (query.length < 2) {
    ui.searchHits.classList.add("hidden");
    ui.searchHits.replaceChildren();
    return;
  }
  ui.searchHits.classList.remove("hidden");
  ui.searchHits.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "list-empty search-loading";
  loading.setAttribute("role", "status");
  loading.textContent = uiLocale() === "en" ? "Searching conversations…" : "正在搜索会话…";
  ui.searchHits.appendChild(loading);
  try {
    const hits = await grokDesktop.searchSessions(query, 20);
    if (seq !== contentSearchSeq || query !== lastSearchQuery) return;
    if (!hits?.length) {
      ui.searchHits.classList.remove("hidden");
      ui.searchHits.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.textContent = uiLocale() === "en"
        ? "No full-text matches (title matches remain below)."
        : "全文无匹配（标题匹配仍显示在下方列表）";
      ui.searchHits.appendChild(empty);
      return;
    }
    ui.searchHits.classList.remove("hidden");
    ui.searchHits.replaceChildren();
    for (const h of hits) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-hit";
      btn.innerHTML = `
        <div class="sh-title"></div>
        <div class="sh-snip"></div>
        <div class="sh-meta"></div>`;
      btn.querySelector(".sh-title").textContent = h.title || h.id.slice(0, 8);
      renderSnippetWithMark(btn.querySelector(".sh-snip"), h.snippet || "", query);
      btn.querySelector(".sh-meta").textContent = h.titleOnly
        ? `标题匹配 · ${relativeTime(h.updatedAt)}`
        : `${h.matchCount || 1} 处 · ${relativeTime(h.updatedAt)}`;
      btn.onclick = () => {
        void openSessionWithHighlight(h.id, h.query || query);
      };
      ui.searchHits.appendChild(btn);
    }
  } catch (err) {
    if (seq !== contentSearchSeq) return;
    ui.searchHits.classList.remove("hidden");
    ui.searchHits.replaceChildren();
    const error = document.createElement("div");
    error.className = "list-error";
    error.textContent = err?.message || String(err);
    ui.searchHits.appendChild(error);
  }
}

ui.search.addEventListener("input", () => {
  renderSidebar(ui.search.value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runContentSearch(ui.search.value), 280);
});
ui.refresh.addEventListener("click", () => refreshSessions());
ui.neu?.addEventListener("click", () => newSession());
$("ctx-chip")?.addEventListener("click", () => { if (activeId) void runRealSlash("context"); });
ui.send.addEventListener("click", () => {
  if (isAgentBusy(activeId)) {
    const hasContent =
      !!ui.input?.value?.trim() || pendingImages.length > 0 || pendingFiles.length > 0;
    if (hasContent) {
      send();
      return;
    }
    ui.cancel?.dispatchEvent(new Event("click"));
    return;
  }
  send();
});
ui.cancel.addEventListener("click", async () => {
  if (!activeId) return;
  const sid = activeId;
  const st = ensureSessionUi(sid);
  flushSessionStream(sid);
  abortGoalResume(sid, { pause: true });
  st.stopped = true;
  st.skipGoalResume = true;
  persistSessionUi(sid, {
    stopped: true,
    draft: ui.input?.value || "",
  }, { immediate: true });
  try {
    await grokDesktop.cancel(sid);
  } catch (err) {
    appendBanner(`停止失败：${err?.message || err}`, "error");
  }
  workingSessions.delete(sid);
  promptInFlight.delete(sid);
  markRunEnd(sid);
  dispatchSessionEvent(sid, { type: "run.stop", state: "cancelled", detail: "已停止" });
  endStreamChrome(sid);
  st.streamingEl = null;
  setBusy(false);
  const dur = lastRunDurationMs.get(sid);
  const durLabel = dur != null ? formatDuration(dur) : "";
  setStatus(
    "ready",
    durLabel
      ? uiLocale() === "en"
        ? `Stopped · ${durLabel}`
        : `已停止 · 用时 ${durLabel}`
      : "已停止",
  );
  updateLiveStrip();
  if (activeMeta) applyHeader(activeMeta, { soft: true });
  refreshSidebarSessionState();
  nextSendGeneration(sid);
  appendBanner("已停止当前任务。可继续输入新消息。");
  ui.input?.focus();
});

function onComposerInput() {
  refreshSendButtonState();
  autosize();
  updateSlashFromInput();
  if (activeId) persistSessionUi(activeId, { draft: ui.input?.value || "" });
}
ui.input.addEventListener("input", onComposerInput);
ui.input.addEventListener("compositionend", onComposerInput);
ui.input.addEventListener("change", onComposerInput);
// Voice / IME may inject text without a normal input event
ui.input.addEventListener("keyup", () => {
  refreshSendButtonState();
});
ui.input.addEventListener("keydown", (e) => {
  // Don't steal Enter while Chinese IME / voice composition is confirming
  if (e.isComposing || e.keyCode === 229) return;

  if (slashOpen) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashIndex = Math.min(slashIndex + 1, Math.max(0, slashFiltered.length - 1));
      renderSlashMenu();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex = Math.max(slashIndex - 1, 0);
      renderSlashMenu();
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      if (slashFiltered[slashIndex]) {
        e.preventDefault();
        applySlash(slashFiltered[slashIndex]);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideSlash();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    if (desktopSettings.enterToSend === false) return;
    e.preventDefault();
    void send();
  }
});

ui.thread?.addEventListener("keydown", (event) => {
  const groupHead = event.target.closest(".tool-group-head");
  if (groupHead && event.key === "ArrowDown") {
    const first = groupHead.parentElement?.querySelector(".tool-card-head");
    if (first) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  const head = event.target.closest(".tool-card-head, .diff-card-head, .thought-head");
  if (!head) return;
  if (event.key === "ArrowRight" && head.getAttribute("aria-expanded") === "false") {
    event.preventDefault();
    head.click();
    return;
  }
  if (event.key === "ArrowLeft" && head.getAttribute("aria-expanded") === "true") {
    event.preventDefault();
    head.click();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const pane = head.closest(".thread-inner") || ui.thread;
  const heads = [...pane.querySelectorAll(".thought-head, .tool-group-head, .tool-card-head, .diff-card-head")]
    .filter((item) => item.offsetParent !== null);
  if (!heads.length) return;
  event.preventDefault();
  const current = heads.indexOf(head);
  const index = a11y.nextMenuIndex?.(current, heads.length, event.key) ?? current;
  heads[Math.max(0, index)]?.focus();
});

// Session list right-click → real context menu
ui.list.addEventListener("contextmenu", (e) => {
  const row = e.target.closest(".session-row");
  if (!row?.dataset.sessionId) return;
  e.preventDefault();
  showSessionCtx(e.clientX, e.clientY, row.dataset.sessionId, row);
});

ui.list.addEventListener("keydown", (e) => {
  if (!(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
  const row = e.target.closest(".session-row");
  if (!row?.dataset.sessionId) return;
  e.preventDefault();
  const rect = row.getBoundingClientRect();
  showSessionCtx(rect.left + Math.min(28, rect.width / 2), rect.top + Math.min(28, rect.height), row.dataset.sessionId, row);
});

$("session-ctx")?.addEventListener("keydown", (event) => {
  a11y.handleMenuKey?.($("session-ctx"), event, { onEscape: hideSessionCtx });
});

$("session-ctx")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn || !ctxSessionId) return;
  const id = ctxSessionId;
  const act = btn.dataset.act;
  hideSessionCtx();
  const s = sessions.find((x) => x.id === id);
  try {
    if (act === "open") {
      if (view !== "chat") switchView("chat");
      void selectSession(id);
    } else if (act === "pin") {
      await togglePinSession(id);
    } else if (act === "rename") {
      await renameSessionUi(id, s?.title || "");
    } else if (act === "export") {
      const r = await grokDesktop.exportSession(id);
      if (r?.ok) flashToast("已导出");
      else if (!r?.cancelled) flashToast(r?.error || "导出取消");
    } else if (act === "call") {
      if (!activeId) {
        flashToast("先打开一个对话");
        return;
      }
      if (id === activeId) {
        flashToast("不能调用当前会话");
        return;
      }
      const prefix = `/call ${id} `;
      ui.input.value = prefix;
      autosize();
      ui.input.focus();
      const pos = prefix.length;
      ui.input.setSelectionRange(pos, pos);
      flashToast("写任务后发送，当前会话会盯着对方进度");
    } else if (act === "copy-id") {
      await copyText(id);
      flashToast("已复制会话 ID");
    } else if (act === "copy-title") {
      await copyText(s?.title || id);
      flashToast("已复制标题");
    } else if (act === "copy-cwd") {
      if (!s?.cwd) {
        flashToast("无工作目录");
        return;
      }
      await copyText(s.cwd);
      flashToast("已复制工作目录");
    } else if (act === "reveal") {
      const info = await grokDesktop.sessionPath?.(id);
      if (!info?.ok || !info.path) {
        flashToast(info?.error || "找不到会话目录");
        return;
      }
      await grokDesktop.showItem?.(info.path);
    } else if (act === "archive") {
      await toggleArchiveSession(id);
    } else if (act === "delete") {
      const ok = await askConfirm({
        title: "删除会话",
        message: `确定删除「${s?.title || id}」？此操作不可恢复。`,
        okLabel: "删除",
        danger: true,
      });
      if (!ok) return;
      await deleteSessionUi(id, { persistLists: true });
      schedulePersistTabs();
    }
  } catch (err) {
    flashToast(err.message || String(err));
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#session-ctx")) hideSessionCtx({ restore: false });
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideSessionCtx();
  if (planOpen) setPlanOpen(false);
});


// keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  // Ctrl/Cmd+Tab · Ctrl/Cmd+Shift+Tab — cycle parallel session tabs
  if (mod && e.key === "Tab") {
    if (openTabs.length >= 2) {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
  }
  // Ctrl/Cmd+K — global session/content search
  if (mod && (e.key === "k" || e.key === "K") && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (view !== "chat") switchView("chat");
    requestAnimationFrame(() => {
      ui.search?.focus();
      ui.search?.select();
    });
    return;
  }
  // Ctrl/Cmd+N — new session
  if (mod && (e.key === "n" || e.key === "N") && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    void newSession();
    return;
  }
  // Ctrl/Cmd+, — settings
  if (mod && (e.key === "," || e.code === "Comma")) {
    e.preventDefault();
    switchView("settings");
    return;
  }
  // Ctrl/Cmd+P — plan panel
  if (mod && (e.key === "p" || e.key === "P") && !e.shiftKey) {
    if (activeId && view === "chat") {
      e.preventDefault();
      setPlanOpen(!planOpen);
      return;
    }
  }
  // Ctrl/Cmd+W — close current agent tab (not delete session); works even in inputs
  if (mod && (e.key === "w" || e.key === "W") && activeId && openTabs.includes(activeId)) {
    if (view === "chat" || view === "settings") {
      e.preventDefault();
      const id = activeId;
      void (async () => {
        try {
          await grokDesktop.closeAgent?.(id);
        } catch {
          /* ignore */
        }
        stashComposer(id);
        removeOpenTab(id);
        const next = openTabs[0];
        if (next) void selectSession(next);
        else showWelcome();
      })();
      return;
    }
  }
  // Digit shortcuts Ctrl+1..9 jump open tabs
  if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key) && openTabs.length) {
    const idx = Number(e.key) - 1;
    if (openTabs[idx]) {
      e.preventDefault();
      void selectSession(openTabs[idx]);
      return;
    }
  }
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    newSession();
  }
  // P — toggle plan panel when a session is open (legacy single-key)
  if ((e.key === "p" || e.key === "P") && activeId && view === "chat") {
    e.preventDefault();
    setPlanOpen(!planOpen);
  }
});

// ── 环境诊断 / 首次引导 / 更新 ─────────────────────────

/** Last diagnose payload (for copy path / settings health card). */
let lastCliDiag = null;

async function runDiagnose() {
  try {
    const d = await grokDesktop.diagnose();
    lastCliDiag = d;
    return d;
  } catch (err) {
    const d = {
      ok: false,
      cliExists: false,
      loggedIn: false,
      authHint: err.message || String(err),
      installHint: "无法完成检测",
    };
    lastCliDiag = d;
    return d;
  }
}

/**
 * Paint Settings → Environment health card + sidebar CLI chip.
 * Shell-first UX: users shouldn't need a terminal to know if things work.
 */
function renderCliHealth(diag) {
  if (!diag) return;
  lastCliDiag = diag;

  const state = !diag.cliExists
    ? "bad"
    : !diag.loggedIn
      ? "warn"
      : "ok";

  const pill = $("cli-health-pill");
  if (pill) {
    pill.dataset.state = state;
    pill.textContent =
      state === "ok"
        ? t("settings.cliHealthOk")
        : state === "warn"
          ? t("settings.cliHealthWarn")
          : t("settings.cliHealthBad");
  }

  const summary = $("cli-health-summary");
  if (summary) {
    summary.textContent =
      state === "ok"
        ? t("settings.cliHealthDesc")
        : state === "warn"
          ? diag.loginHint || diag.authHint || t("settings.cliHealthWarn")
          : diag.installHint || t("settings.cliHealthBad");
  }

  const setItem = (key, itemState, detail) => {
    const li = document.querySelector(`.health-item[data-key="${key}"]`);
    if (li) li.dataset.state = itemState;
    const p = $(
      key === "cli"
        ? "cli-health-cli-detail"
        : key === "login"
          ? "cli-health-login-detail"
          : "cli-health-desktop-detail",
    );
    if (p) p.textContent = detail || "—";
  };

  setItem(
    "cli",
    diag.cliExists ? "ok" : "bad",
    diag.cliExists
      ? `${diag.cli || "grok"}${diag.cliVersion ? " · " + diag.cliVersion : ""}`
      : "未找到 grok 可执行文件",
  );
  setItem(
    "login",
    diag.loggedIn ? "ok" : diag.cliExists ? "warn" : "bad",
    diag.authHint || (diag.loggedIn ? "已登录" : "未登录"),
  );
  setItem(
    "desktop",
    "ok",
    diag.desktopVersion ? `v${diag.desktopVersion}` : "—",
  );

  const hint = $("cli-health-hint");
  if (hint) {
    const lines = [];
    if (diag.installHint) lines.push(diag.installHint);
    if (diag.loginHint) lines.push(diag.loginHint);
    if (diag.ok) lines.push(t("settings.cliHealthOk") + " — 可以开始新对话。");
    hint.textContent = lines.join("\n");
  }

  // Path rows
  if ($("set-cli") && diag.cli) $("set-cli").textContent = diag.cli;
  if ($("set-grok-home") && diag.grokHome)
    $("set-grok-home").textContent = diag.grokHome;
  if ($("set-desktop-ver") && diag.desktopVersion)
    $("set-desktop-ver").textContent = diag.desktopVersion;

  // Sidebar chip
  if (ui.cliInfo) {
    ui.cliInfo.dataset.state = state;
    if (!diag.cliExists) {
      ui.cliInfo.textContent = "未检测到 grok CLI";
      ui.cliInfo.title =
        (diag.installHint || "") + "\n" + t("settings.cliHealthDesc");
    } else {
      const ver = diag.cliVersion ? String(diag.cliVersion).replace(/^v/i, "") : "";
      ui.cliInfo.textContent = ver
        ? `CLI 就绪 · ${ver}`
        : diag.loggedIn
          ? "CLI 就绪"
          : "CLI 已找到 · 未登录";
      ui.cliInfo.title = [
        `CLI: ${diag.cli}`,
        diag.authHint || "",
        `Home: ${diag.grokHome || ""}`,
        "点击查看环境健康",
      ]
        .filter(Boolean)
        .join("\n");
    }
  }
}

function renderSetupChecks(diag) {
  const ul = $("setup-checks");
  const hint = $("setup-hint");
  if (!ul) return;
  ul.replaceChildren();
  const items = [
    {
      ok: !!diag.cliExists,
      title: "Grok CLI",
      detail: diag.cliExists
        ? `${diag.cli || "已找到"}${diag.cliVersion ? " · " + diag.cliVersion : ""}`
        : "未找到 grok 可执行文件",
    },
    {
      ok: !!diag.loggedIn,
      title: "登录状态",
      detail: diag.authHint || (diag.loggedIn ? "已登录" : "未登录"),
    },
  ];
  for (const it of items) {
    const li = document.createElement("li");
    li.className = it.ok ? "ok" : "bad";
    li.innerHTML = `<span class="ck">${it.ok ? "✓" : "!"}</span><div><strong></strong><p></p></div>`;
    li.querySelector("strong").textContent = it.title;
    li.querySelector("p").textContent = it.detail;
    ul.appendChild(li);
  }
  if (hint) {
    const lines = [];
    if (diag.installHint) lines.push(diag.installHint);
    if (diag.loginHint) lines.push(diag.loginHint);
    if (diag.ok) lines.push("环境正常，可以开始使用。");
    hint.textContent = lines.join("\n");
  }
}

let setupReturnFocus = null;

async function showSetupIfNeeded(force = false) {
  const overlay = $("setup-overlay");
  if (!overlay) return;
  const diag = await runDiagnose();
  renderCliHealth(diag);
  // 首次必出；之后仅 CLI 缺失或手动「环境检测」时再弹（登录缺失不反复打断）
  const need =
    force || !desktopSettings.setupDismissed || !diag.cliExists;
  if (!need) {
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    syncModalInert();
    return diag;
  }
  renderSetupChecks(diag);
  if (overlay.classList.contains("hidden")) setupReturnFocus = document.activeElement;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  syncModalInert();
  requestAnimationFrame(() => {
    (overlay.querySelector("button.primary") || overlay.querySelector("button"))?.focus();
  });
  return diag;
}

function hideSetup(permanent) {
  const overlay = $("setup-overlay");
  overlay?.classList.add("hidden");
  overlay?.setAttribute("aria-hidden", "true");
  syncModalInert();
  a11y.restoreFocus?.(setupReturnFocus);
  setupReturnFocus = null;
  if (permanent) {
    desktopSettings.setupDismissed = true;
    void grokDesktop.saveDesktopSettings({ setupDismissed: true }).catch(() => {});
  }
}

$("setup-overlay")?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    hideSetup(false);
    return;
  }
  if (event.key === "Tab") a11y.trapTabKey?.($("setup-overlay"), event);
});

async function checkForUpdates(manual = false) {
  const desc = $("update-check-desc");
  const banner = $("update-banner");
  const text = $("update-banner-text");
  if (!manual && desktopSettings.checkUpdates === false) return;
  try {
    if (desc && manual) desc.textContent = t("update.checking");
    const r = await grokDesktop.checkUpdate();
    if (!r?.ok) {
      const error = r?.errorCode === "timeout" ? t("update.timeout") : r?.error || "network";
      if (desc)
        desc.textContent = manual
          ? t("update.fail", { error })
          : desc.textContent;
      return;
    }
    if (r.hasUpdate) {
      const msg = t("update.found", { latest: r.latest, current: r.current });
      if (desc) desc.textContent = msg;
      if (banner && text) {
        text.textContent = msg;
        banner.dataset.url = r.url || "";
        banner.classList.remove("hidden");
      }
    } else if (manual && desc) {
      desc.textContent = t("update.latest", { current: r.current });
    }
  } catch (err) {
    if (manual && desc) desc.textContent = err.message || String(err);
  }
}

$("setup-recheck")?.addEventListener("click", async () => {
  const diag = await runDiagnose();
  renderSetupChecks(diag);
});
$("setup-continue")?.addEventListener("click", () => hideSetup(true));
$("setup-open-cli-doc")?.addEventListener("click", () => {
  void grokDesktop.openExternal?.("https://x.ai/cli");
});
// Developer card links (Settings → About)
function openDevUrl(el) {
  const url = el?.dataset?.url || el?.getAttribute?.("data-url");
  if (url) void grokDesktop.openExternal?.(url);
}
$("dev-github-profile")?.addEventListener("click", (e) => {
  e.preventDefault();
  openDevUrl(e.currentTarget);
});
["btn-dev-feedback", "btn-dev-sponsor", "btn-dev-repo", "btn-dev-releases"].forEach((id) => {
  $(id)?.addEventListener("click", (e) => openDevUrl(e.currentTarget));
});

// Chat message links → system browser (not inside Electron)
document.addEventListener(
  "click",
  (e) => {
    const a = e.target?.closest?.("a.msg-link");
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute("href") || a.href || "";
    if (/^https?:\/\//i.test(href)) {
      void grokDesktop.openExternal?.(href);
    }
  },
  true,
);

$("btn-check-update")?.addEventListener("click", () => void checkForUpdates(true));
$("btn-run-diagnose")?.addEventListener("click", async () => {
  const diag = await showSetupIfNeeded(true);
  if (diag?.ok) {
    const desc = $("update-check-desc");
    if (desc) desc.textContent = "环境正常：CLI 与登录均已就绪";
  }
});
$("btn-export-diagnostics")?.addEventListener("click", async () => {
  const button = $("btn-export-diagnostics");
  if (button) button.disabled = true;
  try {
    const result = await grokDesktop.exportDiagnostics?.();
    if (result?.ok) flashToast(t("settings.exportDiagnosticsDone"));
  } catch (error) {
    flashToast(error?.message || "诊断包导出失败");
  } finally {
    if (button) button.disabled = false;
  }
});
$("btn-health-recheck")?.addEventListener("click", async () => {
  const btn = $("btn-health-recheck");
  const pill = $("cli-health-pill");
  if (pill) {
    pill.dataset.state = "unknown";
    pill.textContent = t("settings.cliHealthChecking");
  }
  if (btn) btn.disabled = true;
  try {
    const diag = await runDiagnose();
    renderCliHealth(diag);
    renderSetupChecks(diag);
  } finally {
    if (btn) btn.disabled = false;
  }
});
$("btn-health-cli-doc")?.addEventListener("click", () => {
  void grokDesktop.openExternal?.("https://x.ai/cli");
});
$("btn-health-copy-path")?.addEventListener("click", async () => {
  const path = lastCliDiag?.cli || $("set-cli")?.textContent || "";
  const hint = $("cli-health-hint");
  if (!path || path === "—") {
    if (hint) hint.textContent = t("settings.cliHealthNoPath");
    return;
  }
  try {
    await navigator.clipboard.writeText(path);
    if (hint) hint.textContent = t("settings.cliHealthCopied") + "：\n" + path;
  } catch {
    if (hint) hint.textContent = path;
  }
});
// Sidebar footer: click → jump to Environment settings + refresh health
ui.openCmd?.addEventListener("click", async (e) => {
  e.stopPropagation();
  try {
    await grokDesktop.openWorkspaceCli();
  } catch (err) {
    appendBanner(`打开终端失败：${err.message || err}`, "error");
  }
});
ui.cliInfo?.addEventListener("click", async () => {
  try {
    // Switch to settings about section if nav exists
    $("nav-settings")?.click();
    const aboutNav = document.querySelector(
      '.settings-nav .sn-item[data-panel="about"]',
    );
    aboutNav?.click();
    const card = $("cli-health-card");
    card?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  } catch {
    /* ignore */
  }
  const diag = await runDiagnose();
  renderCliHealth(diag);
});
$("update-banner-open")?.addEventListener("click", () => {
  const url =
    $("update-banner")?.dataset?.url ||
    "https://github.com/AvaterXXX/grok-desktop/releases";
  void grokDesktop.openExternal?.(url);
});
$("update-banner-dismiss")?.addEventListener("click", () => {
  $("update-banner")?.classList.add("hidden");
});

// ── Boot ───────────────────────────────────────────────

function bindPinnedPrompt() {
  ui.pinnedPromptBtn?.addEventListener("click", () => scrollToLastUserPrompt());
}

(async function boot() {
  bootMark("boot IIFE start");
  const qw = document.getElementById("quota-week");
  if (qw) qw.hidden = false;
  const qr = document.getElementById("quota-reset");
  if (qr && !qr.textContent) qr.textContent = "刷新 —";
  if (qr) qr.hidden = false;
  const qt = document.getElementById("quota-today");
  if (qt && !qt.textContent) qt.textContent = "当日 —";
  if (qt) qt.hidden = false;
  try {
    const info = await grokDesktop.appInfo();
    ui.cliInfo.textContent = `${info.grokCli || "grok"} · v${info.desktopVersion || "0.8"}`;
    ui.cliInfo.title = `CLI: ${info.grokCli}\nHome: ${info.grokHome}`;
    bootMark("appInfo");
  } catch {
    ui.cliInfo.textContent = "CLI not found";
  }
  try {
    const s = await grokDesktop.getSettings();
    desktopSettings = { ...desktopSettings, ...(s.desktop || {}) };
    applyThinkingVisibility();
    const grok = s.grok || {};
    desktopSettings.accessMode = deriveAccessMode(desktopSettings, grok);
    applyModelCatalog(s.models);
    currentEffort = DEFAULT_EFFORT;
    const pref = resolvePreferredModelId();
    if (pref) currentModelId = currentModelId || pref;
    syncModelChip();
    applyProxyForm(desktopSettings);
    applyDensity(desktopSettings.density);
    applyTheme(desktopSettings.theme);
    applyWallpaper();
    applyLocale(desktopSettings.locale === "en" ? "en" : desktopSettings.locale || GrokI18n?.detectLocale?.() || "zh");
    setAccessModeUi(desktopSettings.accessMode);
    void hydrateProfileAvatar().then(() => refreshTurnWho());
    const cachedUsage = usageFromDesktop(desktopSettings);
    if (cachedUsage) paintAccountUsage(cachedUsage);
    bootMark("getSettings+theme");
  } catch {
    if (window.GrokI18n) GrokI18n.applyI18n(document);
    applyTheme("dark");
  }
  bindSidebarResize();
  bindPinnedPrompt();
  wireWallpaperUi();
  // Theme / density: apply + save immediately (no need to hit 保存更改)
  void refreshAccountUsage();
  setTimeout(() => void refreshAccountUsage(), 2500);
  setInterval(() => void refreshAccountUsage(), 30 * 60 * 1000);
  $("set-theme")?.addEventListener("change", () => {
    void persistTheme($("set-theme").value || "dark");
  });
  $("palette-grid")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-palette]");
    if (!b) return;
    void persistPalette(b.getAttribute("data-palette"));
  });
  $("palette-grid")?.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...$("palette-grid").querySelectorAll("[data-palette]")];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const key = event.key === "ArrowRight" ? "ArrowDown" : event.key === "ArrowLeft" ? "ArrowUp" : event.key;
    const index = a11y.nextMenuIndex?.(current, buttons.length, key) ?? current;
    const next = buttons[Math.max(0, index)];
    next?.focus();
    if (next?.dataset.palette) void persistPalette(next.dataset.palette);
  });
  $("set-density")?.addEventListener("change", () => {
    const d = $("set-density").value || "comfortable";
    desktopSettings.density = d;
    applyDensity(d);
    void grokDesktop.saveDesktopSettings({ density: d }).catch(() => {});
  });
  const persistProxy = () => {
    const proxyUrl = ($("set-proxy")?.value || "").trim();
    const proxyEnabled = !!$("set-proxy-on")?.checked;
    desktopSettings.proxyUrl = proxyUrl;
    desktopSettings.proxyEnabled = proxyEnabled;
    refreshProxyUi();
    void grokDesktop.saveDesktopSettings({ proxyUrl, proxyEnabled }).catch(() => {});
  };
  $("set-proxy")?.addEventListener("input", persistProxy);
  $("set-proxy")?.addEventListener("change", persistProxy);
  $("set-proxy")?.addEventListener("blur", persistProxy);
  $("set-proxy-on")?.addEventListener("change", persistProxy);
  // Follow system theme when preference is "system"
  try {
    window
      .matchMedia?.("(prefers-color-scheme: dark)")
      ?.addEventListener?.("change", () => {
        if (desktopSettings.theme === "system") applyTheme("system");
      });
  } catch {
    /* ignore */
  }
  await loadWallpaperAssets();
  applyWallpaper();
  updateAccessChip();

  // 首次 / 环境异常 → 引导
  await showSetupIfNeeded(false);
  bootMark("setup");
  // 后台检查更新（不挡启动）
  void checkForUpdates(false);

  showWelcome();
  await refreshSessions();
  setStatus("idle", "就绪");
  // Sticky follow + content-resize re-scroll (fixes mid-stream stuck scroll)
  wireThreadScrollFollow();

  window.addEventListener("pagehide", () => {
    flushPendingSessionUi();
    void persistOpenTabs();
  });
  window.addEventListener("beforeunload", () => {
    flushPendingSessionUi();
    void persistOpenTabs();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void persistOpenTabs();
  });

  // Restore the chat we left on, else the newest one.
  try {
    const known = new Set(sessions.map((s) => s.id));
    const savedTabs = Array.isArray(desktopSettings.openTabs)
      ? desktopSettings.openTabs.filter((id) => known.has(id))
      : [];
    const last = desktopSettings.lastActiveId && known.has(desktopSettings.lastActiveId)
      ? desktopSettings.lastActiveId
      : "";
    const newest = sessions[0]?.id || "";
    const prefer = last || newest || savedTabs[0] || "";
    if (prefer && !savedTabs.includes(prefer)) savedTabs.unshift(prefer);
    if (savedTabs.length) {
      openTabs = savedTabs.slice(0, 12);
    }
    if (prefer) {
      void selectSession(prefer);
      bootMark("selectSession kick " + prefer);
    }
  } catch {
    /* ignore restore errors */
  }

  setInterval(() => {
    if (view === "chat" && sessions.length > 0 && ui.list.childElementCount === 0) {
      renderSidebar(ui.search.value);
    }
  }, 2500);
  bootMark("boot IIFE done");
})();


let lastAccountUsage = null;
let usageHeatMode = "day";

function usageFromDesktop(desk) {
  if (!desk) return null;
  const b = desk.lastBilling || {};
  const today = typeof shanghaiTodayKey === "function" ? shanghaiTodayKey() : "";
  const daily = desk.dailyUsage && (!today || desk.dailyUsage.date === today) ? desk.dailyUsage : (desk.dailyUsage || {});
  if (b.percent == null && !b.reset && daily.tokens == null) return null;
  const hist = desk.dailyHistory || {};
  let weekStart = null;
  if (b.periodStart) {
    const ps = new Date(b.periodStart);
    if (!Number.isNaN(ps.getTime())) weekStart = ps;
  }
  if (!weekStart && b.resetAt) {
    const end = new Date(b.resetAt);
    if (!Number.isNaN(end.getTime())) weekStart = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  }
  const weekFrom = weekStart
    ? weekStart.toLocaleString("en-CA", { timeZone: "Asia/Shanghai" }).slice(0, 10)
    : "";
  const weekKey = weekStart ? weekStart.toISOString() : "";
  const stored = desk.weekUsage;
  let weekTokens = 0, weekInput = 0, weekOutput = 0, weekCache = 0, weekReasoning = 0;
  if (stored && stored.from && stored.from === weekKey) {
    weekTokens = Number(stored.tokens) || 0;
    weekInput = Number(stored.input) || 0;
    weekOutput = Number(stored.output) || 0;
    weekCache = Number(stored.cache) || 0;
    weekReasoning = Number(stored.reasoning) || 0;
  } else {
    for (const [d, slot] of Object.entries(hist)) {
      if (weekStart && d <= weekFrom) continue;
      if (weekFrom && d < weekFrom) continue;
      if (today && d > today) continue;
      weekTokens += Number(slot.tokens) || 0;
      weekInput += Number(slot.input) || 0;
      weekOutput += Number(slot.output) || 0;
      weekCache += Number(slot.cache) || 0;
      weekReasoning += Number(slot.reasoning) || 0;
    }
  }
  return {
    ok: true,
    percent: b.percent ?? null,
    reset: b.reset || "",
    resetAt: b.resetAt || "",
    subscriptionTier: b.subscriptionTier || "",
    raw: b.raw || "",
    source: "cache",
    dailyTokens: daily.tokens,
    dailyInput: daily.input,
    dailyOutput: daily.output,
    dailyCache: daily.cache,
    dailyReasoning: daily.reasoning,
    dailyByModel: daily.byModel || {},
    history: hist,
    weekTokens,
    weekInput,
    weekOutput,
    weekCache,
    weekReasoning,
  };
}

function paintAccountUsage(u) {
  if (u && (u.ok === false && u.percent == null && u.dailyTokens == null)) {
    u = lastAccountUsage || u;
  }
  if (u && lastAccountUsage) {
    lastAccountUsage = { ...lastAccountUsage, ...u };
    u = lastAccountUsage;
  } else {
    lastAccountUsage = u || lastAccountUsage;
  }
  const week = document.getElementById("quota-week");
  const reset = document.getElementById("quota-reset");
  const daily = document.getElementById("quota-daily");
  const todayEl = document.getElementById("quota-today");
  const fill = document.getElementById("quota-week-fill");
  const pctEl = document.getElementById("quota-week-pct");
  if (!week) return;
  week.hidden = false;
  if (u?.percent != null) {
    const p = Math.max(0, Math.min(100, Number(u.percent) || 0));
    const label = Number.isInteger(p) ? String(p) : p.toFixed(1).replace(/\.0$/, "");
    if (pctEl) pctEl.textContent = label + "%";
    if (fill) fill.style.width = p + "%";
    week.classList.toggle("warn", p >= 75);
    week.classList.toggle("hot", p >= 90);
    week.title = "本周已用 " + label + "%";
  }
  if (reset && (u?.reset || u?.resetAt)) {
    reset.hidden = false;
    reset.textContent = "刷新 " + (u.reset || u.resetAt);
    if (u.resetAt) reset.title = u.resetAt;
  }
  const weekTok = Number(u?.weekTokens);
  const hasWeek = Number.isFinite(weekTok) && (weekTok > 0 || u?.weekInput || u?.weekOutput);
  if (daily && hasWeek) {
    daily.hidden = false;
    daily.replaceChildren();
    const parts = ["本周 " + formatTokens(weekTok)];
    if (u.weekInput) parts.push("入 " + formatTokens(u.weekInput));
    if (u.weekOutput) parts.push("出 " + formatTokens(u.weekOutput));
    if (u.weekCache) parts.push("缓存 " + formatTokens(u.weekCache));
    const text = document.createElement("span");
    text.className = "quota-daily-text";
    text.textContent = parts.join(" · ");
    daily.appendChild(text);
    const weekUsd = estimateApiUsd({
      input: u.weekInput,
      output: u.weekOutput,
      cache: u.weekCache,
      modelId: currentModelId,
    });
    const money = formatUsd(weekUsd);
    if (money) {
      daily.appendChild(document.createTextNode(" · "));
      const usdEl = document.createElement("span");
      usdEl.className = "quota-daily-usd";
      usdEl.textContent = money;
      usdEl.title = "本周估算";
      usdEl.onmouseenter = () => showQuotaCostTip(usdEl, ["本周  " + money]);
      usdEl.onmouseleave = hideQuotaCostTip;
      daily.appendChild(usdEl);
    }
    daily.title = "本周已用 token";
  } else if (daily) {
    daily.hidden = true;
  }
  if (todayEl && u?.dailyTokens != null) {
    todayEl.hidden = false;
    todayEl.textContent = "当日 " + formatTokens(u.dailyTokens);
    todayEl.title = [
      u.dailyInput ? "入 " + formatTokens(u.dailyInput) : "",
      u.dailyOutput ? "出 " + formatTokens(u.dailyOutput) : "",
      u.dailyCache ? "缓存 " + formatTokens(u.dailyCache) : "",
    ].filter(Boolean).join(" · ");
  } else if (todayEl) {
    todayEl.hidden = true;
  }
  renderUsageHeat(u);
  if (week.parentElement) {
    week.parentElement.title = [u?.subscriptionTier, u?.raw, u?.source].filter(Boolean).join(" · ");
  }
}

function shanghaiTodayKey() {
  return new Date().toLocaleString("en-CA", { timeZone: "Asia/Shanghai" }).slice(0, 10);
}

function dayKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function heatLevel(n, max) {
  if (!n) return 0;
  if (!max) return 1;
  const r = n / max;
  if (r < 0.15) return 1;
  if (r < 0.35) return 2;
  if (r < 0.65) return 3;
  return 4;
}

function formatHeatDay(key) {
  const p = String(key || "").split("-");
  if (p.length !== 3) return key;
  return Number(p[1]) + "月" + Number(p[2]) + "日";
}

function renderUsageHeat(u) {
  const host = $("usage-heat");
  if (!host) return;
  const history = (u && u.history) || (lastAccountUsage && lastAccountUsage.history) || {};
  const today = shanghaiTodayKey();
  const vals = Object.values(history).map((x) => Number(x?.tokens) || 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  const peak = vals.reduce((a, b) => Math.max(a, b), 0);
  const todayN = Number(history[today]?.tokens || u?.dailyTokens || 0);
  const setTxt = (id, n) => {
    const el = $(id);
    if (el) el.textContent = formatTokens(n || 0);
  };
  setTxt("usage-sum", sum);
  setTxt("usage-peak", peak);
  setTxt("usage-today", todayN);

  const todayDate = new Date(today + "T00:00:00");
  const year = todayDate.getFullYear();
  const start = new Date(year, 0, 1);
  const startWd = (start.getDay() + 6) % 7;
  if (startWd) start.setDate(start.getDate() + (7 - startWd));
  const yearEnd = new Date(year, 11, 31);
  const gridEnd = new Date(yearEnd);
  const endWd = (gridEnd.getDay() + 6) % 7;
  if (endWd !== 6) gridEnd.setDate(gridEnd.getDate() + (6 - endWd));

  const weekSums = {};
  let running = 0;
  const days = [];
  for (let d = new Date(start); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    const key = dayKeyFromDate(d);
    const tok = Number(history[key]?.tokens) || 0;
    running += tok;
    const wk = Math.floor((d - start) / 86400000 / 7);
    weekSums[wk] = (weekSums[wk] || 0) + tok;
    days.push({ key, date: new Date(d), tokens: tok, cum: running, week: wk });
  }
  const maxDay = days.reduce((m, x) => Math.max(m, x.tokens), 0);
  const maxWeek = Object.values(weekSums).reduce((m, x) => Math.max(m, x), 0);
  const maxCum = running;

  host.replaceChildren();
  const weeks = Math.max(1, Math.ceil(days.length / 7));
  const months = document.createElement("div");
  months.className = "usage-heat-months";
  months.style.setProperty("--heat-cols", String(weeks));
  const ranges = [];
  let lastM = -1;
  for (let w = 0; w < weeks; w++) {
    const cell = days[w * 7];
    if (!cell) continue;
    const m = cell.date.getMonth();
    const y = cell.date.getFullYear();
    if (y !== year) continue;
    if (m !== lastM) {
      ranges.push({ start: w + 1, label: (m + 1) + "月" });
      lastM = m;
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    const colEnd = i + 1 < ranges.length ? ranges[i + 1].start : weeks + 1;
    if (colEnd - ranges[i].start < 2) continue;
    const lab = document.createElement("span");
    lab.textContent = ranges[i].label;
    lab.style.gridColumn = ranges[i].start + " / " + colEnd;
    months.appendChild(lab);
  }
  host.appendChild(months);

  const grid = document.createElement("div");
  grid.className = "usage-heat-grid";
  grid.style.setProperty("--heat-cols", String(weeks));
  const mode = usageHeatMode;
  for (const item of days) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "usage-heat-cell";
    let n = item.tokens;
    let max = maxDay;
    if (mode === "week") {
      n = weekSums[item.week] || 0;
      max = maxWeek;
    } else if (mode === "all") {
      n = item.cum;
      max = maxCum;
    }
    if (item.key > today) {
      cell.dataset.lv = "0";
      cell.dataset.future = "1";
    } else {
      cell.dataset.lv = String(heatLevel(n, max));
    }
    const label = formatHeatDay(item.key) + " 用了 " + formatTokens(n) + " Token";
    cell.title = label;
    cell.setAttribute("aria-label", label);
    grid.appendChild(cell);
  }
  host.appendChild(grid);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".usage-tab");
  if (!btn) return;
  usageHeatMode = btn.getAttribute("data-heat") || "day";
  document.querySelectorAll(".usage-tab").forEach((b) => b.classList.toggle("active", b === btn));
  renderUsageHeat(lastAccountUsage);
});

async function refreshAccountUsage(extra) {
  const _t = Date.now();
  if (!grokDesktop.accountUsage) {
    if (lastAccountUsage) paintAccountUsage(lastAccountUsage);
    else {
      const cached = usageFromDesktop(desktopSettings);
      if (cached) paintAccountUsage(cached);
    }
    bootMark("accountUsage missing-bridge");
    return;
  }
  try {
    const u = await grokDesktop.accountUsage(extra);
    if (u && (u.percent != null || u.reset || u.dailyTokens != null || u.ok)) {
      paintAccountUsage(u);
    } else if (lastAccountUsage) {
      paintAccountUsage(lastAccountUsage);
    }
    bootMark("accountUsage " + (Date.now() - _t) + "ms");
  } catch {
    if (lastAccountUsage) paintAccountUsage(lastAccountUsage);
    bootMark("accountUsage fail " + (Date.now() - _t) + "ms");
  }
}


function bindSidebarResize() {
  const handle = document.getElementById("sidebar-resizer");
  const side = document.getElementById("sidebar");
  if (!handle || !side) return;
  const MIN = 200;
  const MAX = 480;
  const apply = (w) => {
    const n = Math.max(MIN, Math.min(MAX, Math.round(w)));
    document.documentElement.style.setProperty("--side-w", n + "px");
    handle.setAttribute("aria-valuenow", String(n));
    return n;
  };
  const save = (n) => {
    try { localStorage.setItem("gd-side-w", String(n)); } catch {}
  };
  let startX = 0;
  let startW = 0;
  const onMove = (e) => {
    apply(startW + (e.clientX - startX));
  };
  const onUp = () => {
    document.body.classList.remove("sidebar-resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    const n = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--side-w"), 10);
    if (n) save(n);
  };
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.clientX;
    startW = side.getBoundingClientRect().width;
    document.body.classList.add("sidebar-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  handle.addEventListener("keydown", (event) => {
    const current = side.getBoundingClientRect().width;
    let next = null;
    if (event.key === "ArrowLeft") next = current - (event.shiftKey ? 40 : 10);
    if (event.key === "ArrowRight") next = current + (event.shiftKey ? 40 : 10);
    if (event.key === "Home") next = MIN;
    if (event.key === "End") next = MAX;
    if (next == null) return;
    event.preventDefault();
    save(apply(next));
  });
}
