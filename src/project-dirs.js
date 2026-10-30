(function initProjectDirs(global) {
  function trimDir(value) {
    let text = String(value || "").trim();
    while (text.length > 3 && (text.endsWith("/") || text.endsWith("\\"))) text = text.slice(0, -1);
    return text;
  }

  function dirKey(value) {
    return trimDir(value).toLowerCase();
  }

  function isLocalDir(value) {
    const full = trimDir(value);
    if (!full || full.length > 1024) return false;
    if (full.startsWith("/")) return true;
    if (full.length < 3) return false;
    const c0 = full.charCodeAt(0);
    const letter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
    if (!letter || full.charCodeAt(1) !== 58) return false;
    const sep = full.charCodeAt(2);
    return sep === 47 || sep === 92;
  }

  function validProjectId(id) {
    return /^p-[A-Za-z0-9_-]{4,40}$/.test(String(id || ""));
  }

  function validSessionId(id) {
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(String(id || ""));
  }

  function cleanProjects(value) {
    const list = Array.isArray(value) ? value : [];
    const out = [];
    const seenIds = new Set();
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const id = String(item.id || "").trim();
      const name = String(item.name || "").trim().slice(0, 80);
      if (!validProjectId(id) || !name || seenIds.has(id)) continue;
      const dirs = [];
      const seenDirs = new Set();
      const rawDirs = Array.isArray(item.dirs) ? item.dirs : [];
      for (const dir of rawDirs) {
        const full = trimDir(dir);
        const key = dirKey(full);
        if (!isLocalDir(full) || !key || seenDirs.has(key)) continue;
        seenDirs.add(key);
        dirs.push(full);
        if (dirs.length >= 24) break;
      }
      if (!dirs.length) continue;
      seenIds.add(id);
      out.push({ id, name, dirs });
      if (out.length >= 200) break;
    }
    return out;
  }

  function cleanSessionProjects(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    let kept = 0;
    for (const [sessionId, projectId] of Object.entries(value)) {
      if (kept >= 500) break;
      if (!validSessionId(sessionId) || !validProjectId(projectId)) continue;
      out[sessionId] = projectId;
      kept += 1;
    }
    return out;
  }

  function projectForSession(session, projects, sessionProjects) {
    const list = cleanProjects(projects);
    const map = cleanSessionProjects(sessionProjects);
    const linked = session && map[session.id];
    if (linked) {
      const hit = list.find((item) => item.id === linked);
      if (hit) return hit;
    }
    const key = dirKey(session && session.cwd);
    if (!key) return null;
    return list.find((item) => item.dirs.some((dir) => dirKey(dir) === key)) || null;
  }

  function projectAccessNote(dirs) {
    const list = [];
    const seen = new Set();
    for (const dir of Array.isArray(dirs) ? dirs : []) {
      const full = trimDir(dir);
      const key = dirKey(full);
      if (!isLocalDir(full) || !key || seen.has(key)) continue;
      seen.add(key);
      list.push(full);
    }
    if (list.length < 2) return "";
    return (
      "<user_info>\nAdditional project directories you can read and write:\n" +
      list.map((dir) => "- " + dir).join("\n") +
      "\n</user_info>\n"
    );
  }

  const api = {
    trimDir,
    dirKey,
    isLocalDir,
    cleanProjects,
    cleanSessionProjects,
    projectForSession,
    projectAccessNote,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) Reflect.set(global, "GrokProjectDirs", api);
})(typeof globalThis !== "undefined" ? globalThis : this);
