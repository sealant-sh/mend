import { PersonSettings } from "@mend/domain";
import { SessionDefaults } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { AuthMiddleware } from "./common.ts";

/**
 * A person's own automation switches (You · Your automation): plain values, stored once and read
 * by nothing else (docs/adr/0025-one-home-per-setting.md). Their sessions take them as they are,
 * unless a project sets its own.
 */
export class PersonAutomationView extends Schema.Class<PersonAutomationView>(
  "PersonAutomationView",
)({
  /** The person's own values. */
  own: PersonSettings,
  /**
   * The same values as `own`. Kept because CLIs already installed read
   * `effective.backgroundSessions`, and would read a missing one as "background".
   */
  effective: PersonSettings,
}) {}

/**
 * What a client sends to replace its own switches. Each is true or false; null is what old clients
 * sent for Inherit, which is gone (docs/adr/0025-one-home-per-setting.md), and is refused with
 * `AutomationInheritRemoved` rather than decoded away, so an old client says why.
 */
export const PersonAutomationRequest = Schema.Struct({
  autoTour: Schema.NullOr(Schema.Boolean),
  autoSuggest: Schema.NullOr(Schema.Boolean),
  autoName: Schema.NullOr(Schema.Boolean),
  autoLand: Schema.NullOr(Schema.Boolean),
  backgroundSessions: Schema.NullOr(Schema.Boolean),
});
export type PersonAutomationRequest = typeof PersonAutomationRequest.Type;

/** A save that asked for Inherit on a switch, from a client older than plain switches. */
export class AutomationInheritRemoved extends Schema.TaggedError<AutomationInheritRemoved>()(
  "AutomationInheritRemoved",
  {
    /** The switches the request left on Inherit. */
    switches: Schema.Array(Schema.String),
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

/** A person's own settings that follow them to every device. */
export const personSettingsGroup = HttpApiGroup.make("personSettings")
  // The caller's own automation switches. PUT replaces all five with plain true or false; a null
  // (an old client's Inherit) is refused with 400 `AutomationInheritRemoved` and saves nothing.
  .add(HttpApiEndpoint.get("automation", "/me/automation", { success: PersonAutomationView }))
  .add(
    HttpApiEndpoint.put("setAutomation", "/me/automation", {
      payload: PersonAutomationRequest,
      success: PersonAutomationView,
      error: AutomationInheritRemoved,
    }),
  )
  // The caller's new-session defaults: agent, model and effort per agent. PUT replaces them;
  // `adopt` keeps a browser's own only when none are saved yet, and answers what is saved.
  .add(HttpApiEndpoint.get("sessionDefaults", "/me/session-defaults", { success: SessionDefaults }))
  .add(
    HttpApiEndpoint.put("setSessionDefaults", "/me/session-defaults", {
      payload: SessionDefaults,
      success: SessionDefaults,
    }),
  )
  .add(
    HttpApiEndpoint.post("adoptSessionDefaults", "/me/session-defaults/adopt", {
      payload: SessionDefaults,
      success: SessionDefaults,
    }),
  )
  .middleware(AuthMiddleware);
