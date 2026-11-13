import {
  BoatKeyCheck,
  BoatKeyConflict,
  BoatKeyDetails,
  BoatKeyOwnersOnly,
  BoatKeyPerson,
  BoatKeyRefused,
  BoatKeyRemoval,
  BoatKeyStatus,
  BoatUnavailable,
  CurrentUser,
  MendApi,
  PersonBoatKeyStatus,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
  type BoatKey,
  BoatKeysRepo,
  type OrganizationMembership,
  ProjectsRepo,
  UsersRepo,
} from "@mend/db";
import { type AuditData, type BoatKeyOwner, boatKeyShapeProblem } from "@mend/domain/workbench";
import { type BoatAccountRefusal, SealantClients, type SealantPlatformError } from "@mend/sealant";
import { type BoatAccountStandbys, SessionEngine, type StandbyDrain } from "@mend/sessions";
import { Clock, Context, DateTime, Duration, Effect, Redacted, Result } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { organizationSessionRuntime } from "./organization-settings.ts";
import { membership } from "./organization.ts";

/** Core keeps at most 200 characters of a Boat account's label. */
const LABEL_LIMIT = 200;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const UNREACHABLE =
  "Mend could not reach this server's Sealant, so nothing changed. Try again in a minute.";

/** Whose key a request changes, in the words its answers use. */
interface KeyWords {
  /** "the organization's Boat key", "your Boat key". */
  readonly key: string;
  readonly account: string;
  readonly sessions: string;
  /** Who else could have changed it at the same moment. */
  readonly racer: string;
  /** A Boat session of theirs that is starting, as a sentence's start. */
  readonly starting: string;
  /** Where Boat sessions go once the key is gone. */
  readonly fallback: string;
}

const ORGANIZATION_WORDS: KeyWords = {
  key: "the organization's Boat key",
  account: "the organization's Boat account",
  sessions: "the organization's Boat sessions",
  racer: "Another owner",
  starting: "A Boat session in the organization is starting right now",
  fallback: "the server's key",
};

const PERSON_WORDS: KeyWords = {
  key: "your Boat key",
  account: "your Boat account",
  sessions: "your Boat sessions",
  racer: "Another of your requests",
  starting: "One of your Boat sessions is starting right now",
  fallback: "the organization's key, or the server's",
};

const capital = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

/**
 * Core's refusal in words the person can act on (SLNT-790). Core's own message is never passed
 * on: it is written for Core's operators, and the reason and counts carry everything it says. A
 * removal's `in-use` is `removalInUse`'s, which knows the standbys Mend drained first.
 */
export const boatKeyFailure = (
  error: BoatAccountRefusal | SealantPlatformError,
  words: KeyWords = ORGANIZATION_WORDS,
): BoatKeyRefused | BoatKeyConflict | BoatUnavailable => {
  if (error._tag === "SealantPlatformError") return new BoatUnavailable({ message: UNREACHABLE });
  const conflict = (reason: BoatKeyConflict["reason"], message: string) =>
    new BoatKeyConflict({
      message,
      reason,
      liveRuns: error.liveRuns,
      buildsInFlight: error.buildsInFlight,
      unseen: error.unseen,
    });
  switch (error.reason) {
    case "key-refused":
      return new BoatKeyRefused({
        reason: "refused",
        message:
          "Boat refused this key, so nothing changed. Check that you copied the whole key and that it has not expired or been revoked in Boat.",
      });
    case "key-unverified":
      return new BoatKeyRefused({
        reason: "unverified",
        message:
          "Boat did not answer when Sealant checked the key, so nothing changed. Try again in a minute.",
      });
    case "bad-request":
      return new BoatKeyRefused({
        reason: "shape",
        message:
          "Sealant refused the key as sent, so nothing changed. Copy the key again from Boat.",
      });
    case "cannot-see": {
      const unseen =
        error.unseen === null
          ? "some"
          : plural(error.unseen, "VM or saved image", "VMs or saved images");
      return conflict(
        "cannot-see",
        `This key cannot see ${unseen} ${words.account} holds now, so it is most likely another Boat account's key. Nothing changed. Use a key from the same Boat account, or remove the key and then connect the new one.`,
      );
    }
    case "in-use":
      return conflict(
        "in-use",
        `${words.starting}, and only the current key can find its VM. Nothing changed. Try again once it has started.`,
      );
    case "removing":
      return conflict(
        "removing",
        `${capital(words.key)} is being removed, so it cannot be replaced. Connect the new key once the removal is done.`,
      );
    case "changed":
      return conflict(
        "changed",
        `${words.racer} changed ${words.key} at the same moment, so nothing changed. Read the status and try again.`,
      );
    case "not-found":
      return conflict(
        "changed",
        `Sealant no longer has the Boat account Mend recorded for ${words.key}. Remove the key in Mend, then connect it again.`,
      );
    case "unavailable":
      return new BoatUnavailable({
        message:
          "This server's Sealant does not run Boat, or keeps no credentials, so it cannot hold a Boat key. Ask the person who runs Mend to set Boat up on the server.",
      });
  }
};

