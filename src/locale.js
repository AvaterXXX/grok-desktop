/**
 * Open-time UI language for Grok Desktop.
 * Simplified Chinese system tags display 简体中文.
 * Traditional Chinese tags (zh-TW, zh-HK, zh-MO, zh-Hant) display 繁體中文.
 * Every other tag displays English.
 * A language picked in Settings wins over the system locale on the next open.
 * The historical default locale "zh" is not a choice: the user never selected it.
 *
 * Loaded by the renderer (window.GrokLocale) and by Node (module.exports).
 * main.js menu/tray and the renderer boot path both call resolveOpenLocale.
 */
(function initLocale(global) {
  const SIMPLIFIED_EXACT = new Set(["zh", "zh-cn", "zh-sg", "zh-hans"]);
  const TRADITIONAL_EXACT = new Set(["zh-tw", "zh-hk", "zh-mo", "zh-hant"]);

  function systemTag(tag) {
    return String(tag ?? "")
      .trim()
      .toLowerCase()
      .replace(/_/g, "-");
  }

  /** @returns {"zh"|"zh-Hant"|"en"} */
  function systemTagToUiLocale(tag) {
    const norm = systemTag(tag);
    if (!norm) return "en";
    if (SIMPLIFIED_EXACT.has(norm)) return "zh";
    if (norm.startsWith("zh-hans-") || norm.startsWith("zh-cn-") || norm.startsWith("zh-sg-")) return "zh";
    if (TRADITIONAL_EXACT.has(norm)) return "zh-Hant";
    if (
      norm.startsWith("zh-hant-") ||
      norm.startsWith("zh-tw-") ||
      norm.startsWith("zh-hk-") ||
      norm.startsWith("zh-mo-")
    ) {
      return "zh-Hant";
    }
    return "en";
  }

  /** @returns {"zh"|"zh-Hant"|"en"} */
  function normalizeUiLocale(loc) {
    if (loc === "zh" || loc === "zh-Hant" || loc === "en") return loc;
    return "zh";
  }

  /**
   * Stored settings → an explicit zh | zh-Hant | en, or "not chosen".
   * locale "en" and "zh-Hant" are always explicit: the old default was zh.
   * locale "zh" is explicit only after the control sets localeChosen.
   */
  function normalizeStoredLocale(saved) {
    const src = saved && typeof saved === "object" ? saved : {};
    if (src.locale === "en") return { locale: "en", localeChosen: true };
    if (src.locale === "zh-Hant") return { locale: "zh-Hant", localeChosen: true };
    if (src.localeChosen === true && src.locale === "zh") return { locale: "zh", localeChosen: true };
    return { locale: null, localeChosen: false };
  }

  /** @returns {"zh"|"zh-Hant"|"en"} */
  function resolveOpenLocale(saved, systemLocaleTag) {
    const stored = normalizeStoredLocale(saved);
    if (stored.localeChosen) return stored.locale;
    return systemTagToUiLocale(systemLocaleTag);
  }

  const api = {
    normalizeStoredLocale,
    normalizeUiLocale,
    resolveOpenLocale,
    systemTagToUiLocale,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) Reflect.set(global, "GrokLocale", api);
})(typeof globalThis !== "undefined" ? globalThis : this);
