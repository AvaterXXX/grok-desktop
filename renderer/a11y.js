(function initA11y(global) {
  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled]):not([type='hidden'])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function focusableElements(root) {
    if (!root?.querySelectorAll) return [];
    return [...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      if (element.closest("[hidden], .hidden, [inert]")) return false;
      return true;
    });
  }

  function trapTabKey(root, event) {
    if (!event || event.key !== "Tab") return false;
    const items = focusableElements(root);
    if (!items.length) {
      event.preventDefault();
      root?.focus?.();
      return true;
    }
    const active = root?.ownerDocument?.activeElement;
    let index = items.indexOf(active);
    if (index < 0) index = event.shiftKey ? 0 : items.length - 1;
    const next = event.shiftKey
      ? (index - 1 + items.length) % items.length
      : (index + 1) % items.length;
    // Only intercept at either edge; ordinary Tab inside the dialog keeps its
    // native behavior and ordering.
    if (
      !root.contains(active) ||
      (event.shiftKey && index === 0) ||
      (!event.shiftKey && index === items.length - 1)
    ) {
      event.preventDefault();
      items[next].focus();
      return true;
    }
    return false;
  }

  function nextMenuIndex(current, length, key) {
    if (!length) return -1;
    if (key === "Home") return 0;
    if (key === "End") return length - 1;
    if (key === "ArrowDown") return (Math.max(-1, current) + 1) % length;
    if (key === "ArrowUp") return (current <= 0 ? length : current) - 1;
    return current;
  }

  /**
   * @param {HTMLElement} menu
   * @param {KeyboardEvent} event
   * @param {{onEscape?: (options?: {restore?: boolean}) => void}} [options]
   */
  function handleMenuKey(menu, event, { onEscape } = {}) {
    if (!menu || !event) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape?.();
      return true;
    }
    if (event.key === "Tab") {
      onEscape?.({ restore: false });
      return false;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return false;
    const items = focusableElements(menu).filter(
      (element) => element.getAttribute("role") === "menuitem" && !element.disabled,
    );
    if (!items.length) return false;
    event.preventDefault();
    const current = items.indexOf(menu.ownerDocument.activeElement);
    items[nextMenuIndex(current, items.length, event.key)].focus();
    return true;
  }

  function restoreFocus(element) {
    if (!element?.focus || !element.isConnected) return;
    queueMicrotask(() => element.focus({ preventScroll: true }));
  }

  global.GrokA11y = {
    FOCUSABLE_SELECTOR,
    focusableElements,
    handleMenuKey,
    nextMenuIndex,
    restoreFocus,
    trapTabKey,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
