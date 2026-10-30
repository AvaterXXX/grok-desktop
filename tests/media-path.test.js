"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { AcpClient } = require("../src/acp");

function client() {
  return new AcpClient({ cliPath: "grok", cwd: process.cwd() });
}

function isBlocking(p) {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p) ||
    p.startsWith("//") ||
    p.startsWith("\\\\")
  );
}

test("extractMedia does not stat URLs or UNC paths", () => {
  const calls = [];
  const orig = fs.existsSync;
  fs.existsSync = (p) => {
    calls.push(String(p));
    return false;
  };
  try {
    const c = client();
    const media = [];
    c.on("mediaContent", (item) => media.push(item));
    const started = Date.now();
    c.extractMedia({
      text: "https://example.com/assets/preview.gif\n//cdn.example.com/i/abc.webp\nD:\\no\\such\\shot.png",
      nested: { path: "\\\\server\\share\\a.png" },
      web: { path: "https://example.com/pic.webp" },
    });
    assert.ok(Date.now() - started < 500);
    assert.equal(media.length, 0);
    assert.ok(calls.some((p) => p.includes("shot.png")));
    for (const p of calls) assert.equal(isBlocking(p), false, p);
  } finally {
    fs.existsSync = orig;
  }
});

test("extractMedia still shows a real local image path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-media-"));
  const file = path.join(dir, "扫码.png");
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    const c = client();
    const media = [];
    c.on("mediaContent", (item) => media.push(item));
    c.extractMedia({ text: "see " + file });
    c.extractMedia({ type: "resource", uri: pathToFileURL(file).href });
    assert.equal(media.length, 2);
    assert.equal(media[0].kind, "path");
    assert.equal(media[0].path, file);
    assert.equal(media[0].mimeType, "image/png");
    assert.equal(media[1].path, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
