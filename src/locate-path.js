const fs = require("fs");
const path = require("path");

function statPath(candidate) {
  fs.statSync(candidate);
  return candidate;
}

function isRemote(value) {
  const slash = String.fromCharCode(47);
  const head = String(value || "");
  const scheme = ":" + slash + slash;
  return (
    (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(head) && head.includes(scheme)) ||
    head.startsWith(slash + slash) ||
    head.startsWith("\\\\")
  );
}

function missingSuffix(resolved) {
  const root = path.parse(resolved).root;
  let dir = path.dirname(resolved);
  const tail = [path.basename(resolved)];
  while (dir.length > root.length && !fs.existsSync(dir)) {
    tail.push(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return tail.reverse().join(path.sep);
}

function matchesRequest(candidate, suffix) {
  const norm = path.normalize(candidate).toLowerCase();
  const tail = String(suffix || "").toLowerCase();
  if (!tail) return false;
  const sep = path.sep.toLowerCase();
  if (norm === tail || norm.endsWith(sep + tail)) return true;
  if (tail.includes(sep) || tail.includes("/")) return false;
  const base = path.basename(norm);
  if (base === tail) return true;
  return tail.startsWith(".") && tail.slice(1).includes(".") && base.endsWith(tail);
}

function matchHint(resolved, hints) {
  if (!Array.isArray(hints) || !hints.length) return null;
  const suffix = missingSuffix(resolved);
  const hits = [];
  const seen = new Set();
  for (const hint of hints) {
    if (typeof hint !== "string" || isRemote(hint)) continue;
    let candidate;
    try {
      candidate = statPath(path.resolve(hint));
    } catch {
      continue;
    }
    if (!matchesRequest(candidate, suffix)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(candidate);
    if (hits.length > 1) return null;
  }
  return hits.length === 1 ? hits[0] : null;
}

function findOneLevel(resolved) {
  const root = path.parse(resolved).root;
  let dir = path.dirname(resolved);
  const tail = [path.basename(resolved)];
  while (dir.length > root.length && !fs.existsSync(dir)) {
    tail.push(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  if (!dir || dir === root || !fs.existsSync(dir)) return null;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const rest = tail.reverse();
  const hits = [];
  for (const name of names) {
    const candidate = path.resolve(dir, name, ...rest);
    const rel = path.relative(dir, candidate);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    try {
      fs.statSync(candidate);
    } catch {
      continue;
    }
    hits.push(candidate);
    if (hits.length > 1) return null;
  }
  return hits.length === 1 ? hits[0] : null;
}

function locateExistingPath(full, hints) {
  const raw = String(full || "");
  if (isRemote(raw)) return null;
  const resolved = path.resolve(raw);
  if (isRemote(resolved)) return null;
  try {
    return statPath(resolved);
  } catch {
    /* the joined path is not on disk */
  }
  const hinted = matchHint(resolved, hints);
  if (hinted) return hinted;
  return findOneLevel(resolved);
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "release",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  "coverage",
  "vendor",
  "build",
  ".cache",
  "out",
]);
const indexCache = new Map();

function tooBroad(dir) {
  const root = path.parse(dir).root;
  if (!dir || comparableDir(dir) === comparableDir(root)) return true;
  const parts = path.relative(root, dir).split(path.sep).filter(Boolean);
  if (parts.length < 2) return true;
  const top = parts[0].toLowerCase();
  if (
    parts.length === 2 &&
    (top === "users" ||
      top === "windows" ||
      top === "program files" ||
      top === "program files (x86)" ||
      top === "programdata")
  ) {
    return true;
  }
  return false;
}

function comparableDir(dir) {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hitsFor(record, suffix) {
  const tail = String(suffix || "").toLowerCase();
  if (!tail) return [];
  const sep = path.sep.toLowerCase();
  const single = !tail.includes(sep) && !tail.includes("/");
  const dotted = single && tail.startsWith(".") && tail.indexOf(".", 1) !== -1;
  if (single && !dotted) return record.byBase.get(tail) || [];
  const hits = [];
  for (const file of record.files) {
    const norm = file.toLowerCase();
    const base = path.basename(norm);
    const ok = single ? base.endsWith(tail) : (norm.endsWith(sep + tail) || norm.endsWith("/" + tail));
    if (!ok) continue;
    hits.push(file);
    if (hits.length > 1) break;
  }
  return hits;
}

async function buildIndex(anchor) {
  const byBase = new Map();
  const files = [];
  const started = Date.now();
  let incomplete = false;
  let ops = 0;
  async function walk(dir, depth) {
    if (incomplete || depth > 8) return;
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (incomplete) return;
      if (SKIP_DIRS.has(ent.name) || ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      ops += 1;
      if (ops % 80 === 0) {
        if (Date.now() - started > 12000) {
          incomplete = true;
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (ent.isFile()) {
        files.push(full);
        const key = ent.name.toLowerCase();
        const list = byBase.get(key);
        if (list) list.push(full);
        else byBase.set(key, [full]);
      }
    }
  }
  await walk(anchor, 0);
  return { byBase, files, incomplete };
}

function indexAnchor(anchor) {
  const key = comparableDir(anchor);
  const cached = indexCache.get(key);
  if (cached && cached.value && cached.expires > Date.now()) return Promise.resolve(cached.value);
  if (cached && cached.pending) return cached.pending;
  const pending = buildIndex(anchor).then((value) => {
    if (!value.incomplete) {
      indexCache.set(key, { expires: Date.now() + 120000, value });
      while (indexCache.size > 4) {
        const first = indexCache.keys().next().value;
        indexCache.delete(first);
      }
    } else if (indexCache.get(key)?.pending) {
      indexCache.delete(key);
    }
    return value;
  });
  indexCache.set(key, { pending, expires: 0 });
  return pending;
}

async function locateDeep(full) {
  const raw = String(full || "");
  if (isRemote(raw)) return null;
  const resolved = path.resolve(raw);
  if (isRemote(resolved)) return null;
  const root = path.parse(resolved).root;
  let dir = path.dirname(resolved);
  const tail = [path.basename(resolved)];
  while (dir.length > root.length && !fs.existsSync(dir)) {
    if (isRemote(dir)) return null;
    tail.push(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  if (!dir || comparableDir(dir) === comparableDir(root) || tooBroad(dir) || isRemote(dir)) return null;
  if (!fs.existsSync(dir)) return null;
  const record = await indexAnchor(dir);
  if (!record || record.incomplete) return null;
  const hits = hitsFor(record, tail.reverse().join(path.sep));
  return hits.length === 1 ? hits[0] : null;
}

async function locateNamedInDirs(dirs, baseName) {
  const want = String(baseName || "").toLowerCase();
  if (!want || want.includes("/") || want.includes("\\") || want === "." || want === "..") return [];
  const hits = [];
  const seen = new Set();
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    if (typeof dir !== "string" || !dir || isRemote(dir) || tooBroad(dir) || !fs.existsSync(dir)) continue;
    let record;
    try {
      record = await indexAnchor(dir);
    } catch {
      continue;
    }
    if (!record || record.incomplete) continue;
    for (const file of record.byBase.get(want) || []) {
      const key = comparableDir(file);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(file);
      if (hits.length >= 8) return hits;
    }
  }
  return hits;
}

module.exports = { locateExistingPath, locateDeep, locateNamedInDirs };
