const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { migrateDesktopSettings } = require("../src/settings");
const { resolveOpenLocale, systemTagToUiLocale } = require("../src/locale");

const root = path.join(__dirname, "..");

const SIMPLIFIED = [
  "zh-CN",
  "zh-Hans-CN",
  "zh-SG",
  "zh",
  "zh_CN",
  "zh-Hans",
  "zh-Hans-SG",
  "zh_Hans_CN",
  "ZH-CN",
  "zh_sg",
];
const TRADITIONAL = [
  "zh-TW",
  "zh-HK",
  "zh-MO",
  "zh-Hant",
  "zh-Hant-TW",
  "zh_TW",
  "zh-HK-Hant",
  "ZH-TW",
];
const OTHER = ["en-US", "en-GB", "ja-JP", "ko", "fr", "yue", "zh-yue", ""];

test("open-time locale is Simplified, Traditional, or English", () => {
  for (const tag of SIMPLIFIED) {
    assert.equal(systemTagToUiLocale(tag), "zh", tag);
    assert.equal(resolveOpenLocale(null, tag), "zh", tag);
    assert.equal(resolveOpenLocale({ locale: "zh" }, tag), "zh", tag);
  }
  for (const tag of TRADITIONAL) {
    assert.equal(systemTagToUiLocale(tag), "zh-Hant", tag);
    assert.equal(resolveOpenLocale(null, tag), "zh-Hant", tag);
    assert.equal(resolveOpenLocale({ locale: "zh" }, tag), "zh-Hant", tag);
  }
  for (const tag of OTHER) {
    assert.equal(systemTagToUiLocale(tag), "en", JSON.stringify(tag));
    assert.equal(resolveOpenLocale({}, tag), "en", JSON.stringify(tag));
  }
  assert.equal(resolveOpenLocale(undefined, undefined), "en");
  assert.equal(resolveOpenLocale(null, null), "en");
  assert.equal(systemTagToUiLocale(undefined), "en");
});

test("an explicit Settings choice wins over the system locale", () => {
  assert.equal(resolveOpenLocale({ locale: "en" }, "zh-CN"), "en");
  assert.equal(resolveOpenLocale({ locale: "en", localeChosen: true }, "zh-Hans-CN"), "en");
  assert.equal(resolveOpenLocale({ locale: "zh", localeChosen: true }, "en-US"), "zh");
  assert.equal(resolveOpenLocale({ locale: "zh", localeChosen: true }, "zh-TW"), "zh");
  assert.equal(resolveOpenLocale({ locale: "zh-Hant" }, "zh-CN"), "zh-Hant");
  assert.equal(resolveOpenLocale({ locale: "zh" }, "zh-TW"), "zh-Hant");

  const implicitZh = migrateDesktopSettings({ version: 2, locale: "zh" });
  assert.equal(implicitZh.localeChosen, false);
  assert.equal(implicitZh.locale, null);
  assert.equal(resolveOpenLocale(implicitZh, "en-US"), "en");
  assert.equal(resolveOpenLocale(implicitZh, "zh-CN"), "zh");
  assert.equal(resolveOpenLocale(implicitZh, "zh-TW"), "zh-Hant");
  assert.equal(resolveOpenLocale(implicitZh, "ja-JP"), "en");

  const keptImplicit = migrateDesktopSettings({ ...implicitZh, theme: "dark" });
  assert.equal(keptImplicit.localeChosen, false);
  assert.equal(resolveOpenLocale(keptImplicit, "fr"), "en");

  const explicitZh = migrateDesktopSettings({ version: 2, locale: "zh", localeChosen: true });
  assert.equal(explicitZh.locale, "zh");
  assert.equal(explicitZh.localeChosen, true);
  assert.equal(resolveOpenLocale(explicitZh, "en-US"), "zh");
  assert.equal(resolveOpenLocale(explicitZh, "zh-HK"), "zh");
  const keptZh = migrateDesktopSettings({ ...explicitZh, density: "compact" });
  assert.equal(resolveOpenLocale(keptZh, "en-GB"), "zh");

  const explicitHant = migrateDesktopSettings({ version: 2, locale: "zh-Hant" });
  assert.equal(explicitHant.locale, "zh-Hant");
  assert.equal(explicitHant.localeChosen, true);
  assert.equal(resolveOpenLocale(explicitHant, "zh-CN"), "zh-Hant");
  const keptHant = migrateDesktopSettings({ ...explicitHant, theme: "light" });
  assert.equal(resolveOpenLocale(keptHant, "en-US"), "zh-Hant");

  const explicitEn = migrateDesktopSettings({ version: 2, locale: "en" });
  assert.equal(explicitEn.locale, "en");
  assert.equal(explicitEn.localeChosen, true);
  assert.equal(resolveOpenLocale(explicitEn, "zh-CN"), "en");
  assert.equal(resolveOpenLocale(explicitEn, "zh-TW"), "en");
  const keptEn = migrateDesktopSettings({ ...explicitEn, theme: "light" });
  assert.equal(resolveOpenLocale(keptEn, "zh-SG"), "en");
});