const organizationOwner = (found: OrganizationMembership): BoatKeyOwner => ({
  kind: "organization",
  organizationId: found.organization.id,
});

/** The caller's own key in their active organization: only ever their own row. */
const personOwner = Effect.gen(function* () {
  const found = yield* membership;
  const caller = yield* CurrentUser;
  const owner: BoatKeyOwner = {
    kind: "person",
    organizationId: found.organization.id,
    userId: caller.user.id,
  };
  return { found, owner };
});

/** The caller's organization when they own it; a member gets a sentence, not a 404. */
const ownership = Effect.gen(function* () {
  const found = yield* membership;
  if (found.role !== "owner") {
    return yield* new BoatKeyOwnersOnly({
      message:
        "Only an owner of this organization can connect, check, replace or remove its Boat key. Ask an owner.",
    });
  }
  return found;
});

const detailsOf = (key: BoatKey) =>
  Effect.gen(function* () {
    const connectedBy = yield* (yield* UsersRepo).byId(key.connectedByUserId);
    return new BoatKeyDetails({
      sealantBoatAccountId: key.sealantBoatAccountId,
      connectedByUserId: key.connectedByUserId,
      connectedByName: connectedBy?.name ?? null,
      connectedAt: key.connectedAt,
      keyReplacedAt: key.keyReplacedAt,
      // SLNT-781 seam: Core's last report for the account (`boatAccounts.list()`), once the
      // pinned SDK returns one. Until then Mend has observed nothing about the key itself.
      report: null,
    });
  });

/** The members whose own key decides their Boat sessions here (SLNT-797): names, never details. */
const peopleWithOwnKeys = (found: OrganizationMembership) =>
  Effect.gen(function* () {
    const users = yield* UsersRepo;
    const people = yield* (yield* BoatKeysRepo).peopleWithKeys(found.organization.id);
    return yield* Effect.forEach(people, (person) =>
      users
        .byId(person.userId)
        .pipe(
          Effect.map(
            (user) => new BoatKeyPerson({ userId: person.userId, name: user?.name ?? null }),
          ),
        ),
    );
  });

const statusOf = (found: OrganizationMembership, key: BoatKey | null) =>
  Effect.gen(function* () {
    // Where this organization's new sessions run: its key is used only for Boat sessions.
    const sessionRuntime = (yield* organizationSessionRuntime(found.organization.id)).effective;
    if (found.role !== "owner") {
      return new BoatKeyStatus({
        connected: key !== null,
        sessionRuntime,
        details: null,
        peopleWithOwnKeys: null,
      });
    }
    return new BoatKeyStatus({
      connected: key !== null,
      sessionRuntime,
      details: key === null ? null : yield* detailsOf(key),
      peopleWithOwnKeys: yield* peopleWithOwnKeys(found),
    });
  });

/** The caller's own key in their active organization (SLNT-797). */
const personStatusOf = (found: OrganizationMembership, key: BoatKey | null) =>
  Effect.gen(function* () {
    const sessionRuntime = (yield* organizationSessionRuntime(found.organization.id)).effective;
    const organizationKey = yield* (yield* BoatKeysRepo).byOwner(organizationOwner(found));
    return new PersonBoatKeyStatus({
      organizationName: found.organization.name,
      connected: key !== null,
      sessionRuntime,
      organizationKey: organizationKey !== null,
      details: key === null ? null : yield* detailsOf(key),
    });
  });

/**
 * A standby is a paid VM in the account its fingerprint names: after the organization's account
 * changes, each project that keeps standbys drains them and warms new ones in the account its
 * launches name now.
 */
