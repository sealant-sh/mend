import { boatKeyCreateCommand, dayOf } from "@mend/domain/workbench";

import { clockTime } from "./session-view.ts";

/**
 * The Boat key page's own words (SLNT-791). What it says about a key's report comes from
 * `boatKeyFacts` and `boatKeyWarnings` in `@mend/domain/workbench`, which `mend boat` prints too.
 */

/** `14:02` today, `Nov 8, 2026 14:02` on another day. */
export const observedAt = (at: Date, now: Date): string =>
  at.toDateString() === now.toDateString() ? clockTime(at) : `${dayOf(at)} ${clockTime(at)}`;

/** Where the page sends a person to make a new key. */
export const REPLACE_ON_PAGE =
  "Create a new key with the command under Replace key, then replace this one.";

/** The two forms of the create-key command: for a Boat organization, and for a personal account. */
export const BOAT_KEY_COMMANDS = [
  {
    key: "organization",
    caption: "For a Boat organization",
    command: boatKeyCreateCommand("<your-boat-organization>"),
  },
  { key: "personal", caption: "For a personal account", command: boatKeyCreateCommand(null) },
] as const;
