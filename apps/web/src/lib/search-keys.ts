import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

/**
 * The search shortcut: ⌘K on a Mac, Ctrl K elsewhere, from any signed-in page.
 *
 * A part of the page that uses the keys itself keeps them: a key press that part already handled
 * (`preventDefault`), or one made inside an element marked `data-own-shortcuts` (the terminal
 * view, when it lands, marks itself so; a focused terminal then gets its Ctrl K). On a Mac, Ctrl K
 * is a text field's "delete to the end of the line", and is left alone.
 */

/** Marks an element whose focused contents keep ⌘K and Ctrl K for themselves. */
export const OWN_SHORTCUTS = "data-own-shortcuts";

/** The parts of a key press the shortcut reads. */
export type KeyPress = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented" | "target"
>;

export const opensSearch = (press: KeyPress, mac: boolean): boolean => {
  if (press.defaultPrevented || press.altKey || press.shiftKey) return false;
  if (press.key.toLowerCase() !== "k") return false;
  const held = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;
  if (!held) return false;
  const target = press.target;
  return !(target instanceof Element && target.closest(`[${OWN_SHORTCUTS}]`) !== null);
};

const isMac = (): boolean => /Macintosh|Mac OS X|iPhone|iPad/.test(navigator.userAgent);

const never = () => () => undefined;

/**
 * How a ⌘ shortcut is written on this computer: "⌘K" on a Mac, "Ctrl K" elsewhere. The server
 * writes "⌘K"; the browser corrects it once it has loaded.
 */
export const useKeys = (letter: string): string =>
  useSyncExternalStore(
    never,
    () => (isMac() ? `⌘${letter}` : `Ctrl ${letter}`),
    () => `⌘${letter}`,
  );

/** Calls `onOpen` when the shortcut is pressed anywhere on the page. */
export const useSearchShortcut = (onOpen: () => void): void => {
  const open = useEffectEvent(onOpen);
  // Listening to the window: a key press is not something React's state can say.
  useEffect(() => {
    const mac = isMac();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!opensSearch(event, mac)) return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};
