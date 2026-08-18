/**
 * Safe subset of GFM for chat bubbles. Escapes first; never injects raw HTML.
 * Fences are parsed line-by-line so Cursor/GitHub citations like
 * ```12:34:path/to/file.java work (the old \w* regex ate the rest of the message).
 */
(function (global) {
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function looksLikeMarkdown(text) {
    const t = String(text || "");
    return /(^|\n)#{1,6}\s|(^|\n)```|(^|\n)(?:[-*+]|\d+\.)\s|(^|\n)\|.+\||\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|(^|\n)>\s/.test(
      t,
    );
  }

  function inline(escaped) {
    let s = escaped;
    s = s.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a class="msg-link" href="$2" rel="noopener noreferrer">$1</a>',
    );
    s = s.replace(/(^|[^"'>=])(https?:\/\/[^\s<]+)/g, (_, pre, url) => {
      let u = url;
      let trail = "";
      while (u.length > 8 && /[),.;:!?，。；：！？]$/.test(u)) {
        trail = u.slice(-1) + trail;
        u = u.slice(0, -1);
      }
      return `${pre}<a class="msg-link" href="${u}" rel="noopener noreferrer">${u}</a>${trail}`;
    });
    return s;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line);
  }

  function splitCells(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  }

  function renderTable(rawLines) {
    if (rawLines.length < 2 || !isTableSep(rawLines[1])) return null;
    const header = splitCells(rawLines[0]).map(escapeHtml);
    const rows = rawLines.slice(2).map((ln) => splitCells(ln).map(escapeHtml));
    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (const h of header) html += `<th>${inline(h)}</th>`;
    html += "</tr></thead><tbody>";
    for (const row of rows) {
      html += "<tr>";
      for (let i = 0; i < header.length; i += 1) html += `<td>${inline(row[i] || "")}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table></div>";
    return html;
  }

  function parseFenceInfo(info) {
    const raw = String(info || "").trim();
    const cite = raw.match(/^(\d+):(\d+):(.+)$/);
    if (cite) {
      const path = cite[3].trim();
      const ext = path.match(/\.([A-Za-z0-9]+)$/);
      return { lang: ext ? ext[1] : "", path, start: cite[1], end: cite[2] };
    }
    const lang = raw.split(/\s+/)[0] || "";
    return { lang, path: "", start: "", end: "" };
  }

  function renderFence(info, code) {
    const meta = parseFenceInfo(info);
    const body = escapeHtml(String(code || "").replace(/\n$/, ""));
    const lang = escapeHtml(meta.lang || "");
    let head = "";
    if (meta.path) {
      const range = meta.start && meta.end ? ` L${meta.start}–${meta.end}` : "";
      head = `<div class="md-code-head">${escapeHtml(meta.path)}${range}</div>`;
    } else if (meta.lang) {
      head = `<div class="md-code-head">${lang}</div>`;
    }
    return `<div class="md-codeblock">${head}<pre class="md-pre"><code class="lang-${lang}">${body}</code></pre></div>`;
  }

  function extractFences(raw) {
    const lines = String(raw || "").split("\n");
    const fences = [];
    const kept = [];
    let i = 0;
    while (i < lines.length) {
      const open = lines[i].match(/^ {0,3}```(.*)$/);
      if (open) {
        const info = open[1] || "";
        const body = [];
        i += 1;
        while (i < lines.length && !/^ {0,3}```/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const idx = fences.length;
        fences.push(renderFence(info, body.join("\n")));
        kept.push(`%%FENCE${idx}%%`);
        continue;
      }
      kept.push(lines[i]);
      i += 1;
    }
    return { src: kept.join("\n"), fences };
  }

  function renderMarkdown(text) {
    const raw = String(text || "").replace(/\r\n/g, "\n");
    if (!raw) return "";

    const { src, fences } = extractFences(raw);
    const lines = src.split("\n");
    const out = [];
    let i = 0;

    const flushPara = (buf) => {
      if (!buf.length) return;
      out.push(`<p class="md-p">${inline(escapeHtml(buf.join("\n"))).replace(/\n/g, "<br>")}</p>`);
      buf.length = 0;
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.trim().match(/^%%FENCE(\d+)%%$/);
      if (fence) {
        flushPara(out._para || (out._para = []));
        out.push(fences[Number(fence[1])] || "");
        i += 1;
        continue;
      }
      if (!line.trim()) {
        flushPara(out._para || (out._para = []));
        i += 1;
        continue;
      }
      if (/^\s*\|.+\|/.test(line)) {
        const block = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          block.push(lines[i]);
          i += 1;
        }
        const table = renderTable(block);
        if (table) {
          flushPara(out._para || (out._para = []));
          out.push(table);
          continue;
        }
        (out._para || (out._para = [])).push(...block);
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line)) {
        flushPara(out._para || (out._para = []));
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(`<li>${inline(escapeHtml(lines[i].replace(/^\s*[-*+]\s+/, "")))}</li>`);
          i += 1;
        }
        out.push(`<ul class="md-list">${items.join("")}</ul>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        flushPara(out._para || (out._para = []));
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${inline(escapeHtml(lines[i].replace(/^\s*\d+\.\s+/, "")))}</li>`);
          i += 1;
        }
        out.push(`<ol class="md-list">${items.join("")}</ol>`);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flushPara(out._para || (out._para = []));
        const n = heading[1].length;
        out.push(`<h${n} class="md-h">${inline(escapeHtml(heading[2]))}</h${n}>`);
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        flushPara(out._para || (out._para = []));
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          q.push(lines[i].replace(/^>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote class="md-quote">${inline(escapeHtml(q.join("\n"))).replace(/\n/g, "<br>")}</blockquote>`);
        continue;
      }
      if (/^\s*([-*_])\1\1+\s*$/.test(line)) {
        flushPara(out._para || (out._para = []));
        out.push('<hr class="md-hr">');
        i += 1;
        continue;
      }
      (out._para || (out._para = [])).push(line);
      i += 1;
    }
    flushPara(out._para || (out._para = []));
    delete out._para;
    return out.join("");
  }

  global.renderMarkdown = renderMarkdown;
  global.looksLikeMarkdown = looksLikeMarkdown;
})(typeof window !== "undefined" ? window : globalThis);
