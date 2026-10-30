const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFrontmatter } = require("../src/skills");

test("folded skill descriptions keep the paragraph, not the fold marker", () => {
  const folded = parseFrontmatter(`---
name: implement
description: >-
  Run the full implement-review-fix loop using implementer and reviewer personas.
  Supports effort-based multi-reviewer scaling.
---
# Implement
`);
  assert.equal(
    folded.meta.description,
    "Run the full implement-review-fix loop using implementer and reviewer personas. Supports effort-based multi-reviewer scaling.",
  );
  assert.equal(folded.body.trim(), "# Implement");

  const plain = parseFrontmatter(`---
name: docx
description: Use this skill whenever the user wants a Word document.
---
body
`);
  assert.equal(plain.meta.description, "Use this skill whenever the user wants a Word document.");

  const quoted = parseFrontmatter(`---
name: review
description: "Review the repo"
short-description: "Short form"
---
`);
  assert.equal(quoted.meta.description, "Review the repo");
  assert.equal(quoted.meta.shortDescription, "Short form");
});
