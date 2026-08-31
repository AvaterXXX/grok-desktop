#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const legacyPath = path.join(root, "renderer", "styles.css");
const polishPath = path.join(root, "renderer", "polish.css");
const legacy = fs.readFileSync(legacyPath, "utf8");
const polish = fs.readFileSync(polishPath, "utf8");
const importantCount = (source) => (source.match(/!important/g) || []).length;
const legacyImportant = importantCount(legacy);
const polishImportant = importantCount(polish);

assert.match(legacy, /@import[^;]+layer\(vendor\)/, "Bootstrap must stay isolated in vendor layer");
assert.match(legacy, /@layer\s+vendor,\s*legacy,\s*polish\s*;/, "CSS layer order is missing");
assert.match(legacy, /@layer\s+legacy\s*\{/, "legacy stylesheet must be quarantined");
assert.match(polish, /^@layer\s+polish\s*\{/, "new UI rules must live in the polish layer");
assert.ok(legacyImportant <= 1020, `legacy !important count regressed: ${legacyImportant}`);
assert.ok(
  polishImportant <= 4,
  `new polish rules added !important declarations: ${polishImportant}`,
);
assert.match(polish, /prefers-reduced-motion:\s*reduce/, "reduced-motion fallback is missing");
assert.doesNotMatch(legacy, /session-tabs|activity-rail|tool-chip/, "retired UI CSS returned");
assert.doesNotMatch(
  legacy,
  /\.settings-main\s*\{[^}]*!important/s,
  "settings layout must not depend on !important",
);

console.log(
  `CSS AUDIT OK (legacy !important=${legacyImportant}, polish !important=${polishImportant})`,
);
