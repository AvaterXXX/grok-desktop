const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanUserText } = require("../src/sessions");
const {
  cleanProjects,
  cleanSessionProjects,
  projectAccessNote,
  projectForSession,
} = require("../src/project-dirs");

test("a project keeps one name and its directories", () => {
  const projects = cleanProjects([
    {
      id: "p-good01",
      name: " 造化玉碟 ",
      dirs: ["D:\\hongjun\\造化玉碟\\", "D:\\hongjun\\造化玉碟", "not-a-path", "C:\\other"],
    },
    { id: "../x", name: "nope", dirs: ["D:\\ok"] },
  ]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "造化玉碟");
  assert.deepEqual(projects[0].dirs, ["D:\\hongjun\\造化玉碟", "C:\\other"]);
});

test("a session follows its project, then a matching directory", () => {
  const projects = [
    { id: "p-aaaa", name: "甲", dirs: ["D:\\one"] },
    { id: "p-bbbb", name: "乙", dirs: ["D:\\two", "C:\\three"] },
  ];
  const linked = projectForSession(
    { id: "01ab", cwd: "D:\\one" },
    projects,
    { "01ab": "p-bbbb" },
  );
  assert.equal(linked.name, "乙");
  const byDir = projectForSession({ id: "01ac", cwd: "C:\\three\\" }, projects, {});
  assert.equal(byDir.name, "乙");
  assert.equal(projectForSession({ id: "01ad", cwd: "C:\\missing" }, projects, {}), null);
});

test("session links drop a bad id", () => {
  assert.deepEqual(
    cleanSessionProjects({
      "01a14f85-55e6-73f2-8ba6-1208520f6836": "p-good01",
      "../bad": "p-good01",
    }),
    { "01a14f85-55e6-73f2-8ba6-1208520f6836": "p-good01" },
  );
});

test("extra directories are told to the model and hidden from the transcript", () => {
  assert.equal(projectAccessNote(["D:\\only"]), "");
  const note = projectAccessNote(["D:\\one", "C:\\two"]);
  assert.equal(note.includes("D:\\one"), true);
  assert.equal(note.includes("C:\\two"), true);
  assert.equal(cleanUserText(note + "你好"), "你好");
});