const rewarmStandbys = (found: OrganizationMembership) =>
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const projects = yield* (yield* ProjectsRepo).listForOrganization(found.organization.id);
    for (const project of projects) {
      if (project.hotSessions > 0) yield* engine.reconcileHotSessions(project.id);
    }
  });

/**
 * How long a removal waits for the standbys it drained to leave Core's count, and how often it
 * asks Core again meanwhile (SLNT-803). Inside an edge's request limit. A reference so a test can
 * shorten it.
 */
export interface RemovalWait {
  readonly within: Duration.Duration;
  readonly every: Duration.Duration;
}
export const BoatKeyRemovalWait: Context.Reference<RemovalWait> = Context.Reference<RemovalWait>(
  "@mend/api/BoatKeyRemovalWait",
  {
    defaultValue: () => ({ within: Duration.seconds(45), every: Duration.seconds(3) }),
  },
);

/**
 * Core's `in-use` answer to a removal, counting only what a person acts on: the VMs Core counts
 * that are not standbys Mend asked to stop, and image builds. Nothing changed, so the key stays
 * and the standbys warm again.
 */
const removalInUse = (
  refusal: BoatAccountRefusal,
  drain: StandbyDrain,
  words: KeyWords,
): BoatKeyConflict => {
  const sessions =
    refusal.liveRuns === null ? null : Math.max(0, refusal.liveRuns - drain.stopping);
  const builds = refusal.buildsInFlight ?? 0;
  const conflict = (message: string) =>
    new BoatKeyConflict({
      message,
      reason: "in-use",
      liveRuns: refusal.liveRuns,
      buildsInFlight: refusal.buildsInFlight,
      unseen: refusal.unseen,
    });
  if (sessions === 0 && builds === 0 && drain.stopping > 0) {
    return conflict(
      `Mend is still stopping ${plural(drain.stopping, "standby workspace", "standby workspaces")} in ${words.account}, so nothing changed and the key stays. Remove the key again in a minute.`,
    );
  }
  const held = [
    sessions === 0
      ? null
      : sessions === null
        ? "session workspaces whose VMs"
        : plural(sessions, "session workspace whose VM", "session workspaces whose VMs"),
    builds === 0 ? null : plural(builds, "image build", "image builds"),
  ].filter((part) => part !== null);
  const act = [
    sessions === 0 ? null : `stop ${words.sessions}`,
    builds === 0 ? null : "wait for its image builds to finish",
  ].filter((part) => part !== null);
  const stopped =
    drain.drained === 0
      ? ""
      : ` Mend stopped ${plural(drain.drained, "standby workspace", "standby workspaces")} there first; they warm again while the key stays.`;
  const stopping =
    drain.stopping === 0
      ? ""
      : ` ${plural(drain.stopping, "more standby is", "more standbys are")} still stopping.`;
  return conflict(
    `${capital(words.account)} still has ${held.join(" and ")} Boat may be running, so nothing changed and the key stays. To remove it, ${act.join(" and ")}, then remove the key again.${stopped}${stopping}`,
  );
};

/** Core's two answers count the same VMs and builds. */
const sameCount = (a: BoatAccountRefusal, b: BoatAccountRefusal) =>
  a.liveRuns === b.liveRuns && a.buildsInFlight === b.buildsInFlight;

/**
 * Drains the organization's standbys in the account, then asks Core to remove it (SLNT-803). A
 * standby Mend just drained may still count in Core's answer for a moment, so an `in-use` answer
 * is asked again until `BoatKeyRemovalWait` runs out, each time after draining again. It is final
 * at once when Mend drained nothing there, or when no standby is still stopping and Core counts
 * what it counted the time before: then what holds the account is a person's work.
 */
