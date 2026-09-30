// How much screen the app has, read from the window rather than the device model: a foldable's
// cover screen is a phone, its inner screen is two phones side by side (open flat, landscape) or
// one above the other (turned upright), and a tablet reads the same way. Every wide layout splits
// at the middle, where a foldable creases.

/**
 * - `compact`: one pane, the phone layouts.
 * - `landscape`: two panes side by side.
 * - `upright`: two panes, one above the other.
 */
export type Posture = "compact" | "landscape" | "upright";

/**
 * The narrowest window, in dp, that holds two panes. A Galaxy Z Fold's inner screen is about
 * 704 dp on its short side; its cover screen, and every phone, is under 480.
 */
export const TWO_PANE_MIN = 600;

export const postureOf = (window: { readonly width: number; readonly height: number }): Posture => {
  if (Math.min(window.width, window.height) < TWO_PANE_MIN) return "compact";
  return window.width > window.height ? "landscape" : "upright";
};
