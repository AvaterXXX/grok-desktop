const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const pick = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end);
};
app.commandLine.appendSwitch("disable-gpu");
const timeout = setTimeout(() => app.exit(1), 30000);
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 850,
      webPreferences: { sandbox: true, contextIsolation: true, offscreen: true },
    });
    win.webContents.on("console-message", (event) => console.log(event.message));
    await win.loadFile(path.join(root, "tests/fixtures/visual-fixture.html"));
    await win.webContents.executeJavaScript(
      fs.readFileSync(path.join(root, "renderer/stream-model.js"), "utf8"),
    );
    await win.webContents.executeJavaScript(
      fs.readFileSync(path.join(root, "renderer/markdown.js"), "utf8"),
    );
    const result = await win.webContents.executeJavaScript(`(async () => {
    const { canContinueHistoryThoughtBlock, canAppendThoughtChunk, shouldIgnoreOrphanStreamChunk, finalizeThoughtText } = GrokStreamModel;
    const pane = document.querySelector('.thread-inner'); pane.replaceChildren();
    const ui = {inner:pane}, activeId = 'layout-test';
    const st = {}, sessionUi = new Map([[activeId, st]]), workingSessions = new Set([activeId]);
    const ensureSessionUi = () => st, getPane = () => pane;
    const uiLocale = () => 'zh', nodeInLivePane = el => !!el?.isConnected;
    const lastUserTurnEl = () => pane.querySelector('.turn.user');
    const profileNickname = () => '你', assistantDisplayName = () => 'Grok';
    const refreshPinnedPrompt = () => {}, scrollThreadToBottom = () => {};
    const parseAttachText = () => null, thoughtClockLabel = () => '正在思考', shouldClamp = () => false;
    const actionIcon = () => document.createElement('span');
    const MAX_EAGER_THOUGHT_MARKDOWN = 80000;
    const t = key => ({'response.progress':'过程说明','response.final':'最终答复','response.live':'正在回复'}[key]);
    const makeTurnWho = role => {
      const who = document.createElement('div'); who.className = 'turn-who';
      const name = document.createElement('span'); name.className = 'who-name';
      name.textContent = role === 'assistant' ? 'Grok' : '你'; who.append(name); return who;
    };
    const setMessageBody = (el, text) => { el.classList.add('md'); el.innerHTML = window.renderMarkdown(text); };
    ${["nodeAfterLastUser", "ensureThoughtFlow", "appendThoughtSegment", "renderPendingThoughtMarkdown", "noteThoughtStream", "settleThoughtText", "holdThoughtForTools", "finishThoughtClock", "paintHistoryThought", "appendHistoryThought", "thoughtStepHost", "lastSpeakerWasAssistant", "setAssistantTurnKind", "classifyAssistantTurns", "appendTurn"].map(pick).join("\n")}
    appendTurn('user','检查当前项目并说明结果。', {skipScroll:true});
    appendHistoryThought('先检查项目配置。');
    appendHistoryThought('再确认入口文件。');
    const merged = pane.querySelectorAll('.thought-block').length === 1;
    appendTurn('assistant','已确认项目结构，接下来检查启动流程。',{skipScroll:true});
    const released = st.thoughtHost === null;
    appendHistoryThought('检查启动日志与配置是否一致。');
    const host = thoughtStepHost({pane,state:st});
    const tool = document.createElement('div'); tool.textContent='读取配置 · 已完成'; host.append(tool);
    appendHistoryThought('配置读取正常。');
    appendTurn('assistant','启动流程检查完成，正在整理结果。',{skipScroll:true});
    appendHistoryThought('最后核对检查项。');
    appendTurn('assistant','检查完成。\\n\\n项目配置和启动流程正常，文件预览也已恢复。\\n\\n可以继续在当前项目中使用。',{skipScroll:true});
    classifyAssistantTurns(pane,{settled:true});
    const order = [...pane.children].map(el => el.classList.contains('thought-block') ? 'thought' : el.classList.contains('user') ? 'user' : el.classList.contains('final-answer') ? 'final' : 'progress');
    const collapsed = [...pane.querySelectorAll('.thought-flow')].every(el => getComputedStyle(el).display === 'none');
    const text = pane.textContent;
    const bodyStyle = getComputedStyle(pane.querySelector('.final-answer > .body'));
    const border = bodyStyle.borderTopWidth;
    const font = bodyStyle.fontSize;
    const saved = [...pane.children];
    noteThoughtStream(activeId, 'Streaming thought');
    const live = st.thoughtWrap;
    live.querySelector('.thought-head').click();
    noteThoughtStream(activeId, ' continues');
    const staysClosed = !live.classList.contains('is-open') && live.querySelector('button').getAttribute('aria-expanded') === 'false';
    live.querySelector('.thought-head').click();
    const reopens = live.classList.contains('is-open') && live.textContent.includes('Streaming thought continues');
    finishThoughtClock(activeId); live.remove();
    for(const child of [...pane.children]) if (!saved.includes(child)) child.remove();
    document.querySelector('#thread').scrollTop=0;
    return {merged,released,order,collapsed,staysClosed,reopens,border,font,text};
  })()`);
    for (const key of ["merged", "released", "collapsed", "staysClosed", "reopens"])
      assert.equal(result[key], true, key);
    assert.deepEqual(result.order, [
      "user",
      "thought",
      "progress",
      "thought",
      "progress",
      "thought",
      "final",
    ]);
    assert.equal(result.border, "0px");
    assert.equal(result.font, "15px");
    assert.match(result.text, /最后核对检查项/);
    const out = path.join(root, "artifacts/conversation-layout");
    fs.mkdirSync(out, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await win.webContents.executeJavaScript(
        `document.body.className='theme-${theme} palette-paper visual-fixture'`,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      fs.writeFileSync(
        path.join(out, theme + ".png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    console.log(
      "CONVERSATION LAYOUT OK: history order, adjacent thought merging, tool ownership, collapsed history, live toggle, reply styles",
    );
    clearTimeout(timeout);
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
