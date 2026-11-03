import { useSyncExternalStore } from "react";

import { createLocalStore } from "./local-store.ts";

/**
 * The session view's tabs, each its own URL under `/sessions/$sessionId`. Conversation is the
 * session's own address; the others are child routes.
 */
export const SESSION_TABS = [
  { tab: "conversation", label: "Conversation", to: "/sessions/$sessionId" },
  { tab: "change", label: "Change", to: "/sessions/$sessionId/change" },
  { tab: "preview", label: "Preview", to: "/sessions/$sessionId/preview" },
  { tab: "screen", label: "Screen", to: "/sessions/$sessionId/screen" },
  { tab: "terminal", label: "Terminal", to: "/sessions/$sessionId/terminal" },
  { tab: "record", label: "Record", to: "/sessions/$sessionId/record" },
] as const;

export type SessionTab = (typeof SESSION_TABS)[number]["tab"];

/** The tabs the split view's work panel shows: every one but the conversation beside it. */
export const WORK_TABS = SESSION_TABS.filter((entry) => entry.tab !== "conversation");

/** The tabs the full-screen top bar shows (screen X6): Record stays in the windowed view. */
export const FULL_SCREEN_TABS = SESSION_TABS.filter((entry) => entry.tab !== "record");

/** Which tab a matched child route is, from its route id; the conversation when none matched. */
export const tabOfRoute = (routeId: string | undefined): SessionTab => {
  const last = routeId?.split("/").at(-1) ?? "";
  return SESSION_TABS.find((entry) => entry.tab === last)?.tab ?? "conversation";
};

/**
 * The three states of the layout control (screens C, P and X): the conversation alone, with the
 * side panel, or split beside the work panel. Kept per browser.
 */
export type SessionLayout = "chat" | "panel" | "split";

export const SESSION_LAYOUTS = [
  { value: "chat", icon: "single", label: "Conversation only" },
  { value: "panel", icon: "sidePanel", label: "Conversation and side panel" },
  { value: "split", icon: "split", label: "Conversation beside the work" },
] as const;

export const sessionLayout = createLocalStore<SessionLayout>(
  "mend-session-layout",
  (stored) => (stored === "chat" || stored === "split" ? stored : "panel"),
  "panel",
);

/** Tailwind's `md`: below it the session shows one pane at a time. */
const NARROW = "(width < 48rem)";

const subscribeToNarrow = (onChange: () => void) => {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * Whether the window is narrower than `md`, for what only the browser renders (a tab's body, the
 * side panel's contents). The server and the first client render say no: the layout itself is
 * chosen by CSS breakpoints, so the server's HTML is already right for a phone.
 */
export const useNarrow = (): boolean =>
  useSyncExternalStore(
    subscribeToNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );

/**
 * The layout the session shows. A narrow window has no room for the split view, so a stored split
 * shows as the side-panel layout there, whose side panel CSS hides below `md`. Like the stored
 * choice, this only differs from the server's render after hydration.
 */
export const useSessionLayout = (): SessionLayout => {
  const stored = sessionLayout.use();
  const narrow = useNarrow();
  return narrow && stored === "split" ? "panel" : stored;
};

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  codex: "Codex",
  claude: "Claude",
  opencode: "OpenCode",
  pi: "Pi",
  gemini: "Gemini",
};

/** The agent's name as people say it ("Codex"); a harness Mend does not know keeps its own. */
export const harnessName = (harness: string): string => HARNESS_NAMES[harness] ?? harness;

/** "11:49": the clock time a message carries. */
export const clockTime = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

/** "11:52:09": the clock time a record or screen-log row carries. */
export const clockSeconds = (date: Date): string =>
  date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

/** A text field, where a page-wide shortcut key must not fire. */
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Whether a key belongs to what it was typed in: a text field anywhere on its composed path (the
 * diff's comment boxes live in a shadow root, where the document sees only their host), or a
 * screen this viewer holds the input of.
 */
export const keyIsTaken = (event: Pick<Event, "composedPath">): boolean =>
  event
    .composedPath()
    .some(
      (target) =>
        isTyping(target) ||
        (target instanceof HTMLElement && target.hasAttribute("data-screen-input")),
    );
