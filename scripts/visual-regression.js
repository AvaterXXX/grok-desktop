#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "artifacts", "ui-regression");
const electron = process.env.ELECTRON_BINARY || require("electron");
const capture = path.join(__dirname, "visual-capture.js");
assert.ok(outputDir.startsWith(`${root}${path.sep}`), "visual output escaped the workspace");
fs.mkdirSync(outputDir, { recursive: true });

for (const scale of [1.25, 1.5]) {
  const result = spawnSync(electron, [capture, `--scale=${scale}`], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GROK_VISUAL_OUTPUT: outputDir },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, `visual capture failed at ${scale}x`);
}

const screenshots = fs
  .readdirSync(outputDir)
  .filter((name) => name.endsWith(".png"))
  .sort();
assert.deepEqual(screenshots, [
  "scale-125-minimum.png",
  "scale-125-wide.png",
  "scale-15-minimum.png",
  "scale-15-wide.png",
]);
fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), screenshots }, null, 2)}\n`,
);
console.log(`VISUAL REGRESSION OK (${screenshots.length} screenshots)`);
