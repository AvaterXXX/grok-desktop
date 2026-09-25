/* Passive Markdown documents: rebuild an allowlisted DOM, never attach parser output. */
(function (global) {
  const TAGS = new Set([
    "P",
    "BR",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "STRONG",
    "EM",
    "CODE",
    "PRE",
    "UL",
    "OL",
    "LI",
    "BLOCKQUOTE",
    "HR",
    "TABLE",
    "THEAD",
    "TBODY",
    "TR",
    "TH",
    "TD",
    "DIV",
  ]);
  const CLASSES = new Set([
    "md-p",
    "md-h",
    "md-code",
    "md-pre",
    "md-codeblock",
    "md-code-head",
    "md-list",
    "md-quote",
    "md-hr",
    "md-table-wrap",
    "md-table",
  ]);

  function renderMarkdownPreview(doc, text, renderer = global.renderMarkdown) {
    const raw = String(text || "");
    // Bound regex work and DOM size; larger documents remain available as source.
    if (raw.length > 128 * 1024) return null;
    const lines = raw.split("\n");
    if (lines.length > 4000 || lines.some((line) => line.length > 8192)) return null;
    let html;
    try {
      html = renderer(raw);
    } catch {
      return null;
    }
    if (html.length > 1024 * 1024) return null;
    const template = doc.createElement("template");
    // Templates are inert. Only fresh nodes with fixed tags/classes leave here.
    template.innerHTML = html;
    const result = doc.createDocumentFragment();
    let count = 0;
    function copy(source, target, depth) {
      if (depth > 60) throw new RangeError("Markdown nesting limit");
      for (const node of source.childNodes) {
        if (++count > 20000) throw new RangeError("Markdown node limit");
        if (node.nodeType === 3) target.appendChild(doc.createTextNode(node.textContent));
        else if (node.nodeType === 1 && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
          if (node.tagName === "A") {
            // No navigation, file access, downloads, URL handlers or bridge actions.
            copy(node, target, depth + 1);
          } else if (TAGS.has(node.tagName)) {
            const clean = doc.createElement(node.tagName.toLowerCase());
            for (const name of node.classList) if (CLASSES.has(name)) clean.classList.add(name);
            copy(node, clean, depth + 1);
            target.appendChild(clean);
          }
        }
      }
    }
    try {
      copy(template.content, result, 0);
    } catch {
      return null;
    }
    return result;
  }

  global.renderMarkdownPreview = renderMarkdownPreview;
})(typeof window !== "undefined" ? window : globalThis);
