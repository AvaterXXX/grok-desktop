const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { app, BrowserWindow } = require("electron");

const root = path.resolve(__dirname, "..");
const source = ts.createSourceFile(
  "app.js",
  fs.readFileSync(path.join(root, "renderer/app.js"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const pick = (name) => {
  const node = source.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
  );
  assert.ok(node, name);
  return node.getText(source);
};
const functions = [
  "setPlanOpen",
  "setSubagentOpen",
  "closeSessionOverlays",
  "closeModelPop",
  "closeModelSub",
  "closeEffortPop",
  "closeModePop",
  "hideSlash",
  "closeTurnFileSheet",
  "hideFileLinkMenu",
  "hideSessionCtx",
  "hideQuotaCostTip",
  "openModelPop",
  "openEffortPop",
  "openModePop",
  "selectModel",
  "paintComposerMode",
  "applyWorkModeToPrompt",
  "restoreComposerModeForSession",
  "adoptHistoryPlan",
  "noteAutomationFromSlash",
  "setSessionAutomation",
  "clearSessionAutomation",
  "handleSessionGoal",
  "paintSubagentTurns",
  "shortSubagentName",
  "shortSubagentActivity",
  "selectSession",
  "newSession",
  "normalizePlanEntries",
  "syncPlanChrome",
  "isGoalChrome",
  "renderPlan",
  "renderGoalSummary",
  "planStepKind",
  "goalStillRunning",
];
const noops = [
  "paintComposerAccess",
  "renderComposerStatus",
  "renderModePop",
  "renderEffortPop",
  "renderModelPop",
  "renderWorkCard",
  "refreshSendButtonState",
  "hideAutoBar",
  "settleLiveReply",
  "releaseSessionRun",
  "refreshSidebarSessionState",
  "syncBusyChrome",
  "applyComposerDraft",
  "addOpenTab",
  "markActive",
  "persistOpenTabs",
  "setBusy",
  "paintRunStatus",
  "scheduleTurnFileSummary",
  "setComposerEnabled",
  "maybeFlushIdleQueue",
  "applyPreferredDefaults",
  "syncModelChip",
  "removeQueuedTurns",
  "renderAttachPreview",
  "renderContextChips",
  "rememberComposerDraft",
  "rerenderQueuedTurns",
  "refreshAccountUsage",
  "renderSidebar",
  "clearThread",
  "refreshSessions",
  "bootMark",
  "adoptSlashCommands",
  "setModelsState",
  "appendBanner",
  "flashToast",
  "paintSessionModelName",
];

app.commandLine.appendSwitch("disable-gpu");
const timeout = setTimeout(() => app.exit(1), 30000);
app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(path.join(root, "tests/fixtures/visual-fixture.html"));
    await win.webContents.executeJavaScript(
      fs.readFileSync(path.join(root, "src/goal-state.js"), "utf8"),
    );
    const result = await win.webContents.executeJavaScript(`(async () => {
    document.body.replaceChildren();
    const $ = id => document.getElementById(id);
    const make = (id, tag = 'div') => {
      const el = document.createElement(tag); el.id = id; document.body.append(el); return el;
    };
    for (const id of ['plan-panel','plan-list','plan-badge','plan-progress','plan-toggle-label',
      'plan-panel-label','btn-plan-toggle','subagent-panel','subagent-list','subagent-badge',
      'subagent-progress','btn-subagent-toggle','model-popover','model-submenu',
      'effort-popover','mode-popover','slash-menu','session-ctx','quota-cost-tip',
      'composer','mode-ico','lightbox']) make(id);
    make('message-input','textarea'); make('search','input');
    const image = document.createElement('img'); $('lightbox').append(image);
    const ui = {
      input:$('message-input'), search:$('search'), planPanel:$('plan-panel'), planList:$('plan-list'),
      planToggle:$('btn-plan-toggle'), subagentPanel:$('subagent-panel'), subagentList:$('subagent-list'),
      subagentToggle:$('btn-subagent-toggle'), modelPop:$('model-popover'), modelSub:$('model-submenu'),
      effortPop:$('effort-popover'), modePop:$('mode-popover'), slashMenu:$('slash-menu'), inner:null,
    };
    const {classifyGoalCommand,isGoalTerminal,isGoalCleared,isGoalPaused,isGoalRestorable,mergeAutomationGoal} = GrokGoalState;
    let activeId='a', activeMeta={id:'a'}, composerMode='task', planModePending=false;
    let planOpen=false, subagentOpen=false, modelOpen=false, effortOpen=false, modeOpen=false;
    let modelSubKind=null, modelPopRequestSeq=0, slashOpen=false, slashIndex=0, slashFiltered=[];
    let sessionCtxReturnFocus=null, ctxSessionId=null, availableModels=[], currentModelId=null;
    let currentEffort='xhigh', effortOptions=[{id:'xhigh'}], connecting=false, openSeq=0;
    let pendingImages=[], pendingFiles=[], messageQueue=[], sessionHistory=[], historyFrom=0;
    let historyAssets=[], seenMedia=new Set(), lastUsedCwd=null, sessions=[], lastAccountUsage=null;
    let liveAgents=new Set(['a','b']), workingSessions=new Set(), promptInFlight=new Set();
    const sessionUi=new Map(), sessionAutomation=new Map(), panes=new Map(), sessionEffortUser=new Set();
    const a11y={restoreFocus:()=>{}};
    const noop=()=>{};
    ${noops.map((name) => `const ${name}=noop;`).join("\n")}
    const t=key=>key, uiLocale=()=> 'zh', modeIco=mode=>mode, localizeStatus=(_state,detail)=>detail;
    const sessionVisuallyBusy=()=>false, applySlashCatalog=()=>true, commandsLookLocalized=()=>false, isAgentBusy=()=>false;
    const setStatus=noop, switchView=noop, pickNewSessionCwd=async()=>'/project';
    const ensureSessionUi=id=> {
      if(!sessionUi.has(id)) sessionUi.set(id, {meta:{id},composerMode:'task',subagents:new Map(),mediaPlacedV2:true});
      return sessionUi.get(id);
    };
    const ensurePane=id=> {
      if(!panes.has(id)) {
        const pane=document.createElement('div'); pane.innerHTML='<div class="turn user">message</div>';
        panes.set(id,pane); document.body.append(pane);
      }
      return panes.get(id);
    };
    const getPane=ensurePane, activatePane=id=>{ui.inner=ensurePane(id);};
    const stashComposer=id=>{ensureSessionUi(id).composerMode=composerMode;};
    const restoreComposer=noop, applyHeader=meta=>{activeMeta=meta;};
    const shortModelName=id=>id, defaultEffortForModel=()=> 'xhigh';
    const applyEffort=async()=>{}, refreshEffortOptions=noop;
    const applyModelCatalog=catalog=>{availableModels=catalog;};
    let resolveModels, resolveModelSet, resolveNewSession;
    const grokDesktop={
      activateSession:async()=>({ok:true}), listCommands:async()=>({commands:[]}),
      listModels:()=>new Promise(resolve=>{resolveModels=resolve;}),
      setModel:()=>new Promise(resolve=>{resolveModelSet=resolve;}),
      newSession:()=>new Promise(resolve=>{resolveNewSession=resolve;}),
    };
    ${functions.map(pick).join("\n")}
    const check=(condition,label)=> { if(!condition) throw new Error(label); };
    const allClosed=()=> !planOpen&&!subagentOpen&&!modelOpen&&!effortOpen&&!modeOpen&&!slashOpen &&
      ['plan-panel','subagent-panel','model-popover','model-submenu','effort-popover','mode-popover',
      'slash-menu','session-ctx','lightbox'].every(id=>$(id).classList.contains('hidden')) &&
      !$('tf-sheet')&&!document.querySelector('.file-ctx-menu')&&$('quota-cost-tip').hidden;
    const openAll=()=> {
      setPlanOpen(true); setSubagentOpen(true); modelOpen=effortOpen=modeOpen=slashOpen=true;
      modelSubKind='model';
      for(const id of ['model-popover','model-submenu','effort-popover','mode-popover','slash-menu',
        'session-ctx','lightbox']) $(id).classList.remove('hidden');
      $('quota-cost-tip').hidden=false;
      make('tf-sheet'); const menu=make('file-menu'); menu.className='file-ctx-menu';
      menu._dismiss=noop; $('lightbox').querySelector('img').src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    };
    activatePane('a'); ensureSessionUi('a'); ensureSessionUi('b');

    noteAutomationFromSlash('goal','finish release','a');
    check(planOpen&&sessionAutomation.get('a').objective==='finish release','explicit goal opens its own panel');
    check(composerMode==='task'&&applyWorkModeToPrompt('follow-up')==='follow-up','goal start does not rewrite ordinary input');
    setPlanOpen(false);
    handleSessionGoal({sessionId:'a',goalId:'goal-a',objective:'finish release',status:'active'});
    check(goalStillRunning('a')&&!planOpen&&composerMode==='task','live goal remains active without reopening or changing input');
    for(const command of ['status','pause','resume']) {
      noteAutomationFromSlash('goal',command,'a');
      check(composerMode==='task'&&applyWorkModeToPrompt('normal')==='normal','goal '+command+' keeps ordinary input');
    }
    ensureSessionUi('a').plan={entries:[{content:'done step',status:'completed'}]};
    renderPlan(ensureSessionUi('a').plan);
    check(goalStillRunning('a'),'a completed plan is not a completed goal');
    handleSessionGoal({sessionId:'a',goalId:'goal-a',status:'complete'});
    check(!sessionAutomation.has('a')&&composerMode==='task'&&ensureSessionUi('a').plan.entries.length===1,
      'terminal protocol event ends goal and preserves its completed plan');
    handleSessionGoal({sessionId:'a',goalId:'new-goal',objective:'another goal',status:'active'});
    noteAutomationFromSlash('goal','clear','a');
    check(!sessionAutomation.has('a')&&!ensureSessionUi('a').plan&&!planOpen,'goal clear clears lifecycle and plan');
    const historyGoal={kind:'goal',goalId:'saved',objective:'saved objective',status:'active'};
    ensureSessionUi('a').composerMode='goal';
    adoptHistoryPlan(ensureSessionUi('a'),{goal:historyGoal,plan:{entries:[]}},true);
    check(goalStillRunning('a')&&composerMode==='task'&&!planOpen,'history restoration keeps goal but does not restore sticky input or panel');
    composerMode='goal';
    check(applyWorkModeToPrompt('legacy stale mode')==='legacy stale mode','old goal preference cannot add a slash prefix');
    restoreComposerModeForSession('a');
    ensureSessionUi('a').subagents.set('sa-a',{id:'sa-a',index:1,name:'worker',status:'running'});
    paintSubagentTurns('a');
    check(!subagentOpen&&$('subagent-badge').textContent==='1','replayed subagents update the badge without auto-opening');
    openAll();
    await selectSession('b');
    check(activeId==='b'&&allClosed(),'switching conversation closes every floating control');
    check(!$('lightbox').querySelector('img').hasAttribute('src'),'switching clears the old lightbox image');
    check($('subagent-badge').textContent==='0','the target conversation owns its badge');
    const currentBadge=$('subagent-badge').textContent, currentList=$('subagent-list').textContent;
    ensureSessionUi('a').subagents.set('sa-2',{id:'sa-2',index:2,name:'worker',status:'running'});
    paintSubagentTurns('a');
    handleSessionGoal({sessionId:'a',goalId:'background',objective:'background objective',status:'active'});
    check($('subagent-badge').textContent===currentBadge&&$('subagent-list').textContent===currentList&&!planOpen&&!subagentOpen,
      'background updates do not repaint or open the current conversation');
    await selectSession('a');
    check(!planOpen&&!subagentOpen&&$('subagent-badge').textContent==='2'&&composerMode==='task','returning restores data with panels closed');
    setPlanOpen(true); setSubagentOpen(true); paintSubagentTurns('a');
    check($('plan-list').textContent.includes('background objective')&&$('subagent-list').querySelectorAll('.sa-card').length===2,
      'retained goal and subagent records can be reopened manually');

    availableModels=[];
    const pendingPop=openModelPop();
    await selectSession('b');
    resolveModels([{modelId:'old-session-model'}]); await pendingPop;
    check(!modelOpen&&availableModels.length===0&&$('model-popover').classList.contains('hidden'),
      'a model catalog request cannot reopen after switching');
    const pendingPop2=openModelPop(); closeModelPop();
    resolveModels([{modelId:'closed-model'}]); await pendingPop2;
    check(!modelOpen&&availableModels.length===0,'closing invalidates a pending model menu');
    const pendingPop3=openModelPop(); openModePop();
    resolveModels([{modelId:'superseded-model'}]); await pendingPop3;
    check(!modelOpen&&modeOpen,'opening another menu supersedes a pending model menu');
    closeSessionOverlays();
    const pendingModel=selectModel('model-b');
    await selectSession('a'); resolveModelSet(); await pendingModel;
    check(ensureSessionUi('b').meta.model==='model-b'&&currentModelId!=='model-b',
      'model selection completion cannot change the newly focused conversation');

    openAll();
    const creating=newSession({cwd:'/project'});
    check(allClosed(),'creating a conversation closes floating controls before awaiting the server');
    resolveNewSession({session:{id:'new',cwd:'/project'}});
    check(await creating==='new'&&activeId==='new'&&composerMode==='task'&&allClosed(),
      'new conversations start without prior controls or sticky goal mode');
    check($('subagent-badge').textContent==='0'&&!sessionAutomation.has('new'),'new conversations have their own goal and subagent state');
    return {goal:true,overlays:true,background:true,asyncMenus:true,newSession:true};
  })()`);
    assert.deepEqual(result, {
      goal: true,
      overlays: true,
      background: true,
      asyncMenus: true,
      newSession: true,
    });
    console.log(
      "SESSION UI OK: explicit goals, lifecycle isolation, conversation overlays, background badges, async menus, new sessions",
    );
    clearTimeout(timeout);
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
