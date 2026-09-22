const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { readFilePreview } = require("../src/file-preview");

const root = path.resolve(__dirname, "..");
app.commandLine.appendSwitch("disable-gpu");
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const pick = (name) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end);
};
const timer = setTimeout(() => app.exit(1), 30000);
app
  .whenReady()
  .then(async () => {
    ipcMain.handle("file:preview", (_event, full) => readFilePreview(full));
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 750,
      webPreferences: {
        preload: path.join(root, "preload.js"),
        sandbox: true,
        contextIsolation: true,
        offscreen: true,
      },
    });
    await win.loadFile(path.join(root, "tests/fixtures/sandbox-check.html"));
    await win.webContents.insertCSS(
      fs.readFileSync(path.join(root, "renderer/styles.css"), "utf8"),
    );
    const result = await win.webContents.executeJavaScript(`(async () => {
    const uiLocale = () => 'zh';
    const formatBytesUi = n => n + ' B';
    const flashToast = () => {};
    const copyText = async () => {};
    const activeId = null, activeMeta = null;
    const sessions = [], sessionUi = new Map();
    ${["paintHunksInto", "closeTurnFileSheet", "openTurnFileSheet", "buildTurnFileBox"].map(pick).join("\n")}
    ${source.slice(source.indexOf("function sessionCwdFor("), source.indexOf('$("btn-check-update")?.addEventListener'))}
    document.body.className = 'theme-light';
    document.body.innerHTML = '';
    const file = ${JSON.stringify(path.join(root, "src/file-preview.js"))};
    const box = buildTurnFileBox([{ path: file, label: 'src/file-preview.js', badge: 'Edit', add: 2, del: 1,
      edits: [{ badge: 'Edit', add: 2, del: 1, hunks: [{type:'add', text:'new content'}] }] }], false);
    document.body.append(box);
    const row = box.querySelector('.tf-row');
    row.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, clientX:100, clientY:100}));
    const menu = [...document.querySelectorAll('.file-ctx-item')].map(b => b.textContent);
    document.querySelector('.file-ctx-item').click();
    const waitContent = async () => {
      for (let i = 0; i < 100 && !document.querySelector('.tf-file-text'); i++) await new Promise(r => setTimeout(r, 20));
    };
    await waitContent();
    const text = document.querySelector('.tf-file-text')?.textContent;
    closeTurnFileSheet();
    row.focus(); row.click(); await waitContent();
    const buttons = [...document.querySelectorAll('.tf-sheet-toolbar button')];
    buttons[1].click();
    const changesVisible = !document.querySelector('.tf-sheet-body:not(.tf-file-content)').hidden;
    buttons[0].click();
    const contentVisible = !document.querySelector('.tf-file-content').hidden;
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    const closed = !document.getElementById('tf-sheet');
    const restoredFocus = document.activeElement === row;
    openTurnFileSheet({path: file + '.missing', edits: []});
    for (let i=0; i<100 && !document.querySelector('.tf-file-content').textContent.includes('无法读取'); i++) await new Promise(r=>setTimeout(r,20));
    const missing = document.querySelector('.tf-file-content').textContent.includes('无法读取');
    closeTurnFileSheet(); row.click(); await waitContent();
    return {menu, text, changesVisible, contentVisible, closed, restoredFocus, missing};
  })()`);
    assert.equal(result.menu.length, 4);
    assert.match(result.text, /async function readFilePreview/);
    for (const key of ["changesVisible", "contentVisible", "closed", "restoredFocus", "missing"])
      assert.equal(result[key], true, key);
    const out = path.join(root, "artifacts/file-preview.png");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    console.log(
      "FILE PREVIEW UI OK: context menu, real IPC read, tabs, missing file, Escape and focus",
    );
    win.destroy();
    clearTimeout(timer);
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
