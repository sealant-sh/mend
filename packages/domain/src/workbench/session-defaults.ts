import { Schema } from "effect";

import { EFFORT_LEVELS } from "./harness-launch.ts";

/** The agents a person's new-session defaults may name. */
export const DefaultHarness = Schema.Literals(["claude", "codex", "opencode", "pi", "shell"]);
export type DefaultHarness = typeof DefaultHarness.Type;

/** What a new session on one agent starts with; null leaves it to the catalog or the agent. */
export const HarnessStart = Schema.Struct({
  model: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  effort: Schema.NullOr(Schema.Literals(EFFORT_LEVELS)),
});
export type HarnessStart = typeof HarnessStart.Type;

/**
 * A person's new-session defaults (You · Sessions → New sessions): the agent the composer picks
 * first for a project with no sticky choice yet, and a model and effort per agent. Kept on the
 * server so they follow the person to every device; a project's sticky choices stay per browser.
 */
export class SessionDefaults extends Schema.Class<SessionDefaults>("SessionDefaults")({
  /** Null until chosen: the composer then starts on claude. */
  harness: Schema.NullOr(DefaultHarness),
  byHarness: Schema.Struct({
    claude: Schema.optionalKey(HarnessStart),
    codex: Schema.optionalKey(HarnessStart),
    opencode: Schema.optionalKey(HarnessStart),
    pi: Schema.optionalKey(HarnessStart),
    shell: Schema.optionalKey(HarnessStart),
  }),
}) {}

/** A person who chose nothing yet. */
export const NO_SESSION_DEFAULTS = new SessionDefaults({ harness: null, byHarness: {} });
