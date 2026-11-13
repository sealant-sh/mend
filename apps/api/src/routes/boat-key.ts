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
import {
  type AuditData,
  type BoatFailure,
  boatFailureLogLine,
  type BoatKeyOwner,
  type BoatKeyReport,
  boatKeyShapeProblem,
  boatProblemText,
  permissionsTheCommandLacks,
} from "@mend/domain/workbench";
import {
  type BoatAccountRefusal,
  type PlatformBoatAccount,
  SealantClients,
  type SealantPlatformError,
} from "@mend/sealant";
import { type BoatAccountStandbys, SessionEngine, type StandbyDrain } from "@mend/sessions";
import { Clock, Context, DateTime, Duration, Effect, Redacted, Result } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { organizationSessionRuntime } from "./organization-settings.ts";
import { membership } from "./organization.ts";

/** Core keeps at most 200 characters of a Boat account's label. */
const LABEL_LIMIT = 200;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Boat's own code and request id for a refused key, in the server log: never in a sentence. */
const logBoatRefusal = (error: BoatAccountRefusal | SealantPlatformError) =>
  error._tag === "BoatAccountRefusal" && error.boat !== null
    ? Effect.logInfo(`boat key: ${error.reason} · ${boatFailureLogLine(error.boat)}`)
    : Effect.void;

/** Boat's reason for refusing a key check, in the Boat failure table's words (SLNT-793). */
const keyCheckWords = (failure: BoatFailure): string =>
  boatProblemText(
    { kind: failure.kind, failure },
    { holder: "organization", place: "key-check" },
  ).replace("\n", " ");

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
          error.boat === null
            ? "Boat refused this key, so nothing changed. Check that you copied the whole key and that it has not expired or been revoked in Boat."
            : keyCheckWords(error.boat),
      });
    case "key-unverified":
      return new BoatKeyRefused({
        reason: "unverified",
        message:
          error.boat === null
            ? "Boat did not answer when Sealant checked the key, so nothing changed. Try again in a minute."
            : keyCheckWords(error.boat),
      });
    case "missing-permissions": {
      const missing = error.missingPermissions ?? [];
      return new BoatKeyRefused({
        reason: "missing-permissions",
        message: `This Boat key lacks ${missing.length === 1 ? "a permission" : "permissions"} Mend needs${missing.length === 0 ? "" : `: ${missing.join(", ")}`}. Nothing changed. Create a key with the command on Mend's Boat page (Settings, Organization, Boat), which grants every permission Mend needs, and connect that one.`,
      });
    }
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

/**
 * Core needs a permission the page's create-key command does not ask for: Mend's list is behind
 * Core's, so every key made with the command would be refused. Said once per report, in the log.
 */
const warnIfTheCommandLacks = (report: BoatKeyReport | null) => {
  const lacking = report === null ? [] : permissionsTheCommandLacks(report.requiredPermissions);
  return lacking.length === 0
    ? Effect.void
    : Effect.logWarning(
        `boat key: Sealant needs Boat permissions the create-key command does not ask for: ${lacking.join(", ")}. Update BOAT_KEY_REQUIRED_PERMISSIONS.`,
      );
};

/**
 * Core's Boat account for a key, with the last report Core keeps on it, from Core's list: no call
 * to Boat. Null when Core does not list the account, or could not be read (logged): the status
 * still answers. A person's own key (`/api/me/boat-key`, SLNT-797) reads its account the same way.
 */
export const lastBoatKeyAccount = (sealantBoatAccountId: string) =>
  Effect.gen(function* () {
    const accounts = yield* (yield* SealantClients).listBoatAccounts();
    const account =
      accounts.find((candidate) => candidate.boatAccountId === sealantBoatAccountId) ?? null;
    yield* warnIfTheCommandLacks(account?.report ?? null);
    return account;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(
        `boat key: could not read Sealant's Boat accounts for the key's report · ${error._tag} · ${error.message}`,
      ).pipe(Effect.as(null)),
    ),
  );

