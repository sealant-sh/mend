import {
  CurrentUser,
  MendApi,
  PersonAutomationView,
  type AutomationSwitches,
} from "@mend/api-contracts";
import {
  OrganizationSettingsRepo,
  OrganizationsRepo,
  PersonSettingsRepo,
  SessionDefaultsRepo,
  SettingsRepo,
  type SignIn,
  UserEvents,
} from "@mend/db";
import {
  organizationDefaults,
  organizationDefaultSources,
  personDefaults,
  type MendSettings,
  type PersonSettings,
} from "@mend/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { signInOf } from "../access.ts";

const switchesOf = (settings: MendSettings): AutomationSwitches => ({
  autoTour: settings.autoTour,
  autoSuggest: settings.autoSuggest,
  autoName: settings.autoName,
  autoLand: settings.autoLand,
  backgroundSessions: settings.backgroundSessions,
});

/**
 * One person's automation switches as You · Settings shows them: their own, what each follows on
 * Inherit (their organization's, else the instance's) and who set that, and what their sessions
 * get. An account in no organization inherits the instance's.
 */
export const personAutomationView = (signIn: SignIn, own?: PersonSettings) =>
  Effect.gen(function* () {
    const person = own ?? (yield* (yield* PersonSettingsRepo).forUser(signIn.userId));
    const instance = yield* (yield* SettingsRepo).get();
    const found = yield* (yield* OrganizationsRepo).activeMembership(signIn);
    const organization =
      found === null ? null : yield* (yield* OrganizationSettingsRepo).get(found.organization.id);
    const inherited = organizationDefaults(instance, organization);
    const sources = organizationDefaultSources(organization);
    return new PersonAutomationView({
      own: person,
      inherited: switchesOf(inherited),
      inheritedFrom: {
        autoTour: sources.autoTour,
        autoSuggest: sources.autoSuggest,
        autoName: sources.autoName,
        autoLand: sources.autoLand,
        backgroundSessions: sources.backgroundSessions,
      },
      effective: switchesOf(personDefaults(inherited, person)),
    });
  });

/**
 * A person's own settings. A save says so on the person's event stream (`accounts`), so their other
 * tabs and devices read it again.
 */
export const PersonSettingsGroupLive = HttpApiBuilder.group(MendApi, "personSettings", (handlers) =>
  handlers
    .handle("automation", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* personAutomationView(signInOf(caller));
      }),
    )
    .handle("setAutomation", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const saved = yield* (yield* PersonSettingsRepo).set(caller.user.id, payload);
        yield* (yield* UserEvents).changed(caller.user.id, "accounts");
        return yield* personAutomationView(signInOf(caller), saved);
      }),
    )
    .handle("sessionDefaults", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* SessionDefaultsRepo).forUser(caller.user.id);
      }),
    )
    .handle("setSessionDefaults", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const saved = yield* (yield* SessionDefaultsRepo).set(caller.user.id, payload);
        yield* (yield* UserEvents).changed(caller.user.id, "accounts");
        return saved;
      }),
    )
    .handle("adoptSessionDefaults", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const { saved, adopted } = yield* (yield* SessionDefaultsRepo).adopt(
          caller.user.id,
          payload,
        );
        // The person's other open devices read the defaults this browser just handed over.
        if (adopted) yield* (yield* UserEvents).changed(caller.user.id, "accounts");
        return saved;
      }),
    ),
);
