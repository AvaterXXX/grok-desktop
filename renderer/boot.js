(function () {
  try {
    var t = localStorage.getItem("gd-theme") || "light";
    var p = localStorage.getItem("gd-palette") || "paper";
    var ok = { paper: 1, stone: 1, ink: 1, sage: 1, dusk: 1, clay: 1 };
    if (!ok[p]) p = "paper";
    var dark =
      t === "dark" ||
      (t === "system" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    var b = document.body;
    if (!b) return;
    b.className = b.className
      .replace(/\btheme-(?:light|dark)\b/g, "")
      .replace(/\bpalette-(?:paper|stone|ink|sage|dusk|clay)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    b.classList.add(dark ? "theme-dark" : "theme-light", "palette-" + p);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();