const removeAccount = (boatAccountId: string, standbys: BoatAccountStandbys, words: KeyWords) =>
  Effect.gen(function* () {
    const wait = yield* BoatKeyRemovalWait;
    const clients = yield* SealantClients;
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(wait.within);
    let previous: BoatAccountRefusal | null = null;
    for (;;) {
      const left = deadline - (yield* Clock.currentTimeMillis);
      const drain = yield* standbys.drain(boatAccountId, Duration.millis(Math.max(0, left)));
      const answer = yield* clients.removeBoatAccount(boatAccountId).pipe(Effect.result);
      if (Result.isSuccess(answer)) return drain;
      const error = answer.failure;
      // One Core no longer has, or is already removing, is gone as far as new sessions go.
      if (
        error._tag === "BoatAccountRefusal" &&
        (error.reason === "not-found" || error.reason === "removing")
      ) {
        return drain;
      }
      if (error._tag !== "BoatAccountRefusal" || error.reason !== "in-use") {
        return yield* boatKeyFailure(error, words);
      }
      const final =
        drain.drained + drain.stopping === 0 ||
        (drain.stopping === 0 && previous !== null && sameCount(previous, error));
      const next = (yield* Clock.currentTimeMillis) + Duration.toMillis(wait.every);
      if (final || next >= deadline) return yield* removalInUse(error, drain, words);
      previous = error;
      yield* Effect.sleep(wait.every);
    }
  });

const record = (
  found: OrganizationMembership,
  action: "boat_key.connected" | "boat_key.replaced" | "boat_key.removed",
  sealantBoatAccountId: string,
  data: AuditData = {},
) =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    yield* (yield* AuditEventsRepo).record({
      organizationId: found.organization.id,
      actorUserId: caller.user.id,
      action,
      subjectType: "boat_key",
      subjectId: sealantBoatAccountId,
      data,
    });
  });

/** Whose key a request acts on, and how its answers and Core's label name it. */
interface KeyHolder {
  readonly found: OrganizationMembership;
  readonly owner: BoatKeyOwner;
  readonly words: KeyWords;
  /** Core's label for a new account. */
  readonly label: string;
  /** What the audit entry adds, so the log tells a person's key from the organization's. */
  readonly audit: AuditData;
}

const organizationHolder = (found: OrganizationMembership): KeyHolder => ({
  found,
  owner: organizationOwner(found),
  words: ORGANIZATION_WORDS,
  label: `Mend · ${found.organization.name}`,
  audit: {},
});

const personHolder = Effect.gen(function* () {
  const { found, owner } = yield* personOwner;
  const caller = yield* CurrentUser;
  const holder: KeyHolder = {
    found,
    owner,
    words: PERSON_WORDS,
    label: `Mend · ${found.organization.name} · ${caller.user.name}`,
    audit: { key: "own" },
  };
  return holder;
});

/**
 * Connects the holder's key, or replaces it in the same Core account when there is one. The key
 * goes to Core and nowhere else. Answers the row as it is now.
 */
const connectKey = (holder: KeyHolder, pasted: string) =>
  Effect.gen(function* () {
    const problem = boatKeyShapeProblem(pasted);
    if (problem !== null) return yield* new BoatKeyRefused({ reason: "shape", message: problem });
    const key = Redacted.make(pasted.trim());
    const keys = yield* BoatKeysRepo;
    const clients = yield* SealantClients;
    const failure = (error: BoatAccountRefusal | SealantPlatformError) =>
      boatKeyFailure(error, holder.words);
    const existing = yield* keys.byOwner(holder.owner);
    if (existing !== null) {
      yield* clients
        .rotateBoatAccountKey(existing.sealantBoatAccountId, key)
        .pipe(Effect.mapError(failure));
      const replaced = yield* keys.markReplaced(holder.owner);
      yield* record(holder.found, "boat_key.replaced", existing.sealantBoatAccountId, holder.audit);
      return replaced;
    }
    const account = yield* clients
      .createBoatAccount(holder.label.slice(0, LABEL_LIMIT), key)
      .pipe(Effect.mapError(failure));
    const caller = yield* CurrentUser;
    const connected = yield* keys
      .connect({
        owner: holder.owner,
        sealantBoatAccountId: account.boatAccountId,
        connectedByUserId: caller.user.id,
      })
      .pipe(
        Effect.catchTag("BoatKeyTakenError", () =>
          // Another connect won: the account made here holds nothing yet, so it goes.
          clients.removeBoatAccount(account.boatAccountId).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.fail(
                new BoatKeyConflict({
                  reason: "taken",
                  message: `${holder.words.racer} connected ${holder.words.key} at the same moment, so this one was not kept. Read the status, and replace the key if it should be this one.`,
                  liveRuns: null,
                  buildsInFlight: null,
                  unseen: null,
                }),
              ),
            ),
          ),
        ),
      );
    yield* record(holder.found, "boat_key.connected", account.boatAccountId, holder.audit);
    // Standbys warm wherever launches go now: on the organization's new key, and, for a person's
    // own key, none at all, so theirs in the organization's account drain.
    yield* rewarmStandbys(holder.found);
    return connected;
  });

