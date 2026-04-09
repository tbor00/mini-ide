import { useEffect } from "react";

/**
 * Dismisses an overlay/modal when the user presses Escape.
 *
 * The listener is attached at `window` level with `capture: true` so
 * it fires even if a child element (e.g. an input or the xterm
 * textarea) has focus and is calling `stopPropagation()` in its own
 * keydown handler. The handler only fires when `active` is true so
 * multiple modals can mount without fighting over the Escape key —
 * the topmost visible one owns it.
 *
 * Usage:
 *   useEscapeKey(isOpen, onClose);
 */
export function useEscapeKey(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [active, onEscape]);
}