test("startup, menu, and the settings control call the shipped decision", () => {
  const mainSrc = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(root, "renderer", "app.js"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(root, "src", "settings.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");

  assert.match(mainSrc, /function uiLocale\(\) \{[\s\S]*?resolveOpenLocale\(/);
  // Tray/menu copy goes through L(en, zh) so traditional Chinese is covered;
  // the old boolean helper would have skipped that conversion.
  assert.match(mainSrc, /function L\(en, zh\) \{[\s\S]*?toTraditional\(zh\)/);
  assert.doesNotMatch(mainSrc, /function isZh\(\)/);
  assert.match(mainSrc, /"locale" in partial[\s\S]{0,120}installAppMenu\(\)/);
  assert.match(mainSrc, /"locale" in partial[\s\S]{0,180}refreshTrayMenu\(\)/);
  assert.match(appSrc, /window\.GrokLocale\.resolveOpenLocale\(saved, tag\)/);
  assert.match(appSrc, /saveDesktopSettings\(\{ locale: next, localeChosen: true \}\)/);
  assert.match(
    appSrc,
    /addEventListener\("change", \(\) => \{\s*applyLocale\(\$\("set-locale"\)\.value, \{ persist: true \}\);/,
  );
  assert.match(appSrc, /normalizeUiLocale/);
  assert.match(settingsSrc, /normalizeStoredLocale\(input\)/);
  assert.match(settingsSrc, /locale:\s*null/);
  assert.doesNotMatch(mainSrc, /locale === "en" \? "en" : "zh"/);
  assert.doesNotMatch(appSrc, /locale === "en" \? "en" : "zh"/);
  assert.doesNotMatch(settingsSrc, /locale === "en" \? "en" : "zh"/);

  const localePos = html.indexOf("../src/locale.js");
  const hantPos = html.indexOf("../src/zh-hant.js");
  const i18nPos = html.indexOf("i18n.js");
  assert.ok(localePos >= 0 && hantPos > localePos && i18nPos > hantPos);

  const general = html.slice(html.indexOf('id="panel-general"'));
  const select = general.slice(general.indexOf('id="set-locale"'), general.indexOf("</select>"));
  assert.match(select, /<option value="zh">简体中文<\/option>/);
  assert.match(select, /<option value="zh-Hant">繁體中文<\/option>/);
  assert.match(select, /<option value="en">English<\/option>/);
});

test("catalog strings switch with setLocale", () => {
  const localeSrc = fs.readFileSync(path.join(root, "src", "locale.js"), "utf8");
  const hantSrc = fs.readFileSync(path.join(root, "src", "zh-hant.js"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(root, "renderer", "i18n.js"), "utf8");
  const sandbox = { navigator: { language: "en-US" } };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(localeSrc, sandbox);
  vm.runInContext(hantSrc, sandbox);
  vm.runInContext(i18nSrc, sandbox);
  const G = sandbox.GrokI18n || sandbox.window.GrokI18n;
  assert.equal(typeof G.t, "function");
  assert.equal(typeof sandbox.GrokLocale.systemTagToUiLocale, "function");
  assert.equal(typeof sandbox.GrokZhHant.toTraditional, "function");

  let calls = 0;
  const shipped = sandbox.GrokLocale.systemTagToUiLocale;
  sandbox.GrokLocale.systemTagToUiLocale = (tag) => {
    calls += 1;
    return shipped(tag);
  };
  for (const tag of [...SIMPLIFIED, ...TRADITIONAL, ...OTHER]) {
    sandbox.navigator.language = tag;
    assert.equal(G.detectLocale(), shipped(tag), JSON.stringify(tag));
  }
  sandbox.navigator.language = undefined;
  assert.equal(G.detectLocale(), "en");
  assert.ok(calls > 0);

  G.setLocale("en");
  assert.equal(G.t("nav.settings"), "Settings");
  assert.equal(G.t("settings.language"), "Language");
  G.setLocale("zh");
  assert.equal(G.t("nav.settings"), "设置");
  assert.equal(G.t("settings.language"), "界面语言");
  G.setLocale("zh-Hant");
  assert.equal(G.getLocale(), "zh-Hant");
  assert.equal(G.t("nav.settings"), "設定");
  assert.equal(G.t("settings.language"), "介面語言");
  assert.match(G.t("settings.languageDesc"), /繁體中文/);
  assert.equal(G.t("ctx.pin"), "置頂");
  assert.equal(G.t("ctx.archive"), "歸檔");
});
