const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "..", "renderer", "styles.css");
let s = fs.readFileSync(p, "utf8");
const mark = "/* Light theme: override hardcoded dark chrome */";
if (s.includes(mark)) {
  console.log("css already patched");
  process.exit(0);
}
const add = "

" + mark + "
" +
  "body.theme-light .settings-rail { background: var(--side); }
" +
  "body.theme-light .sn-item { color: var(--text); }
" +
  "body.theme-light .sn-item.active { color: var(--text); }
" +
  "body.theme-light .scard,
body.theme-light .embed-list { background: var(--card-bg); }
" +
  "body.theme-light .composer { background: var(--bg-elev); border-color: var(--line); }
" +
  "body.theme-light .chip { background: var(--hover); color: var(--muted); }
" +
  "body.theme-light .card-list,
body.theme-light .detail-panel { background: var(--card-bg); }
" +
  "body.theme-light .badge { background: var(--active); }
" +
  "body.theme-light .composer-mode-bar { background: rgba(255,255,255,0.88); }
";
fs.writeFileSync(p, s.replace(/s*$/, add + "
"));
console.log("css patched");
