const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BUILTIN,
  GROUP_ORDER,
  localizeAll,
  localizeCommand,
  filterSlashCommands,
  groupOf,
} = require("../src/commands-zh");

// 与 CLI 1.0.29 实测 ACP available_commands_update 对齐的命令名集合
const LIVE_1_0_29 = [
  "always-approve",
  "build-with-ai",
  "bundled:imagine",
  "code-review",
  "compact",
  "context",
  "create-skill",
  "create-workflow",
  "deep-research",
  "design",
  "dream",
  "execute-plan",
  "feedback",
  "flush",
  "goal",
  "implement",
  "learn",
  "learn-traces",
  "long-running-background-tasks",
  "loop",
  "memory",
  "pr-babysit",
  "resume-claude",
  "resume-codex",
  "resume-cursor",
  "review",
  "session-info",
  "skill-design-principles",
  "statusline",
  "tabbit",
  "workflow",
];

test("1.0.29 实测命令全部有中文标题（无 /name 兜底）", () => {
  const merged = localizeAll(LIVE_1_0_29.map((name) => ({ name, description: "" })));
  const byName = new Map(merged.map((c) => [c.name, c]));
  for (const name of LIVE_1_0_29) {
    const cmd = byName.get(name);
    assert.ok(cmd, `缺少命令 ${name}`);
    assert.ok(
      cmd.titleZh && !cmd.titleZh.startsWith("/") && cmd.titleZh !== `Skill · ${name}`,
      `${name} 未本地化: ${cmd.titleZh}`,
    );
    assert.ok(GROUP_ORDER.includes(groupOf(cmd)), `${name} 分组无效: ${groupOf(cmd)}`);
  }
});

test("ACP 提供的参数提示优先，本地 hint 兜底", () => {
  const merged = localizeAll([{ name: "learn", description: "", input: { hint: "ACP 提示" } }]);
  assert.equal(merged.find((c) => c.name === "learn")?.input?.hint, "ACP 提示");
  const seeded = localizeAll([]);
  const local = seeded.find((c) => c.name === "learn");
  assert.equal(local.input?.hint, "说明");
});

test("带冒号的内置命令（bundled:imagine）正常本地化并进媒体组", () => {
  const cmd = localizeCommand({ name: "bundled:imagine", description: "" });
  assert.equal(cmd.titleZh, "生成图片");
  assert.equal(groupOf(cmd), "media");
});

test("filterSlashCommands 能搜到新增命令", () => {
  const merged = localizeAll([]);
  const names = filterSlashCommands(merged, "learn").map((c) => c.name);
  assert.ok(names.includes("learn"), `应包含 learn: ${names}`);
  assert.ok(names.includes("learn-traces"), `应包含 learn-traces: ${names}`);
});

test("新命令条目字段完整（name/title/desc/group）", () => {
  const required = [
    "learn",
    "learn-traces",
    "code-review",
    "review",
    "execute-plan",
    "implement",
    "design",
    "build-with-ai",
    "pr-babysit",
    "long-running-background-tasks",
    "create-skill",
    "create-workflow",
    "skill-design-principles",
    "tabbit",
    "resume-claude",
    "resume-codex",
    "resume-cursor",
    "statusline",
    "bundled:imagine",
  ];
  const byName = new Map(BUILTIN.map((b) => [b.name, b]));
  for (const name of required) {
    const b = byName.get(name);
    assert.ok(b, `BUILTIN 缺少 ${name}`);
    assert.ok(b.title && b.desc && b.group, `${name} 字段不完整`);
  }
});