/** What Core says of the holder's account, asked now. */
const checkKey = (holder: KeyHolder) =>
  Effect.gen(function* () {
    const key = yield* (yield* BoatKeysRepo).byOwner(holder.owner);
    if (key === null) {
      return new BoatKeyCheck({
        state: "none",
        observedAt: yield* DateTime.nowAsDate,
        keyReplacedAt: null,
        report: null,
      });
    }
    const accounts = yield* (yield* SealantClients).listBoatAccounts().pipe(
      Effect.mapError((error) => {
        const failure = boatKeyFailure(error, holder.words);
        return failure._tag === "BoatUnavailable"
          ? failure
          : new BoatUnavailable({ message: UNREACHABLE });
      }),
    );
    const account = accounts.find(
      (candidate) => candidate.boatAccountId === key.sealantBoatAccountId,
    );
    return new BoatKeyCheck({
      state: account?.state ?? "missing",
      observedAt: yield* DateTime.nowAsDate,
      keyReplacedAt: account?.keyRotatedAt ?? key.keyReplacedAt,
      report: account?.report ?? null,
    });
  });

/**
 * Removes the holder's key: drains Mend's standbys in its account, then asks Core to remove it.
 * One key change per organization at a time: a second removal asked meanwhile finds no key once
 * the first is done, and reports nothing it did not do. Null: there was no key to remove.
 */
const removeKey = (holder: KeyHolder) =>
  Effect.gen(function* () {
    const keys = yield* BoatKeysRepo;
    return yield* (yield* SessionEngine).changingBoatKey(holder.found.organization.id, (standbys) =>
      Effect.gen(function* () {
        const existing = yield* keys.byOwner(holder.owner);
        if (existing === null) return null;
        const drain = yield* removeAccount(existing.sealantBoatAccountId, standbys, holder.words);
        // Another server process may have removed the row meanwhile: it recorded that.
        if ((yield* keys.remove(holder.owner)) === null) return null;
        yield* record(holder.found, "boat_key.removed", existing.sealantBoatAccountId, {
          ...holder.audit,
          standbysDrained: drain.drained,
        });
        return new BoatKeyRemoval({ standbysDrained: drain.drained });
      }),
    );
  });

/**
 * The organization's Boat key (SLNT-790). Members read whether there is one; owners connect,
 * replace, check and remove it, and see which members have their own. The key goes to Core in the
 * request that connects it and nowhere else: Mend's database, logs, audit log and errors never
 * hold it.
 */
export const BoatKeyGroupLive = HttpApiBuilder.group(MendApi, "boatKey", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const found = yield* membership;
        return yield* statusOf(
          found,
          yield* (yield* BoatKeysRepo).byOwner(organizationOwner(found)),
        );
      }),
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownership;
        return yield* statusOf(found, yield* connectKey(organizationHolder(found), payload.key));
      }),
    )
    .handle("check", () =>
      Effect.gen(function* () {
        const found = yield* ownership;
        return yield* checkKey(organizationHolder(found));
      }),
    )
    .handle("disconnect", () =>
      Effect.gen(function* () {
        const found = yield* ownership;
        const removal = yield* removeKey(organizationHolder(found));
        const status = yield* statusOf(found, null);
        return removal === null ? status : new BoatKeyStatus({ ...status, removal });
      }),
    ),
);

/**
 * A person's own Boat key in their active organization (SLNT-797). Every request acts on the
 * caller's own row and no one else's: no route here names another person.
 */
export const PersonBoatKeyGroupLive = HttpApiBuilder.group(MendApi, "personBoatKey", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const { found, owner } = yield* personOwner;
        return yield* personStatusOf(found, yield* (yield* BoatKeysRepo).byOwner(owner));
      }),
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const holder = yield* personHolder;
        return yield* personStatusOf(holder.found, yield* connectKey(holder, payload.key));
      }),
    )
    .handle("check", () => personHolder.pipe(Effect.flatMap(checkKey)))
    .handle("disconnect", () =>
      Effect.gen(function* () {
        const holder = yield* personHolder;
        const removal = yield* removeKey(holder);
        const status = yield* personStatusOf(holder.found, null);
        return removal === null ? status : new PersonBoatKeyStatus({ ...status, removal });
      }),
    ),
);
