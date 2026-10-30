const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { app, BrowserWindow } = require("electron");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const ast = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
function pickFunction(name) {
  const node = ast.statements.find(
    (item) => ts.isFunctionDeclaration(item) && item.name?.text === name,
  );
  assert.ok(node, name);
  return node.getText(ast);
}
const usageEvent = ast.statements.find((item) =>
  item.getText(ast).startsWith("grokDesktop.onUsage?.("),
);
assert.ok(usageEvent);
require("./electron-test-profile")("context-usage");
app.commandLine.appendSwitch("disable-gpu");
const timeout = setTimeout(() => app.exit(1), 30000);

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, offscreen: true },
    });
    await win.loadFile(path.join(root, "tests/fixtures/visual-fixture.html"));
    for (const script of ["src/model-info.js", "src/context-usage.js"]) {
      await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, script), "utf8"));
    }
    const result = await win.webContents.executeJavaScript(`(async () => {
    const modelInfo = globalThis.GrokModelInfo;
    const {contextUsageFromPayload, estimateContextTokens, normalizeContextUsage} = globalThis.GrokContextUsage;
    let activeId = 'a', currentModelId = 'grok-4.7-build';
    const availableModels = [];
    const sessionUi = new Map([
      ['a', {meta: {model: 'grok-4.7-build-fast', cwd: 'C:/alpha'}, history: []}],
      ['b', {meta: {model: 'grok-4.7-build', cwd: 'C:/beta'}, history: []}],
      ['unknown', {meta: {model: 'custom-model'}, history: []}],
    ]);
    const threadPanes = new Map();
    for (const id of sessionUi.keys()) {
      const pane = document.createElement('div'); pane.className = 'thread-inner';
      pane.dataset.sessionId = id; threadPanes.set(id, pane);
    }
    const ctxChip = document.createElement('button');
    ctxChip.innerHTML = '<svg><circle class="ctx-ring-fg"></circle></svg>';
    const ctxChipLabel = document.createElement('span'); ctxChip.append(ctxChipLabel);
    document.body.append(ctxChip, threadPanes.get('a'), threadPanes.get('b'));
    const ui = {inner: threadPanes.get('a'), ctxChip, ctxChipLabel};
    const ensureSessionUi = id => sessionUi.get(id);
    const pendingStreamLength = () => 0, shortPath = path => path;
    const scrollThreadToBottom = () => {}, refreshAccountUsage = () => {};
    let usageRefreshTimer = null, speedRefreshTimer = null, usageHandler, resolveUsage;
    const grokDesktop = {
      onUsage: callback => { usageHandler = callback; },
      sessionUsage: () => new Promise(resolve => { resolveUsage = resolve; }),
    };
    ${[
      "formatTokens",
      "formatTok",
      "formatRate",
      "formatSpeed",
      "formatPercent",
      "cacheHitPercent",
      "turnSpeedFromUsage",
      "applySessionSpeed",
      "updateLiveStripSpeedOnly",
      "shortModelName",
      "sessionModelId",
      "sessionModelEntry",
      "estimateContextUsage",
      "bumpContextUsage",
      "repaintContextUsage",
      "applyContextUsage",
      "refreshSessionUsage",
      "appendUsageCard",
      "handleDesktopSlash",
      "apiRatesForModel",
      "estimateApiUsd",
      "formatUsd",
      "modelPriceLabel",
      "paintTurnCost",
      "estimateWeekUsd",
    ]
      .map(pickFunction)
      .join("\n")}
    ${usageEvent.getText(ast)}
    const expect = (condition, message) => { if (!condition) throw new Error(message); };
    repaintContextUsage('a');
    expect(ui.ctxChipLabel.textContent === '0 / 500.0k · 0%', 'fresh model capacity and zero usage');
    applyContextUsage({used: 42000, size: 256000, estimated: false}, 'a');
    expect(ui.ctxChipLabel.textContent.startsWith('42000') || ui.ctxChipLabel.textContent.startsWith('42.0k'), 'measured used');
    expect(ui.ctxChip.title.includes('256.0k') && ui.ctxChip.title.includes('当前会话容量'), 'runtime capacity wins');
    activeId = 'b'; ui.inner = threadPanes.get('b'); repaintContextUsage('b');
    expect(ui.ctxChipLabel.textContent === '0 / 500.0k · 0%', 'usage isolated from old conversation');
    const late = refreshSessionUsage('a');
    resolveUsage({ok: true, used: 61000, size: 256000}); await late;
    expect(ui.ctxChipLabel.textContent === '0 / 500.0k · 0%', 'late old response cannot repaint new conversation');
    expect(sessionUi.get('a').usage.used === 61000, 'background measurement retained');
    applyContextUsage({used: 20000, size: 500000, estimated: false}, 'b');
    sessionUi.get('b').history = [{text: 'x'.repeat(120000)}]; bumpContextUsage('b');
    expect(sessionUi.get('b').usage.used === 20000 && sessionUi.get('b').usage.estimated === false, 'estimate cannot replace measurement');
    applyContextUsage({used: 10, size: 500000, estimated: false}, 'b');
    expect(ui.ctxChipLabel.textContent.startsWith('10 /'), 'compaction can reduce real occupancy');
    activeId = 'unknown'; ui.inner = threadPanes.get('unknown'); repaintContextUsage('unknown');
    expect(ui.ctxChipLabel.textContent === '0 / 容量待获取', 'unknown model not mapped to 131k or Grok');
    activeId = 'a'; ui.inner = threadPanes.get('a');
    const contextJob = handleDesktopSlash('context', '', 'a');
    activeId = 'b'; ui.inner = threadPanes.get('b'); repaintContextUsage('b');
    const visibleBefore = ui.ctxChipLabel.textContent;
    resolveUsage({ok: true, used: 65000, size: 256000}); await contextJob;
    expect(ui.inner === threadPanes.get('b'), 'async slash does not restore old shared pane');
    expect(!threadPanes.get('b').querySelector('.usage-card') && threadPanes.get('a').querySelector('.usage-card').textContent.includes('256.0k'), 'context card owned by its source conversation');
    expect(ui.ctxChipLabel.textContent === visibleBefore, 'async slash cannot change current context indicator');
    const oldModelRequest = refreshSessionUsage('b');
    sessionUi.get('b').meta.model = 'grok-4.7-build-fast'; repaintContextUsage('b');
    resolveUsage({ok: true, used: 120000, size: 128000}); await oldModelRequest;
    expect(sessionUi.get('b').usage.size === 500000 && sessionUi.get('b').usage.used === 10, 'late old model measurement cannot replace current model context');
    usageHandler({sessionId: 'b', modelId: 'grok-4.7-build', contextTokensUsed: 140000, contextWindowTokens: 128000});
    expect(sessionUi.get('b').usage.size === 500000 && sessionUi.get('b').usage.used === 10, 'explicit old model event is ignored for context');
    const older = refreshSessionUsage('b'), resolveOlder = resolveUsage;
    const newer = refreshSessionUsage('b');
    resolveUsage({ok: true, used: 20, size: 256000}); await newer;
    resolveOlder({ok: true, used: 150000, size: 128000}); await older;
    expect(sessionUi.get('b').usage.used === 20 && sessionUi.get('b').usage.size === 256000, 'older request cannot overwrite latest measurement');
    const reply = document.createElement('article'); reply.className = 'turn assistant';
    threadPanes.get('a').append(reply);
    usageHandler({sessionId: 'a', modelId: 'grok-4.7-build-fast', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200});
    const cost = reply.querySelector('.turn-cost');
    expect(cost.textContent.includes('Grok 4.7 Fast') && cost.title.includes('未缓存入 $4/M') && cost.title.includes('出 $12/M'), 'background Fast cost not selected normal model');
    expect(sessionUi.get('a').usage.used === 65000, 'turn totals not context used');
    resolveUsage({ok: false}); await Promise.resolve();
    sessionUi.get('a').turnModelId = 'grok-4.7-build';
    usageHandler({sessionId: 'a', inputTokens: 1000, outputTokens: 100});
    expect(cost.textContent.includes('Grok 4.7') && !cost.textContent.includes('Fast') && cost.title.includes('未缓存入 $2/M'), 'missing model falls back to sent request rather than new selection');
    resolveUsage({ok: false}); await Promise.resolve();
    const totals = {weekInput: 2000000, weekOutput: 0, weekReasoning: 0, weekCache: 0, weekByModel: {
      'grok-4.7': {input: 1000000}, 'grok-4.7-fast': {input: 1000000}
    }};
    expect(estimateWeekUsd(totals) === 6, 'weekly base rates split by model, not aggregate long-context tier');
    currentModelId = 'grok-4.7-build-fast';
    expect(estimateWeekUsd(totals) === 6, 'model switch cannot change old weekly cost');
    expect(estimateWeekUsd({...totals, weekInput: 3000000}) === null, 'incomplete buckets do not guess cost');
    // A turn with measured model time shows its own rate; without one, no rate
    // is invented from wall-clock time.
    usageHandler({sessionId: 'a', inputTokens: 1000, outputTokens: 200, reasoningTokens: 100, apiDurationMs: 2500});
    expect(cost.textContent.includes('120 tok/s'), 'turn rate uses model time over generated tokens');
    expect(cost.title.includes('本轮 120 tok/s'), 'turn rate is explained in the tooltip');
    resolveUsage({ok: false}); await Promise.resolve();
    usageHandler({sessionId: 'a', inputTokens: 1000, outputTokens: 200});
    expect(!cost.textContent.includes('tok/s'), 'no measured model time means no invented rate');
    resolveUsage({ok: false}); await Promise.resolve();
    // Cache-hit share is derived from prompt tokens and stays bounded.
    expect(cacheHitPercent(80, 100) === 80 && cacheHitPercent(50, 10) === 100, 'cache hit share is prompt-relative and clamped');
    expect(cacheHitPercent(0, 100) === null && cacheHitPercent(10, 0) === null, 'no denominator, no percentage');
    expect(formatPercent(92.9178) === '92.9%' && formatPercent(99.99) === '100%', 'hit share formatting');
    expect(formatSpeed(132.44) === '132 tok/s' && formatSpeed(9.44) === '9.4 tok/s', 'rates keep a decimal below 100');
    expect(turnSpeedFromUsage({output: 100, reasoning: 20, durationMs: 1000}) === '120 tok/s', 'turn rate helper');
    expect(turnSpeedFromUsage({output: 100, durationMs: 0}) === '', 'zero model time yields no rate');
    clearTimeout(usageRefreshTimer);
    clearTimeout(speedRefreshTimer);
    return {zero: true, runtimeCapacity: true, isolated: true, lateResponse: true, compaction: true, unknown: true, asyncContextCard: true, modelRace: true, requestOrder: true, fast: true, requestPricing: true, weekly: true, turnRate: true, noFakeRate: true, cacheShare: true};
  })()`);
    assert.ok(Object.values(result).every(Boolean));
    console.log("CONTEXT USAGE OK:", Object.keys(result).join(", "));
    clearTimeout(timeout);
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
