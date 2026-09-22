const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { buildHistoryFileChange } = require("../src/diff");
const { readFilePreview } = require("../src/file-preview");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const pick = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\nfunction ", start + 1));
};
const output = path.join(root, "artifacts/history-files-check");
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, "中文 文件清单.md");
fs.writeFileSync(file, "# 文件清单\n\n中文路径内容预览成功。\n");
const messages = [
  { role: "user", text: "更新文件清单" },
  {
    role: "tool",
    title: "search_replace",
    kindName: "search_replace",
    status: "completed",
    toolCallId: "edit-1",
    rawInput: { file_path: file, old_string: "旧", new_string: "新" },
  },
  {
    role: "tool",
    title: "search_replace",
    kindName: "search_replace",
    status: "completed",
    toolCallId: "edit-2",
    rawInput: { file_path: file, old_string: "新", new_string: "新内容" },
  },
  { role: "assistant", text: "清单在 `中文 文件清单.md`。" },
];
for (const message of messages)
  if (message.role === "tool") message.fileChange = buildHistoryFileChange(message, output);
app.commandLine.appendSwitch("disable-gpu");
const timer = setTimeout(() => app.exit(1), 30000);
app
  .whenReady()
  .then(async () => {
    ipcMain.handle("file:preview", (_e, full) => readFilePreview(full));
    const win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        offscreen: true,
        preload: path.join(root, "preload.js"),
      },
    });
    win.webContents.on("console-message", (event) => console.log(event.message));
    await win.loadFile(path.join(root, "tests/fixtures/visual-fixture.html"));
    for (const name of ["markdown", "tool-presentation"])
      await win.webContents.executeJavaScript(
        fs.readFileSync(path.join(root, `renderer/${name}.js`), "utf8"),
      );
    const result = await win.webContents.executeJavaScript(`(async()=>{
    const { normalizeDiffPath,diffPathLabel,aggregateDiffStatus,diffStatusPresentation,shortTargetLabel,isTerminalToolStatus }=GrokToolPresentation;
    const pane=document.querySelector('.thread-inner'),ui={inner:pane},activeId='fixture';
    const activeMeta={cwd:${JSON.stringify(output)}},sessions=[];
    const state={meta:activeMeta,diffCardMap:new Map(),diffPathMap:new Map(),toolCardMap:new Map()};
    const sessionUi=new Map([[activeId,state]]),ensureSessionUi=()=>state;
    const sessionRenderContext=()=>({pane,state,sessionId:activeId,isActive:false});
    const uiLocale=()=>'zh',getPane=()=>pane,nodeInLivePane=node=>!!node?.isConnected;
    const thoughtStepHost=()=>null,updateThoughtStepCount=()=>{},noteCallActivity=()=>{},isAgentBusy=()=>false;
    const promptInFlight=new Set(),refreshPinnedPrompt=()=>{},updateJumpToLatest=()=>{};
    const mapAssetsToMessageIndex=()=>new Map(),historyFrom=0;
    let threadFollowBottom=false;
    const clearThread=()=>{pane.replaceChildren();state.diffCardMap.clear();state.diffPathMap.clear();};
    const appendToolCard=()=>{};
    const appendTurn=(role,text)=>{if(role==='user')state.diffPathMap.clear();const el=document.createElement('div');el.className='turn '+role;const body=document.createElement('div');body.className='body md';body.innerHTML=renderMarkdown(text);el.append(body);pane.append(el);};
    const classifyAssistantTurns=()=>{},formatBytesUi=n=>n+' B',flashToast=()=>{},copyText=async()=>{};
    ${["mergeToolPayload", "paintDiffCardStatus", "upsertDiffToolPayload", "foldToolCardIntoDiff", "appendDiffCard", "fileKeyFromCard", "cardDiffStats", "mergeTurnFiles", "paintHunksInto", "closeTurnFileSheet", "openTurnFileSheet", "buildTurnFileBox", "reconcileTurnFileSummary", "appendTurnFileSummary", "scheduleTurnFileSummary", "sealTurnFileSummaries", "renderHistoryWithAssets"].map(pick).join("\n")}
    ${source.slice(source.indexOf("function sessionCwdFor("), source.indexOf('$("btn-check-update")?.addEventListener'))}
    const messages=${JSON.stringify(messages)};
    renderHistoryWithAssets(messages,[],activeMeta,{pinBottom:false});
    await new Promise(resolve=>setTimeout(resolve,320));
    const afterDeferred=pane.querySelectorAll('.turn-files').length;
    const summary=pane.lastElementChild;
    const restored=summary.classList.contains('turn-files') && summary.querySelectorAll('.tf-row').length===1;
    const merged=summary.textContent.includes('2次');
    const link=pane.querySelector('a.file-link');
    const notNested=pane.querySelectorAll('a.file-link').length===1;
    const waitText=async()=>{for(let i=0;i<100&&!document.querySelector('.tf-file-text');i++)await new Promise(r=>setTimeout(r,20));return document.querySelector('.tf-file-text')?.textContent||'';};
    link.click(); const fromLink=await waitText(); closeTurnFileSheet();
    summary.querySelector('.tf-row').click();const fromSummary=await waitText();closeTurnFileSheet();
    summary.querySelector('.tf-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:300}));
    const menu=document.querySelectorAll('.file-ctx-item').length;hideFileLinkMenu();
    renderHistoryWithAssets(messages,[],activeMeta,{pinBottom:false});
    const reopened=pane.querySelectorAll('.turn-files').length===1 && pane.lastElementChild.classList.contains('turn-files');
    appendTurnFileSummary(activeId); appendTurnFileSummary(activeId);
    sealTurnFileSummaries(pane); sealTurnFileSummaries(pane);
    await new Promise(resolve=>setTimeout(resolve,320));
    const repeated=pane.querySelectorAll('.turn-files').length===1;
    const oldSummary=pane.querySelector('.turn-files');
    appendTurn('user','下一轮没有文件改动');
    appendTurn('assistant','无需修改文件');
    appendTurnFileSummary(activeId);
    const keptPrevious=pane.querySelectorAll('.turn-files').length===1 && oldSummary.isConnected;
    renderHistoryWithAssets([...messages,...messages],[],activeMeta,{pinBottom:false});
    await new Promise(resolve=>setTimeout(resolve,320));
    const twoTurns=pane.querySelectorAll('.turn-files').length===2;
    renderHistoryWithAssets(messages,[],activeMeta,{pinBottom:false});
    await new Promise(resolve=>setTimeout(resolve,320));
    const realPath=${JSON.stringify(process.env.GROK_VERIFY_DOCUMENT || "")};
    let realRead=null;
    if(realPath){openTurnFileSheet({path:realPath,edits:[]});realRead=(await waitText()).length>0;closeTurnFileSheet();}
    return {restored,merged,notNested,fromLink,fromSummary,menu,reopened,realRead,afterDeferred,repeated,keptPrevious,twoTurns};
  })()`);
    assert.equal(
      result.afterDeferred,
      1,
      "history and delayed live refresh must share one summary",
    );
    for (const key of [
      "restored",
      "merged",
      "notNested",
      "reopened",
      "repeated",
      "keptPrevious",
      "twoTurns",
    ])
      assert.equal(result[key], true, key);
    assert.match(result.fromLink, /中文路径内容预览成功/);
    assert.equal(result.fromLink, result.fromSummary);
    assert.equal(result.menu, 4);
    if (process.env.GROK_VERIFY_DOCUMENT) assert.equal(result.realRead, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.writeFileSync(
      path.join(output, "summary.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log(
      "HISTORY FILES OK: replay, summary after answer, grouped edits, Chinese link, real IPC preview, right-click, reopen" +
        (result.realRead ? ", actual user document read" : ""),
    );
    clearTimeout(timer);
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
