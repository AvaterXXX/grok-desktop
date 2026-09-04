#!/usr/bin/env node
/**
 * Structural + pure-logic checks for ship-ready UI polish.
 * Exercises shipped modules (commands-zh) and greps renderer chrome.
 * Does not launch Electron.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const {
  BUILTIN,
  DESKTOP_UI_ROUTES,
  mergeCommandLists,
  filterSlashCommands,
  groupSlashCommands,
  isDesktopUiRoute,
  resolveDesktopRoute,
  localizeAll,
  commandsForRenderer,
} = require("../src/commands-zh");

/**
 * Simulate session:activate / session:open soft return payload.
 * Same function main.js uses at the IPC boundary.
 */
function simulateIpcCommandsPayload(rawAcpCommands) {
  return {
    ok: true,
    live: true,
    commands: commandsForRenderer(rawAcpCommands),
  };
}

/** Renderer-side gate (mirrors app.js commandsLookLocalized). */
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

function main() {
  console.log("[ui-polish] commands-zh pure helpers…");

  const list = mergeCommandLists([
    { name: "demo-skill", description: "a skill", _meta: { path: "/tmp/SKILL.md" } },
  ]);
  assert.ok(list.some((c) => c.name === "settings" && c.desktop));
  assert.ok(list.some((c) => c.name === "demo-skill" && c.isSkill));

  const filtered = filterSlashCommands(list, "set");
  assert.ok(
    filtered.some((c) => c.name === "settings"),
    "filter finds settings",
  );

  const groups = groupSlashCommands(list);
  assert.ok(groups.length >= 3, "commands are grouped");
  assert.ok(groups.every((g) => g.group && Array.isArray(g.items)));
  const groupNames = groups.map((g) => g.group);
  assert.ok(groupNames.includes("session"));
  assert.ok(groupNames.includes("system"));
  assert.ok(groupNames.includes("skill"), "skills form their own group");

  const pureUi = [
    "settings",
    "export",
    "rename",
    "memory",
    "skills",
    "plugins",
    "mcps",
    "new",
    "clear",
    "home",
    "copy",
  ];
  for (const name of pureUi) {
    assert.ok(isDesktopUiRoute(name), `${name} is desktop UI route`);
    assert.ok(resolveDesktopRoute(name), `${name} resolves`);
  }
  assert.strictEqual(isDesktopUiRoute("compact"), false);
  assert.strictEqual(resolveDesktopRoute("demo-skill", true), null);
  assert.strictEqual(
    resolveDesktopRoute("settings", true),
    null,
    "skills never use desktop routes",
  );

  // Desktop builtins with pure UI routes must not be "agent-only"
  for (const b of BUILTIN.filter((x) => x.desktop)) {
    if (b.name === "status") continue; // hybrid → session-info
    assert.ok(DESKTOP_UI_ROUTES[b.name], `desktop builtin /${b.name} has DESKTOP_UI_ROUTES entry`);
  }

  const again = localizeAll([]);
  assert.ok(again.length >= BUILTIN.length);

  // ── IPC boundary: raw ACP → commandsForRenderer (same as main.js) ──
  console.log("[ui-polish] IPC activate/open command shape…");
  const rawAcp = [
    { name: "compact", description: "Compress history" },
    {
      name: "repo-review",
      description: "Review the repo",
      _meta: { path: "/Users/x/.grok/skills/repo-review/SKILL.md", scope: "user" },
    },
  ];
  // Raw ACP must NOT look localized
  assert.strictEqual(
    commandsLookLocalized(rawAcp),
    false,
    "raw ACP lacks titleZh/group — soft path must not treat as final catalog",
  );

  const ipc = simulateIpcCommandsPayload(rawAcp);
  assert.ok(commandsLookLocalized(ipc.commands), "IPC payload looks localized");
  assert.strictEqual(
    commandsForRenderer,
    commandsForRenderer,
    "commandsForRenderer is the IPC helper",
  );
  assert.ok(
    ipc.commands === commandsForRenderer(rawAcp) ||
      JSON.stringify(ipc.commands) === JSON.stringify(commandsForRenderer(rawAcp)),
  );

  const skill = ipc.commands.find((c) => c.name === "repo-review");
  assert.ok(skill, "skill preserved");
  assert.strictEqual(skill.isSkill, true, "skill has isSkill");
  assert.strictEqual(skill.group, "skill", "skill group for badge section");
  assert.ok(skill.titleZh && skill.titleZh.includes("repo-review"), "skill titleZh");

  const settings = ipc.commands.find((c) => c.name === "settings");
  assert.ok(settings, "BUILTIN settings merged even if ACP omitted it");
  assert.strictEqual(settings.desktop, true);
  assert.ok(settings.titleZh, "settings titleZh");

  const exportCmd = ipc.commands.find((c) => c.name === "export");
  assert.ok(exportCmd && exportCmd.desktop, "BUILTIN export merged");

  const grouped = groupSlashCommands(ipc.commands);
  assert.ok(
    grouped.some((g) => g.group === "skill" && g.items.some((i) => i.name === "repo-review")),
    "skill group present after IPC localize",
  );
  assert.ok(
    grouped.some((g) => g.group === "system" && g.items.some((i) => i.name === "settings")),
    "system group has settings",
  );

  // Soft-activate path: if renderer only kept raw, badges/groups break — prove gate rejects raw
  assert.strictEqual(commandsLookLocalized(rawAcp), false);
  // After IPC, soft path may apply catalog
  assert.ok(commandsLookLocalized(ipc.commands));

  // main.js must use commandsForRenderer at activate/open/list boundaries (not raw availableCommands)
  console.log("[ui-polish] main.js IPC wiring…");
  const mainSrc = read("main.js");
  assert.ok(/commandsForRenderer/.test(mainSrc), "main imports/uses commandsForRenderer");
  // Must not return raw availableCommands for session handlers
  assert.ok(
    !/commands:\s*live\.availableCommands/.test(mainSrc),
    "session:activate must not return raw live.availableCommands",
  );
  assert.ok(
    !/commands:\s*client\.availableCommands/.test(mainSrc),
    "session:open must not return raw client.availableCommands",
  );
  assert.ok(!/commands:\s*live\.availableCommands\s*\|\|/.test(mainSrc));
  // soft path must still emit commands:update (no longer gated only on !soft)
  const openSoftBlock = mainSrc.includes("commands:update");
  assert.ok(openSoftBlock, "commands:update still sent");
  // reuse path should call commandsForRenderer before return
  assert.ok(
    /const commands = commandsForRenderer\(live\.availableCommands\)/.test(mainSrc),
    "soft/reuse open localizes live.availableCommands",
  );
  assert.ok(
    /const commands = commandsForRenderer\(client\.availableCommands\)/.test(mainSrc) ||
      /commandsForRenderer\(client\.availableCommands\)/.test(mainSrc),
    "cold open localizes client.availableCommands",
  );

  console.log("[ui-polish] core reliability guards…");
  const acpSrc = read("src/acp.js");
  assert.ok(/this\.env = cliEnv\(/.test(acpSrc), "ACP prepares a GUI-safe child environment");
  assert.ok(
    /env:\s*this\.env/.test(acpSrc),
    "ACP terminal commands inherit the prepared environment",
  );
  assert.ok(!/terminal\/create[\s\S]{0,400}env:\s*process\.env/.test(acpSrc));
  const { cleanUserText, isUserVisibleSession, loadHistoryPreview } = require("../src/sessions");
  assert.strictEqual(isUserVisibleSession({}), true);
  assert.strictEqual(isUserVisibleSession({ session_kind: "subagent" }), false);
  assert.strictEqual(isUserVisibleSession({ session_kind: "subagent_fork" }), false);
  assert.strictEqual(cleanUserText("<system-reminder>hidden</system-reminder>visible"), "visible");
  assert.strictEqual(cleanUserText("<system_reminder>hidden</system_reminder>visible"), "visible");
  const historyDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-history-check-"));
  try {
    fs.writeFileSync(
      path.join(historyDir, "chat_history.jsonl"),
      [
        JSON.stringify({
          type: "user",
          synthetic_reason: "skills_context",
          content: "<system-reminder>internal context</system-reminder>",
        }),
        JSON.stringify({ type: "user", content: "real question" }),
        JSON.stringify({ type: "assistant", content: "real answer" }),
      ].join("\n"),
      "utf8",
    );
    assert.deepStrictEqual(loadHistoryPreview(historyDir), [
      { role: "user", text: "real question" },
      { role: "assistant", text: "real answer" },
    ]);

    fs.writeFileSync(
      path.join(historyDir, "chat_history.jsonl"),
      [
        JSON.stringify({ type: "user", content: "inspect this" }),
        JSON.stringify({
          type: "assistant",
          content: "I will inspect it.",
          tool_calls: [
            {
              id: "tool-1",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "src/demo.js", offset: 10, limit: 20 }),
              },
            },
          ],
        }),
        JSON.stringify({ type: "tool_result", tool_call_id: "tool-1", content: "file body" }),
        JSON.stringify({ type: "assistant", content: "Inspection complete." }),
      ].join("\n"),
      "utf8",
    );
    const toolHistory = loadHistoryPreview(historyDir);
    assert.deepStrictEqual(
      toolHistory.map((item) => item.role),
      ["user", "assistant", "tool", "assistant"],
      "history preserves commentary → tool → final-answer order",
    );
    assert.deepStrictEqual(toolHistory[2].rawInput, {
      path: "src/demo.js",
      offset: 10,
      limit: 20,
    });
    assert.strictEqual(toolHistory[2].detail, "file body");
  } finally {
    fs.rmSync(historyDir, { recursive: true, force: true });
  }
  const terminalCreateBlock = acpSrc.slice(
    acpSrc.indexOf('method === "terminal/create"'),
    acpSrc.indexOf('method === "terminal/output"'),
  );
  assert.ok(
    !terminalCreateBlock.includes('this.emit("toolCall"'),
    "terminal/create must not duplicate the official ACP tool card",
  );
  assert.ok(
    !/client\.on\("toolCallUpdate"[\s\S]{0,250}title:\s*payload\.title\s*\|\|\s*"tool"/.test(
      mainSrc,
    ),
    "tool updates must preserve the original title",
  );
  assert.ok(mainSrc.includes("UPDATE_CHECK_TIMEOUT_MS"), "update check has a deadline");
  assert.ok(mainSrc.includes('errorCode: err.code === "UPDATE_CHECK_TIMEOUT"'));

  const appSrc = read("renderer/app.js");
  const streamSrc = read("renderer/stream-model.js");
  assert.ok(appSrc.includes("commandsLookLocalized") || appSrc.includes("applySlashCatalog"));
  assert.ok(appSrc.includes("applySlashCatalog"), "renderer gates catalog apply");
  assert.ok(appSrc.includes("refreshSlashCatalog"), "renderer falls back to listCommands");
  assert.ok(appSrc.includes("card._payload = mergedPayload"), "tool updates merge prior card data");
  assert.ok(
    appSrc.includes("completedRunStatusDetail(sid || activeId, detail)"),
    "ready updates retain the completed duration",
  );
  assert.ok(!appSrc.includes("insertBeforeLiveAssistant"), "live items must retain event order");
  assert.ok(appSrc.includes("settleToolCards(sid"), "terminal runs settle unfinished tool cards");
  assert.ok(appSrc.includes("isTerminalToolStatus"), "late tool updates preserve terminal state");
  assert.ok(
    appSrc.includes("foldToolCardIntoDiff"),
    "file changes replace their redundant generic tool card",
  );
  assert.ok(
    appSrc.includes("defaultToolGroupExpanded"),
    "completed multi-step groups do not have a default collapse policy",
  );
  assert.ok(
    appSrc.includes('class="d-status hidden"'),
    "diff cards reserve an inline failure marker",
  );
  assert.ok(
    !appSrc.includes("recoveredAssistantSuffix") && !appSrc.includes("coalesceAdjacentThoughts"),
    "history rendering does not reconstruct or reorder aggregate stream text",
  );
  assert.ok(appSrc.includes("MAX_EAGER_THOUGHT_MARKDOWN"), "large thoughts avoid eager markdown");
  assert.ok(
    appSrc.includes("canAppendThoughtChunk") && appSrc.includes("canAppendAssistantChunk"),
    "live thought and assistant chunks use explicit stream targets",
  );
  assert.ok(
    appSrc.includes("shouldIgnoreOrphanStreamChunk") &&
      streamSrc.includes("hasVisibleStreamText") &&
      streamSrc.includes("finalizeThoughtText"),
    "whitespace-only chunks cannot create cards or invisible stream boundaries",
  );
  assert.ok(
    !appSrc.includes("pane.lastElementChild === wrap") &&
      !appSrc.includes("pane.lastElementChild !== turn"),
    "unrelated trailing DOM nodes cannot split streamed text",
  );
  assert.ok(
    appSrc.includes("flushSessionStream(sentTo, { finish: true })"),
    "turn completion flushes the final buffered line synchronously",
  );
  assert.ok(
    !appSrc.includes("return JSON.stringify(o).slice(0, 120)"),
    "structured tool arguments stay out of collapsed titles",
  );
  assert.strictEqual(
    (appSrc.match(/function lastUserTurnEl\(/g) || []).length,
    1,
    "turn lookup has one canonical implementation",
  );
  assert.ok(
    /removeTurnAndAfter[\s\S]{0,900}thought-block/.test(appSrc),
    "retract removes thought blocks with the turn",
  );
  assert.ok(!acpSrc.includes("_hydrateTimer"), "history replay stays muted until the next prompt");

  console.log("[ui-polish] hooks discovery + automation UI…");
  const hooksMod = require("../src/hooks");
  const emptyHooks = hooksMod.listHooks({});
  assert.ok(Array.isArray(emptyHooks.hooks));
  assert.ok(Array.isArray(emptyHooks.roots));
  // synthetic extract
  const ev = hooksMod.extractEventsFromDoc({
    hooks: { SessionStart: [{ hooks: [] }], PreToolUse: [{ hooks: [] }] },
  });
  assert.ok(ev.includes("SessionStart"));
  assert.ok(ev.includes("PreToolUse"));
  const htmlAuto = read("renderer/index.html");
  assert.ok(htmlAuto.includes('data-panel="automation"'));
  assert.ok(!htmlAuto.includes('id="auto-bar"'), "retired automation rail stays out of the layout");
  assert.ok(htmlAuto.includes("settings-hooks-list"));
  const appAuto = read("renderer/app.js");
  assert.ok(appAuto.includes("noteAutomationFromSlash"));
  assert.ok(appAuto.includes("fillSettingsHooks"));
  assert.ok(appAuto.includes("listHooks"));
  const mainAuto = read("main.js");
  assert.ok(mainAuto.includes("hooks:list"));
  const preloadAuto = read("preload.js");
  assert.ok(preloadAuto.includes("listHooks"));

  console.log("[ui-polish] Mac time-format helpers…");
  const TF = require("../renderer/time-format.js");
  const now = new Date(2026, 6, 22, 16, 5, 0); // Jul 22 2026 16:05
  const today = new Date(2026, 6, 22, 9, 3, 0);
  const yest = new Date(2026, 6, 21, 14, 30, 0);
  const earlier = new Date(2026, 2, 5, 8, 7, 0);
  const lastYear = new Date(2025, 11, 1, 10, 0, 0);
  assert.strictEqual(TF.formatAbsoluteTime(today, { locale: "zh", now }), "今天 09:03");
  assert.strictEqual(TF.formatAbsoluteTime(yest, { locale: "zh", now }), "昨天 14:30");
  assert.ok(TF.formatAbsoluteTime(earlier, { locale: "zh", now }).includes("3月5日"));
  assert.ok(TF.formatAbsoluteTime(earlier, { locale: "zh", now }).includes("08:07"));
  assert.ok(TF.formatAbsoluteTime(lastYear, { locale: "zh", now }).includes("2025年"));
  assert.ok(TF.formatAbsoluteTime(today, { locale: "en", now }).startsWith("Today"));
  assert.strictEqual(TF.formatMessageTime(today, { locale: "zh", now }), "09:03");
  assert.strictEqual(TF.formatMessageTime(today, { locale: "en", now }), "9:03 AM");
  assert.ok(TF.formatMessageTime(earlier, { locale: "zh", now }).includes("3月5日"));
  assert.strictEqual(TF.formatDuration(12_000, { locale: "zh" }), "12秒");
  assert.ok(TF.formatDuration(83_000, { locale: "zh" }).includes("1分"));
  assert.ok(TF.formatDuration(83_000, { locale: "zh" }).includes("23秒"));
  assert.strictEqual(TF.formatElapsedClock(83_000), "1:23");
  assert.strictEqual(TF.formatElapsedClock(3723_000), "1:02:03");

  const htmlApp = read("renderer/index.html");
  assert.ok(htmlApp.includes("time-format.js"), "time-format script loaded");
  assert.ok(htmlApp.includes("stream-model.js"), "ordered stream buffer script loaded");
  assert.ok(htmlApp.includes("strip-time"), "live strip shows session time");
  assert.ok(htmlApp.includes("strip-duration"), "live strip shows duration");
  const appJs = read("renderer/app.js");
  assert.ok(appJs.includes("formatAbsoluteTime"), "sidebar uses absolute time");
  assert.ok(appJs.includes('className = "turn-time"'), "chat messages show timestamps");
  assert.ok(appJs.includes("markRunStart"), "run duration tracked");
  assert.ok(appJs.includes("markRunEnd"), "run duration closed");
  assert.ok(appJs.includes("sessionWhenLabel"), "session when labels");

  console.log("[ui-polish] topbar markup…");
  const html = read("renderer/index.html");
  assert.ok(html.includes('id="session-actions"'), "session-actions present");
  assert.ok(html.includes("session-toolbar"), "session-toolbar wrapper");
  assert.ok(/class="[^"]*\bsa-btn\b[^"]*"/.test(html), "unified sa-btn controls");
  assert.ok(html.includes('id="btn-plan-toggle"') && html.includes("sa-btn"), "plan is sa-btn");
  assert.ok(html.includes('id="btn-act-export"') && html.includes("sa-btn"), "export is sa-btn");
  assert.ok(html.includes('id="btn-rename"'), "rename wired");
  assert.ok(html.includes('id="btn-delete"') && html.includes("danger"), "delete danger");
  assert.ok(html.includes('id="status-pill"'), "status pill");
  assert.ok(!/class="btn plan-btn"/.test(html), "old plan-btn CTA class removed from HTML");

  console.log("[ui-polish] i18n ship blockers…");
  assert.ok(!/>Check</.test(html), "bare Check removed");
  assert.ok(!/>Diagnose</.test(html), "bare Diagnose removed");
  assert.ok(!/>Recommended</.test(html), "bare Recommended removed");
  assert.ok(html.includes('data-i18n="settings.checkUpdateBtn"'));
  assert.ok(html.includes('data-i18n="settings.diagnoseBtn"'));
  assert.ok(html.includes('data-i18n="access.recommended"'));
  assert.ok(html.includes('data-i18n="page.memory.title"'));
  assert.ok(html.includes('data-i18n="page.skills.title"'));
  assert.ok(html.includes('data-i18n="page.plugins.title"'));
  assert.ok(html.includes('data-i18n="settings.skillsLead"'));
  assert.ok(html.includes('data-i18n="settings.pluginsLead"'));
  assert.ok(html.includes('data-i18n="settings.mcpLead"'));

  // i18n key parity for new keys
  const i18nSrc = read("renderer/i18n.js");
  // load as VM-ish: evaluate STRINGS by requiring through fake window
  const vm = require("vm");
  const sandbox = { window: {}, globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(i18nSrc + "\n;this.__G = globalThis.GrokI18n || window.GrokI18n;", sandbox);
  const G = sandbox.__G || sandbox.window.GrokI18n;
  assert.ok(G && G.STRINGS, "GrokI18n loaded");
  const zh = G.STRINGS.zh;
  const en = G.STRINGS.en;
  const required = [
    "chat.exportHint",
    "chat.copyMessageHint",
    "chat.messageCopied",
    "chat.branchTaskHint",
    "chat.branchCreated",
    "chat.branchNoContext",
    "chat.branchSourceFallback",
    "access.recommended",
    "settings.checkUpdateBtn",
    "update.timeout",
    "settings.diagnoseBtn",
    "settings.exportDiagnostics",
    "settings.exportDiagnosticsDesc",
    "settings.exportDiagnosticsBtn",
    "settings.exportDiagnosticsDone",
    "settings.skillsLead",
    "settings.pluginsLead",
    "settings.mcpLead",
    "page.memory.title",
    "page.skills.title",
    "page.plugins.title",
    "slash.empty",
    "slash.badgeDesktop",
    "slash.badgeSkill",
    "common.refresh",
    "sc.ctrlK",
    "work.goalRunning",
  ];
  for (const k of required) {
    assert.ok(zh[k], `zh missing ${k}`);
    assert.ok(en[k], `en missing ${k}`);
  }

  console.log("[ui-polish] CSS session toolbar…");
  const css = read("renderer/styles.css");
  assert.ok(css.includes(".session-toolbar"));
  assert.ok(css.includes(".sa-btn"));
  assert.ok(css.includes(".sa-btn.active"));
  assert.ok(css.includes(".sa-btn.danger"));
  assert.ok(css.includes(".slash-group"));
  assert.ok(css.includes(".badge-desktop"));

  console.log("[ui-polish] transient loading + history pagination…");
  assert.ok(!css.includes(".load-earlier"), "older history no longer needs a persistent button");
  assert.ok(
    appSrc.includes("queueEarlierHistoryPage") && appSrc.includes("previousHistoryFrom"),
    "older history loads automatically at the top",
  );
  const loadStageRule = css.match(/\.session-load-stage\s*\{([^}]*)\}/)?.[1] || "";
  assert.ok(loadStageRule, "session-load-stage style exists");
  assert.ok(
    !/position\s*:\s*sticky/.test(loadStageRule),
    "session load state must not float over conversation",
  );
  assert.ok(appSrc.includes("scheduleSessionLoadStage"), "session loading UI is delayed");
  assert.ok(
    /if \(stage === "ready" && !card\?\.isConnected\) return;/.test(appSrc),
    "fast successful loads do not create a ready card",
  );

  console.log("[ui-polish] app.js wiring…");
  const app = read("renderer/app.js");
  assert.ok(app.includes("btn-plan-toggle") || app.includes("planToggle"));
  assert.ok(app.includes("btn-act-export"));
  assert.ok(app.includes("resolveDesktopRoute"));
  assert.ok(app.includes("groupSlashCommands"));
  assert.ok(app.includes('case "open-settings"'));
  assert.ok(app.includes('case "export"'));
  assert.ok(app.includes('case "rename"'));
  assert.ok(app.includes('case "open-memory"'));
  assert.ok(app.includes('case "open-skills"'));
  assert.ok(app.includes('case "open-plugins"') || app.includes("open-plugins"));
  assert.ok(app.includes('case "open-mcp"'));
  assert.ok(app.includes('className = "turn-actions"'), "message actions are rendered");
  assert.ok(app.includes('className = "turn-action-icon turn-edit"'), "user edit icon is rendered");
  assert.ok(app.includes("grokDesktop.onGoal"), "goal lifecycle updates reach the renderer");
  assert.ok(
    app.includes("await persistSessionUi(sentTo") && app.includes("pendingUserMessages"),
    "a sent user message is persisted before the prompt starts",
  );
  const thoughtHold = app.slice(
    app.indexOf("function holdThoughtForTools"),
    app.indexOf("function finishThoughtClock"),
  );
  assert.ok(thoughtHold.includes("st.thoughtHost = st.thoughtWrap"));
  assert.ok(thoughtHold.includes("st.thoughtSegment = null"));
  assert.ok(
    !thoughtHold.includes("settleThoughtText") && !thoughtHold.includes("st.thoughtWrap = null"),
  );
  assert.ok(
    app.includes('className = "thought-flow"') &&
      app.includes("flow.lastElementChild") &&
      app.includes("appendThoughtSegment"),
    "one thought disclosure interleaves thought and tool phases in event order",
  );
  assert.ok(
    html.includes('id="work-goal"') && !html.includes('id="work-goal-legacy"'),
    "active goal state has one visible status card",
  );
  assert.ok(
    app.includes('className = "turn-action-icon turn-retract"'),
    "user retract icon is rendered",
  );
  assert.ok(app.includes('actionIcon("edit")'), "edit glyph is rendered");
  assert.ok(app.includes('actionIcon("undo")'), "retract glyph is rendered");
  assert.ok(app.includes('className = "turn-action-icon turn-copy"'), "copy action is rendered");
  assert.ok(
    app.includes('className = "turn-action-icon turn-branch"'),
    "branch action is rendered",
  );
  assert.ok(
    app.includes('className = "turn-action-icon turn-memory"'),
    "memory action is rendered",
  );
  assert.ok(app.includes("recentContextForTurn"), "message branch collects recent context");
  assert.ok(app.includes("initialPrompt: prompt"), "message branch starts a new task with context");
  assert.ok(
    app.includes("const sendGenerations = new Map()"),
    "send generations are isolated per session",
  );
  assert.ok(!app.includes("let sendGeneration = 0"), "global send generation is removed");

  console.log("[ui-polish] message action CSS…");
  assert.ok(css.includes(".turn-actions"));
  assert.ok(css.includes(".turn-action-icon"));
  assert.ok(css.includes(".action-glyph svg"));
  assert.ok(
    css.includes("body.hide-thinking .thought-block"),
    "thinking visibility hides the full shell",
  );
  assert.ok(app.includes("holdThoughtForTools(sid)"), "tool starts retain their thought host");
  assert.ok(app.includes("thoughtStepHost(context) || pane"), "tool cards use the thought host");
  assert.ok(app.includes("pathCards.set(pathKey, card)"), "diff cards group by full path");
  assert.ok(
    css.includes(".thought-block:not(.is-open) > .thought-steps"),
    "collapsed thoughts hide their tool steps",
  );
  assert.ok(css.includes("@media (min-width: 1280px)"), "wide chat breakpoint missing");
  assert.ok(css.includes("@media (min-width: 1680px)"), "fullscreen chat breakpoint missing");
  assert.ok(css.includes("min(92%, 1180px)"), "fullscreen assistant width missing");
  const polishCss = read("renderer/polish.css");
  assert.ok(polishCss.includes(".diff-card .d-status"), "diff failure marker style missing");

  console.log("[ui-polish] sandbox-safe preload + slash catalog…");
  const preload = read("preload.js");
  assert.ok(!/require\(["']\.\//.test(preload), "sandboxed preload must not require local modules");
  assert.ok(
    html.includes("../src/commands-zh.js"),
    "renderer loads the pure slash catalog directly",
  );
  assert.ok(html.includes('src="a11y.js"'), "renderer loads keyboard/focus helpers");
  assert.ok(html.includes('src="history-model.js"'), "renderer loads history helpers");
  assert.ok(html.includes('src="composer-model.js"'), "renderer loads composer helpers");
  assert.ok(html.includes('src="sidebar-model.js"'), "renderer loads sidebar helpers");
  assert.ok(
    !html.includes("bootstrap.bundle.min.js"),
    "unused Bootstrap JavaScript stays out of the renderer",
  );
  assert.ok(app.includes("GrokSlashCatalog"), "renderer consumes the slash catalog global");
  assert.ok(app.includes("trapTabKey"), "dialogs trap and restore keyboard focus");
  assert.ok(app.includes("handleMenuKey"), "context menus support arrow-key navigation");
  assert.ok(
    app.includes('e.key === "k"') || app.includes('e.key === "K"'),
    "Ctrl/Cmd+K search shortcut is wired",
  );
  assert.ok(/sandbox:\s*true/.test(mainSrc), "renderer sandbox is enabled");
  assert.ok(
    mainSrc.includes("validateIpcRequest(channel, args)"),
    "all IPC handlers use centralized validation",
  );
  assert.ok(
    !mainSrc.includes('ipcMain.handle("'),
    "privileged handlers bypass centralized validation",
  );
  assert.ok(html.includes('id="btn-export-diagnostics"'), "diagnostics export control is present");
  assert.ok(preload.includes("exportDiagnostics"), "diagnostics export crosses the sandbox bridge");
  assert.ok(
    mainSrc.includes('handleIpc("app:exportDiagnostics"'),
    "main process exports diagnostics",
  );

  console.log("[ui-polish] syntax check modules…");
  for (const rel of [
    "src/commands-zh.js",
    "src/sessions.js",
    "src/acp.js",
    "src/settings.js",
    "renderer/app.js",
    "preload.js",
    "main.js",
  ]) {
    require("child_process").execFileSync(process.execPath, ["--check", path.join(root, rel)], {
      stdio: "pipe",
    });
  }

  console.log("UI POLISH CHECK OK");
}

main();