const UNANSWERED =
  "Boat did not answer this check, so Mend observed nothing new: the report shown is the last one. Try again in a minute.";

/**
 * Checks a key with Boat again (`boatAccounts.check`, read-only) and answers what Mend observed.
 * Boat not answering keeps Core's last report, and `unanswered` says so. A person's own key
 * (`/api/me/boat-key/check`, SLNT-797) checks the same way.
 */
export const checkBoatKeyAccount = (
  key: {
    readonly sealantBoatAccountId: string;
    readonly keyReplacedAt: Date | null;
  },
  words: KeyWords = ORGANIZATION_WORDS,
) =>
  Effect.gen(function* () {
    const checked = yield* (yield* SealantClients)
      .checkBoatAccount(key.sealantBoatAccountId)
      .pipe(Effect.result);
    const now = yield* DateTime.nowAsDate;
    if (checked._tag === "Success") {
      const account = checked.success;
      yield* warnIfTheCommandLacks(account.report);
      return new BoatKeyCheck({
        state: account.state,
        observedAt: account.report?.observedAt ?? now,
        keyReplacedAt: account.keyRotatedAt ?? key.keyReplacedAt,
        report: account.report,
        unanswered: null,
      });
    }
    const error = checked.failure;
    if (error._tag === "BoatAccountRefusal" && error.reason === "not-found") {
      return new BoatKeyCheck({
        state: "missing",
        observedAt: now,
        keyReplacedAt: key.keyReplacedAt,
        report: null,
        unanswered: null,
      });
    }
    if (
      error._tag === "BoatAccountRefusal" &&
      (error.reason === "key-unverified" ||
        error.reason === "key-refused" ||
        error.reason === "missing-permissions")
    ) {
      const last = yield* lastBoatKeyAccount(key.sealantBoatAccountId);
      yield* Effect.logInfo(
        `boat key: Boat did not answer a check of Sealant account ${key.sealantBoatAccountId} · ${error.reason}${error.boat === null ? "" : ` · ${boatFailureLogLine(error.boat)}`}`,
      );
      return new BoatKeyCheck({
        state: last?.state ?? "active",
        observedAt: now,
        keyReplacedAt: last?.keyRotatedAt ?? key.keyReplacedAt,
        report: error.report ?? last?.report ?? null,
        unanswered:
          error.boat === null
            ? UNANSWERED
            : `${keyCheckWords(error.boat)} The report shown is the last one Sealant observed.`,
      });
    }
    const failure = boatKeyFailure(error, words);
    return yield* failure._tag === "BoatUnavailable"
      ? failure
      : new BoatUnavailable({ message: UNREACHABLE });
  });

/**
 * Who connected the key and when, and Core's last report on it. A connect or replace passes the
 * account Core just checked; a status reads the last report from Core's list.
 */
const detailsOf = (key: BoatKey, account?: PlatformBoatAccount | null) =>
  Effect.gen(function* () {
    const connectedBy = yield* (yield* UsersRepo).byId(key.connectedByUserId);
    const report =
      (account === undefined ? yield* lastBoatKeyAccount(key.sealantBoatAccountId) : account)
        ?.report ?? null;
    return new BoatKeyDetails({
      sealantBoatAccountId: key.sealantBoatAccountId,
      connectedByUserId: key.connectedByUserId,
      connectedByName: connectedBy?.name ?? null,
      connectedAt: key.connectedAt,
      keyReplacedAt: key.keyReplacedAt,
      report,
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

const statusOf = (
  found: OrganizationMembership,
  key: BoatKey | null,
  account?: PlatformBoatAccount | null,
) =>
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
      details: key === null ? null : yield* detailsOf(key, account),
      peopleWithOwnKeys: yield* peopleWithOwnKeys(found),
    });
  });

