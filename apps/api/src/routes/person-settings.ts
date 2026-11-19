import {
  AutomationInheritRemoved,
  CurrentUser,
  MendApi,
  PersonAutomationView,
  type PersonAutomationRequest,
} from "@mend/api-contracts";
import { PersonSettingsRepo, SessionDefaultsRepo, UserEvents } from "@mend/db";
import { PERSON_SETTING_KEYS, PersonSettings } from "@mend/domain";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

/** One person's automation switches as Settings shows them: their own, and nothing resolved. */
export const personAutomationView = (own: PersonSettings) =>
  new PersonAutomationView({ own, effective: own });

/**
 * The switches as saved, or the refusal of an old client's Inherit: there is nothing left for it
 * to follow, and guessing a value for it would save something the person did not pick.
 */
export const ownAutomation = (request: PersonAutomationRequest) => {
  const { autoTour, autoSuggest, autoName, autoLand, backgroundSessions } = request;
  if (
    autoTour === null ||
    autoSuggest === null ||
    autoName === null ||
    autoLand === null ||
    backgroundSessions === null
  ) {
    return Effect.fail(
      new AutomationInheritRemoved({
        switches: PERSON_SETTING_KEYS.filter((key) => request[key] === null),
        message:
          "Inherit is gone: each automation switch is yours now. Choose On or Off; nothing was saved.",
      }),
    );
  }
  return Effect.succeed(
    new PersonSettings({ autoTour, autoSuggest, autoName, autoLand, backgroundSessions }),
  );
};

/**
 * A person's own settings. A save says so on the person's event stream (`accounts`), so their other
 * tabs and devices read it again.
 */
export const PersonSettingsGroupLive = HttpApiBuilder.group(MendApi, "personSettings", (handlers) =>
  handlers
    .handle("automation", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return personAutomationView(yield* (yield* PersonSettingsRepo).forUser(caller.user.id));
      }),
    )
    .handle("setAutomation", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const own = yield* ownAutomation(payload);
        const saved = yield* (yield* PersonSettingsRepo).set(caller.user.id, own);
        yield* (yield* UserEvents).changed(caller.user.id, "accounts");
        return personAutomationView(saved);
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
