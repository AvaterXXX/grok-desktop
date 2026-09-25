const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");
const { readFilePreview } = require("../src/file-preview");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "artifacts/markdown-preview");
fs.mkdirSync(output, { recursive: true });
const file = path.join(output, "文档预览.md");
const markdown = [
  "# 项目说明",
  "",
  "这是 **只读预览**，支持表格、列表和代码。",
  "",
  "| 文件 | 状态 |",
  "| --- | --- |",
  "| 中文清单.md | 已更新 |",
  "",
  "## 使用方式",
  "- 点击源码查看原文",
  "- 文档链接和图片不会触发网络请求",
  "",
  "```js",
  "const message = 'Hello';",
  "```",
].join("\n");
fs.writeFileSync(file, markdown);
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8");
const pick = (name) => {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf("\nfunction ", start + 1));
};
const attacks = [
  "<script>window.previewPwned=1</script>",
  '<img src="https://preview-test.invalid/pixel" onerror="window.previewPwned=2">',
  '<svg onload="window.previewPwned=3"><a xlink:href="javascript:alert(1)">x</a></svg>',
  '<iframe srcdoc="<script>parent.previewPwned=4</script>"></iframe>',
  '<base href="https://preview-test.invalid/"><meta http-equiv="refresh" content="0;url=https://preview-test.invalid/">',
  '<style>@import "https://preview-test.invalid/style";</style><link rel="stylesheet" href="https://preview-test.invalid/style">',
  '<form id="grokDesktop" name="document"><input autofocus onfocus="window.previewPwned=5"></form>',
  '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  "[execute](javascript:alert(1)) [data](data:text/html,test) [local](file:///C:/secret.txt)",
  "![pixel](https://preview-test.invalid/pixel) [website](https://preview-test.invalid/)",
  "`C:/secret.txt` [entity](java&#x73;cript:alert(1))",
  '<p id="app" name="grokDesktop" onclick="alert(1)" style="position:fixed" class="md-p file-link hidden" data-path="C:/secret.txt">allowed text</p>',
];
app.commandLine.appendSwitch("disable-gpu");
const timeout = setTimeout(() => app.exit(1), 30000);
app
  .whenReady()
  .then(async () => {
    let requests = 0;
    let privilegedCalls = 0;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["https://preview-test.invalid/*"] },
      (_details, callback) => {
        requests++;
        callback({ cancel: true });
      },
    );
    ipcMain.handle("file:preview", (_event, full) => readFilePreview(full));
    for (const channel of ["shell:openPath", "shell:openExternal", "shell:showItem"])
      ipcMain.handle(channel, () => {
        privilegedCalls++;
      });
    const win = new BrowserWindow({
      show: false,
      width: 1000,
      height: 800,
      webPreferences: {
        preload: path.join(root, "preload.js"),
        sandbox: true,
        contextIsolation: true,
        offscreen: true,
      },
    });
    win.webContents.on("console-message", (event) => console.log(event.message));
    // Deliberately omit CSP in this test host so CSP cannot mask a sanitizer failure.
    // Production retains its existing CSP, context isolation and sandbox.
    const hostFile = path.join(output, "test-host.html");
    const fixture = fs
      .readFileSync(path.join(root, "tests/fixtures/visual-fixture.html"), "utf8")
      .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "");
    fs.writeFileSync(hostFile, fixture);
    await win.loadFile(hostFile);
    for (const name of ["markdown", "markdown-preview"])
      await win.webContents.executeJavaScript(
        fs.readFileSync(path.join(root, `renderer/${name}.js`), "utf8"),
      );
    const result = await win.webContents.executeJavaScript(`(async () => {
    window.previewPwned=0;
    const attacks=${JSON.stringify(attacks)};
    const host=document.createElement('section');document.body.append(host);
    const forbidden='script,img,svg,math,iframe,object,embed,form,input,style,link,meta,base,a,button,video,audio';
    let safe=true;
    for(const attack of attacks){
      // Check both raw Markdown and a compromised parser output against the DOM boundary.
      for(const render of [undefined,()=>attack]){
        host.replaceChildren(renderMarkdownPreview(document,attack,render));
        if(host.querySelector(forbidden))safe=false;
        for(const el of host.querySelectorAll('*'))for(const attr of el.attributes)if(attr.name!=='class')safe=false;
        if(host.querySelector('.file-link,.hidden,[id],[name]'))safe=false;
        host.click();
      }
    }
    const bounded=renderMarkdownPreview(document,'x'.repeat(128*1024+1))===null
      &&renderMarkdownPreview(document,'['.repeat(8193))===null
      &&renderMarkdownPreview(document,'test',()=>'<p>x</p>'.repeat(10001))===null
      &&renderMarkdownPreview(document,'test',()=>'<div>'.repeat(70)+'x'+'</div>'.repeat(70))===null;
    host.remove();
    const uiLocale=()=>'zh',formatBytesUi=n=>n+' B',flashToast=()=>{},copyText=async()=>{},openLocalFilePath=async()=>{};
    ${["paintHunksInto", "closeTurnFileSheet", "openTurnFileSheet"].map(pick).join("\n")}
    openTurnFileSheet({path:${JSON.stringify(file)},edits:[]});
    for(let i=0;i<100&&!document.querySelector('.tf-file-markdown');i++)await new Promise(r=>setTimeout(r,20));
    const article=document.querySelector('.tf-file-markdown');
    const rendered=!!article?.querySelector('h1')&&!!article?.querySelector('table')&&!!article?.querySelector('pre code');
    const noUndefined=!document.querySelector('.tf-sheet-head').textContent.includes('undefined');
    const buttons=document.querySelectorAll('.tf-preview-modes button');
    buttons[1].click();
    const raw=document.querySelector('.tf-file-text');
    const sourceWorks=!raw.hidden&&article.hidden&&raw.textContent===${JSON.stringify(markdown)};
    buttons[0].click();
    const renderWorks=raw.hidden&&!article.hidden;
    await new Promise(r=>setTimeout(r,100));
    return {safe,bounded,rendered,noUndefined,sourceWorks,renderWorks,pwned:window.previewPwned};
  })()`);
    for (const key of ["safe", "bounded", "rendered", "noUndefined", "sourceWorks", "renderWorks"])
      assert.equal(result[key], true, key);
    assert.equal(result.pwned, 0);
    assert.equal(requests, 0, "Preview must not request external resources");
    assert.equal(privilegedCalls, 0, "Preview must not invoke file or URL actions");
    for (const theme of ["light", "dark"]) {
      await win.webContents.executeJavaScript(
        `document.body.className='theme-${theme} palette-paper'`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(
        path.join(output, theme + ".png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    console.log(
      "MARKDOWN PREVIEW OK: headings/tables/code, source toggle, hostile markup and parser output, size limits, no scripts/network/privileged calls",
    );
    clearTimeout(timeout);
    win.destroy();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
