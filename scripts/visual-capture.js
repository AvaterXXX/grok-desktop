#!/usr/bin/env electron
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const root = path.resolve(__dirname, "..");
const scale = Number(process.argv.find((arg) => arg.startsWith("--scale="))?.split("=")[1]) || 1;
const outputDir = path.resolve(
  process.env.GROK_VISUAL_OUTPUT || path.join(root, "artifacts", "ui-regression"),
);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "grok-visual-capture-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("force-device-scale-factor", String(scale));

const sizes = [
  { name: "wide", width: 1280, height: 800 },
  { name: "minimum", width: 800, height: 600 },
];

async function settle(window) {
  await window.webContents.executeJavaScript(
    `new Promise(resolve => {
      const thread = document.querySelector('#thread');
      if (thread) thread.scrollTop = thread.scrollHeight;
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`,
  );
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(outputDir, { recursive: true });
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: sizes[0].width,
    height: sizes[0].height,
    backgroundColor: "#f6f3ed",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(path.join(root, "tests", "fixtures", "visual-fixture.html"));
  const results = [];
  for (const size of sizes) {
    window.setContentSize(size.width, size.height);
    await settle(window);
    const metrics = await window.webContents.executeJavaScript(`(() => {
      const rect = selector => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      return {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        collapsedThought: getComputedStyle(document.querySelector('#fixture-thought-closed .thought')).display,
        secondThought: getComputedStyle(document.querySelector('#fixture-thought-second .thought')).display,
        successfulDiffStatus: getComputedStyle(document.querySelector('#fixture-diff-success .d-status')).display,
        duplicateEditTools: document.querySelectorAll('.tool-card[data-id="edit-1"]').length,
        completedToolGroupBody: getComputedStyle(document.querySelector('#fixture-completed-tools .tool-group-body')).display,
        orderedSegments: (() => {
          const children = [...document.querySelector('.thread-inner').children];
          return [
            children.indexOf(document.querySelector('#fixture-thought-closed')),
            children.indexOf(document.querySelector('.tool-group')),
            children.indexOf(document.querySelector('#fixture-diff-success')),
            children.indexOf(document.querySelector('#fixture-thought-second')),
            children.indexOf(document.querySelector('#fixture-final'))
          ];
        })(),
        sidebar: rect('#sidebar'),
        finalAnswer: rect('#fixture-final'),
        composer: rect('#composer')
      };
    })()`);
    assert.ok(metrics.width >= size.width - 2, `unexpected viewport width: ${metrics.width}`);
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `horizontal overflow at ${size.name}`);
    assert.equal(metrics.collapsedThought, "none", "collapsed thought is visible");
    assert.equal(metrics.secondThought, "none", "second collapsed thought is visible");
    assert.equal(metrics.successfulDiffStatus, "none", "successful edits show a redundant status");
    assert.equal(metrics.duplicateEditTools, 0, "edit has both a tool card and a diff card");
    assert.equal(
      metrics.completedToolGroupBody,
      "none",
      "completed tool group is expanded by default",
    );
    assert.deepEqual(
      metrics.orderedSegments,
      [1, 2, 3, 4, 5],
      "thought/tool timeline is out of order",
    );
    assert.ok(metrics.finalAnswer?.width > 120, "final answer is not visible");
    assert.ok(metrics.composer?.bottom <= metrics.height + 1, "composer is outside the viewport");
    assert.ok(
      metrics.finalAnswer?.bottom <= metrics.composer?.top + 1,
      "final answer is obscured by the composer",
    );
    assert.ok(Math.abs(metrics.dpr - scale) < 0.2, `expected DPR ${scale}, got ${metrics.dpr}`);

    const image = await window.webContents.capturePage();
    assert.equal(image.isEmpty(), false);
    const png = image.toPNG();
    assert.ok(png.length > 20_000, `screenshot looks empty (${png.length} bytes)`);
    const name = `scale-${String(scale).replace(".", "")}-${size.name}.png`;
    fs.writeFileSync(path.join(outputDir, name), png);
    results.push({ name, bytes: png.length, metrics });
  }
  console.log(JSON.stringify({ electron: process.versions.electron, scale, results }));
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
    /* temporary test data only */
  }
});
