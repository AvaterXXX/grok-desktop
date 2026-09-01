(function initHistoryModel(global) {
  function tailHistoryFrom(list, page = 40) {
    const n = Array.isArray(list) ? list.length : 0;
    if (n <= page) return 0;
    let lastUser = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (list[i]?.role === "user") {
        lastUser = i;
        break;
      }
    }
    const floor = Math.max(0, n - page);
    return lastUser >= 0 ? Math.min(floor, lastUser) : floor;
  }

  function parseSessionTs(value) {
    if (value == null || value === "") return NaN;
    if (typeof value === "number" && Number.isFinite(value))
      return value < 1e12 ? value * 1000 : value;
    const normalized = String(value).replace(/(\.\d{3})\d+/, "$1");
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }

  function mapAssetsToMessageIndex(listInput, imagesInput, sessionMeta, now = Date.now()) {
    const list = Array.isArray(listInput) ? listInput : [];
    const images = Array.isArray(imagesInput) ? imagesInput : [];
    const count = Math.max(1, list.length);
    let start = parseSessionTs(sessionMeta?.createdAt);
    let end = parseSessionTs(sessionMeta?.updatedAt);
    if (!Number.isFinite(start) && images[0]?.mtimeMs) start = images[0].mtimeMs;
    if (!Number.isFinite(end) && images[images.length - 1]?.mtimeMs)
      end = images[images.length - 1].mtimeMs;
    if (!Number.isFinite(start)) start = now - 3_600_000;
    if (!Number.isFinite(end) || end <= start) end = start + 3_600_000;
    const span = Math.max(1, end - start);
    const byIndex = new Map();

    for (const asset of images) {
      let index = -1;
      const name = asset?.name || "";
      const stem = name.replace(/\.\w+$/, "");
      if (name) {
        for (let i = 0; i < list.length; i++) {
          const text = list[i]?.text || "";
          if (text.includes(name) || (stem && text.includes(stem))) {
            index = i;
            break;
          }
        }
      }
      if (index < 0) {
        const mtime = Number(asset?.mtimeMs) || start;
        const fraction = Math.min(1, Math.max(0, (mtime - start) / span));
        index = Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
      }
      if (list[index]?.role !== "user") {
        let pinned = -1;
        for (let i = index; i >= 0; i--) {
          if (list[i]?.role === "user") {
            pinned = i;
            break;
          }
        }
        if (pinned < 0) {
          for (let i = index + 1; i < list.length; i++) {
            if (list[i]?.role === "user") {
              pinned = i;
              break;
            }
          }
        }
        if (pinned >= 0) index = pinned;
      }
      if (list[index]?.role !== "user") continue;
      if (!byIndex.has(index)) byIndex.set(index, []);
      byIndex.get(index).push(asset);
    }
    return byIndex;
  }

  global.GrokHistoryModel = {
    mapAssetsToMessageIndex,
    parseSessionTs,
    tailHistoryFrom,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
