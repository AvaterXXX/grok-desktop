"use strict";

function emptyCheck(error) {
  return {
    ok: false,
    current: null,
    latest: null,
    hasUpdate: false,
    installer: "",
    channel: "",
    error,
  };
}

function parseCliUpdateCheck(stdout) {
  const text = String(stdout || "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return emptyCheck("empty");
  const candidates = [text];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
  }
  let data = null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(candidates[i]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed;
        break;
      }
    } catch {
      /* keep looking for a JSON object */
    }
  }
  if (!data) return emptyCheck("invalid");
  const error = data.error == null || data.error === "" ? null : String(data.error);
  const current =
    data.currentVersion == null || data.currentVersion === "" ? null : String(data.currentVersion);
  const latest =
    data.latestVersion == null || data.latestVersion === "" ? null : String(data.latestVersion);
  const installer = data.installer == null ? "" : String(data.installer);
  const channel = data.channel == null ? "" : String(data.channel);
  const hasUpdate = !error && data.updateAvailable === true && !!latest && latest !== current;
  return {
    ok: !error,
    current,
    latest,
    hasUpdate,
    installer,
    channel,
    error,
  };
}

/** Official update command. WinGet installs ignore `grok update`. */
function cliUpdateSpawnSpec(installer, cliPath) {
  if (
    String(installer || "")
      .trim()
      .toLowerCase() === "winget"
  ) {
    return {
      command: "winget",
      args: [
        "upgrade",
        "--id",
        "xAI.GrokBuild",
        "-e",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
      shell: true,
    };
  }
  return { command: cliPath, args: ["update"], shell: false };
}

function cliUpdateShouldRestart({ installer, exitCode, before, after, output }) {
  if (Number(exitCode) !== 0) return false;
  const text = String(output || "");
  if (/installed successfully/i.test(text)) return true;
  if (/successfully installed/i.test(text)) return true;
  if (
    after &&
    after.ok &&
    before &&
    before.current &&
    after.current &&
    after.current !== before.current
  ) {
    return true;
  }
  if (/already up to date/i.test(text)) return false;
  if (after && after.ok && before && before.current && after.current === before.current)
    return false;
  return (
    String(installer || "")
      .trim()
      .toLowerCase() !== "winget"
  );
}

function cliUpdatePrompt(check, locale) {
  const zh = locale !== "en";
  const current = check && check.current ? check.current : "?";
  const latest = check && check.latest ? check.latest : "?";
  if (zh) {
    return {
      title: "Grok CLI",
      message: "发现 Grok CLI 新版本 " + latest + "（当前 " + current + "）。是否现在更新？",
      detail: "同意后会安装新版本，并自动重启应用。",
      confirm: "更新",
      cancel: "稍后",
    };
  }
  return {
    title: "Grok CLI",
    message: "Grok CLI " + latest + " is available (you have " + current + "). Update now?",
    detail: "After you confirm, the new version installs and the app restarts.",
    confirm: "Update",
    cancel: "Later",
  };
}

function cliUpdateFailureCopy(locale, detail) {
  const zh = locale !== "en";
  return {
    title: "Grok CLI",
    message: zh ? "Grok CLI 更新没有完成。" : "The Grok CLI update did not finish.",
    detail:
      detail ||
      (zh
        ? "当前版本没有变化，应用保持打开。"
        : "The installed version is unchanged and the app stays open."),
    confirm: zh ? "好" : "OK",
  };
}

module.exports = {
  parseCliUpdateCheck,
  cliUpdateSpawnSpec,
  cliUpdateShouldRestart,
  cliUpdatePrompt,
  cliUpdateFailureCopy,
};
