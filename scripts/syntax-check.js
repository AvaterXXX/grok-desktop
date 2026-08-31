#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const roots = ["main.js", "preload.js", "renderer", "src", "scripts", "tests"];
const files = [];

function collect(target) {
  const full = path.join(root, target);
  const st = fs.statSync(full);
  if (st.isFile()) {
    if (full.endsWith(".js")) files.push(full);
    return;
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    collect(path.relative(root, path.join(full, entry.name)));
  }
}

for (const target of roots) collect(target);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}
console.log(`SYNTAX CHECK OK (${files.length} files)`);