/** The caller's own key in their active organization (SLNT-797). */
const personStatusOf = (
  found: OrganizationMembership,
  key: BoatKey | null,
  account?: PlatformBoatAccount | null,
) =>
  Effect.gen(function* () {
    const sessionRuntime = (yield* organizationSessionRuntime(found.organization.id)).effective;
    const organizationKey = yield* (yield* BoatKeysRepo).byOwner(organizationOwner(found));
    return new PersonBoatKeyStatus({
      organizationName: found.organization.name,
      connected: key !== null,
      sessionRuntime,
      organizationKey: organizationKey !== null,
      details: key === null ? null : yield* detailsOf(key, account),
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

/** `45 s`, `2 min 5 s`: how long a removal waited, to the second. */
const waited = (millis: number) => {
  const seconds = Math.round(millis / 1000);
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)} min${seconds % 60 === 0 ? "" : ` ${seconds % 60} s`}`;
};

/**
 * Core's `in-use` answer to a removal, counting only what a person acts on: the VMs Core counts
 * that are not Mend's own standbys there, and image builds. Mend's standbys whose end it has not
 * seen are named as Mend's, with how long it waited and what asks again. Nothing changed, so the
 * key stays and the standbys warm again.
 */
const removalInUse = (
  refusal: BoatAccountRefusal,
  drain: StandbyDrain,
  waitedMillis: number,
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
  const theirVms = drain.stopping === 1 ? "Its VM" : "Their VMs";
  const unseenEnd =
    drain.stopping === 0
      ? ""
      : `${theirVms} may still be running and billed. Mend asks Sealant to end ${drain.stopping === 1 ? "it" : "them"} again at least every 10 minutes, and again each time the key is removed.`;
  if (sessions === 0 && builds === 0 && drain.stopping > 0) {
    return conflict(
      `Mend asked Sealant to end ${drain.stopping} of its own standby workspaces in ${words.account} and did not see ${drain.stopping === 1 ? "it" : "them"} end within ${waited(waitedMillis)}, so nothing changed and the key stays. No session holds the account. ${unseenEnd}`,
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
      : ` Mend also asked Sealant to end ${drain.stopping} of its own standby workspaces there and did not see ${drain.stopping === 1 ? "it" : "them"} end within ${waited(waitedMillis)}. ${unseenEnd}`;
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
    const started = yield* Clock.currentTimeMillis;
    const deadline = started + Duration.toMillis(wait.within);
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
      const now = yield* Clock.currentTimeMillis;
      if (final || now + Duration.toMillis(wait.every) >= deadline) {
        return yield* removalInUse(error, drain, now - started, words);
      }
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
 * goes to Core and nowhere else. Answers the row as it is now, with the account Core just checked.
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
      const rotated = yield* clients
        .rotateBoatAccountKey(existing.sealantBoatAccountId, key)
        .pipe(Effect.tapError(logBoatRefusal), Effect.mapError(failure));
      const replaced = yield* keys.markReplaced(holder.owner);
      yield* record(holder.found, "boat_key.replaced", existing.sealantBoatAccountId, holder.audit);
      return { key: replaced, account: rotated };
    }
    const account = yield* clients
      .createBoatAccount(holder.label.slice(0, LABEL_LIMIT), key)
      .pipe(Effect.tapError(logBoatRefusal), Effect.mapError(failure));
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
    return { key: connected, account };
  });

/**
 * Asks Boat about the holder's key now, through Core (read-only), and answers what Mend observed:
 * the organization's and a person's own key the same way.
 */
const checkKey = (holder: KeyHolder) =>
  Effect.gen(function* () {
    const key = yield* (yield* BoatKeysRepo).byOwner(holder.owner);
    if (key === null) {
      return new BoatKeyCheck({
        state: "none",
        observedAt: yield* DateTime.nowAsDate,
        keyReplacedAt: null,
        report: null,
        unanswered: null,
      });
    }
    return yield* checkBoatKeyAccount(key, holder.words);
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
        const connected = yield* connectKey(organizationHolder(found), payload.key);
        return yield* statusOf(found, connected.key, connected.account);
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
        const connected = yield* connectKey(holder, payload.key);
        return yield* personStatusOf(holder.found, connected.key, connected.account);
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
