import { PersonSettings } from "@mend/domain";
import { SessionDefaults } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { AuthMiddleware } from "./common.ts";

/** The automation switches a person may set for their own sessions, each resolved to on or off. */
export const AutomationSwitches = Schema.Struct({
  autoTour: Schema.Boolean,
  autoSuggest: Schema.Boolean,
  autoName: Schema.Boolean,
  autoLand: Schema.Boolean,
  backgroundSessions: Schema.Boolean,
});
export type AutomationSwitches = typeof AutomationSwitches.Type;

/** Who set a value a person inherits: their organization's owners, or the instance's operator. */
export const InheritedFrom = Schema.Literals(["organization", "instance"]);

/**
 * A person's own automation switches and what each falls back to (You · Sessions, Review and
 * Landing). The cascade is project → person → organization → instance: `effective` is what their
 * sessions get in a project that sets nothing itself.
 */
export class PersonAutomationView extends Schema.Class<PersonAutomationView>(
  "PersonAutomationView",
)({
  /** The person's own values; each null follows `inherited`. */
  own: PersonSettings,
  /** What each switch follows on Inherit: the organization's value, else the instance's. */
  inherited: AutomationSwitches,
  inheritedFrom: Schema.Struct({
    autoTour: InheritedFrom,
    autoSuggest: InheritedFrom,
    autoName: InheritedFrom,
    autoLand: InheritedFrom,
    backgroundSessions: InheritedFrom,
  }),
  /** `own` wherever set, else `inherited`. */
  effective: AutomationSwitches,
}) {}

/** A person's own settings that follow them to every device. */
export const personSettingsGroup = HttpApiGroup.make("personSettings")
  // The caller's own automation switches over their organization's defaults. PUT replaces them.
  .add(HttpApiEndpoint.get("automation", "/me/automation", { success: PersonAutomationView }))
  .add(
    HttpApiEndpoint.put("setAutomation", "/me/automation", {
      payload: PersonSettings,
      success: PersonAutomationView,
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
