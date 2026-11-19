import type { PersonSettingsDto } from "./api.ts";

/**
 * Your automation (Settings → Account → Your automation; docs/adr/0025-one-home-per-setting.md):
 * what Mend does in a person's sessions without being asked, as plain switches that are theirs on
 * every device. `PUT /me/automation` saves all five values at once and refuses a null, so a switch
 * sends every value with its own changed.
 *
 * The page shows three of the five. "Name the session" (`autoName`) and "Background sessions"
 * (`backgroundSessions`) have no switch (ADR 0025, decision 2) but installed CLIs still read them,
 * so a save sends them back exactly as the server holds them.
 */

/** The automation values the page has a switch for, in the frame's order. */
export type AutomationKey = "autoTour" | "autoSuggest" | "autoLand";

export interface AutomationSwitch {
  readonly key: AutomationKey;
  readonly label: string;
  readonly description: string;
}

/** Under Review: what Mend writes after each turn. */
export const REVIEW_SWITCHES: ReadonlyArray<AutomationSwitch> = [
  {
    key: "autoTour",
    label: "Change description and tour",
    description: "Mend writes a description of the change and suggests an order to read its files.",
  },
  {
    key: "autoSuggest",
    label: "Suggested fixes",
    description: "Mend drafts a fix for each problem it finds.",
  },
];

/** Under Landing. The composer starts from it; the session keeps what was picked. */
export const LANDING_SWITCH: AutomationSwitch = {
  key: "autoLand",
  label: "Automatic landing",
  description:
    "When a turn that asked for a change completes, Mend pushes it and opens a pull request.",
};

/** Under T3 Code: `stopSessionOnSettle` in the person's settle settings, its own document. */
export const SETTLE_SWITCH = {
  label: "Stop the session when you settle its thread",
  description:
    "When you use Settle thread in T3 Code, Mend also stops that thread's session, the way Stop session does, and keeps its work. If the agent is still working, the session keeps running until the usual inactivity rules stop it.",
} as const;

/** The whole value to save: what the server holds, with one switch changed. */
export const withSwitch = (
  current: PersonSettingsDto,
  key: AutomationKey,
  on: boolean,
): PersonSettingsDto => ({
  autoTour: current.autoTour,
  autoSuggest: current.autoSuggest,
  autoName: current.autoName,
  autoLand: current.autoLand,
  backgroundSessions: current.backgroundSessions,
  [key]: on,
});

/** What the toast says once a switch is saved. */
export const savedWords = (key: AutomationKey | "stopSessionOnSettle", on: boolean): string => {
  switch (key) {
    case "autoTour":
      return on
        ? "Mend will write a description and tour of your changes."
        : "Mend won't write a description and tour of your changes.";
    case "autoSuggest":
      return on
        ? "Mend will draft a fix for each problem it finds."
        : "Mend won't draft fixes for the problems it finds.";
    case "autoLand":
      return on
        ? "New sessions start with automatic landing on."
        : "New sessions start with automatic landing off.";
    case "stopSessionOnSettle":
      return on
        ? "Settling a thread in T3 Code stops its session."
        : "Settling a thread in T3 Code leaves its session running.";
  }
};
