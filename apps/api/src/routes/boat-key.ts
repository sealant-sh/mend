import {
  BoatKeyCheck,
  BoatKeyConflict,
  BoatKeyDetails,
  BoatKeyFullCheck,
  BoatKeyOwnersOnly,
  BoatKeyRefused,
  BoatKeyRemoval,
  BoatKeyStatus,
  BoatUnavailable,
  CurrentUser,
  MendApi,
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

import { BoatKeyFullChecks } from "../boat-key-full-checks.ts";
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

/**
 * Core's refusal in words the owner can act on (SLNT-790). Core's own message is never passed on:
 * it is written for Core's operators, and the reason and counts carry everything it says. A
 * removal's `in-use` is `removalInUse`'s, which knows the standbys Mend drained first.
 */
export const boatKeyFailure = (
  error: BoatAccountRefusal | SealantPlatformError,
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
        `This key cannot see ${unseen} the organization's Boat account holds now, so it is most likely another Boat account's key. Nothing changed. Use a key from the same Boat account, or remove the key and then connect the new one.`,
      );
    }
    case "in-use":
      return conflict(
        "in-use",
        "A Boat session in the organization is starting right now, and only the current key can find its VM. Nothing changed. Try again once it has started.",
      );
    case "removing":
      return conflict(
        "removing",
        "The organization's Boat key is being removed, so it cannot be replaced. Connect the new key once the removal is done.",
      );
    case "changed":
      return conflict(
        "changed",
        "Another owner changed the organization's Boat key at the same moment, so nothing changed. Read the status and try again.",
      );
    case "not-found":
      return conflict(
        "changed",
        "Sealant no longer has the Boat account Mend recorded for this organization. Remove the key in Mend, then connect it again.",
      );
    case "proof-running":
      // Core's sentence names what Boat may still hold and when Sealant takes over an
      // interrupted check: the owner needs it to decide whether to wait or delete it in Boat.
      return conflict(
        "proof-running",
        `A full check of this key has not finished removing what it made in Boat, so nothing changed: the key that made them is the one that can delete them. Sealant says: ${error.message}`,
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
export const checkBoatKeyAccount = (key: {
  readonly sealantBoatAccountId: string;
  readonly keyReplacedAt: Date | null;
}) =>
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
    const failure = boatKeyFailure(error);
    return yield* failure._tag === "BoatUnavailable"
      ? failure
      : new BoatUnavailable({ message: UNREACHABLE });
  });

const statusOf = (
  fullChecks: BoatKeyFullChecks["Service"],
  found: OrganizationMembership,
  key: BoatKey | null,
  account?: PlatformBoatAccount | null,
) =>
  Effect.gen(function* () {
    // Where this organization's new sessions run: its key is used only for Boat sessions.
    const sessionRuntime = (yield* organizationSessionRuntime(found.organization.id)).effective;
    if (key === null || found.role !== "owner") {
      return new BoatKeyStatus({ connected: key !== null, sessionRuntime, details: null });
    }
    const connectedBy = yield* (yield* UsersRepo).byId(key.connectedByUserId);
    // A connect or replace answers the account Core just checked; a status reads the last report.
    const known =
      account === undefined ? yield* lastBoatKeyAccount(key.sealantBoatAccountId) : account;
    const runningSince = yield* fullChecks.runningSince(key.sealantBoatAccountId);
    return new BoatKeyStatus({
      connected: true,
      sessionRuntime,
      details: new BoatKeyDetails({
        sealantBoatAccountId: key.sealantBoatAccountId,
        connectedByUserId: key.connectedByUserId,
        connectedByName: connectedBy?.name ?? null,
        connectedAt: key.connectedAt,
        keyReplacedAt: key.keyReplacedAt,
        report: known?.report ?? null,
        fullCheck: new BoatKeyFullCheck({ last: known?.lastProof ?? null, runningSince }),
      }),
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
      `Mend asked Sealant to end ${drain.stopping} of its own standby workspaces in the organization's Boat account and did not see ${drain.stopping === 1 ? "it" : "them"} end within ${waited(waitedMillis)}, so nothing changed and the key stays. No session holds the account. ${unseenEnd}`,
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
    sessions === 0 ? null : "stop the organization's Boat sessions",
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
    `The organization's Boat account still has ${held.join(" and ")} Boat may be running, so nothing changed and the key stays. To remove it, ${act.join(" and ")}, then remove the key again.${stopped}${stopping}`,
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
const removeAccount = (boatAccountId: string, standbys: BoatAccountStandbys) =>
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
        return yield* boatKeyFailure(error);
      }
      const final =
        drain.drained + drain.stopping === 0 ||
        (drain.stopping === 0 && previous !== null && sameCount(previous, error));
      const now = yield* Clock.currentTimeMillis;
      if (final || now + Duration.toMillis(wait.every) >= deadline) {
        return yield* removalInUse(error, drain, now - started);
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

/**
 * The organization's Boat key (SLNT-790). Members read whether there is one; owners connect,
 * replace, check and remove it. The key goes to Core in the request that connects it and nowhere
 * else: Mend's database, logs, audit log and errors never hold it.
 */
export const BoatKeyGroupLive = HttpApiBuilder.group(MendApi, "boatKey", (handlers) =>
  Effect.gen(function* () {
    const fullChecks = yield* BoatKeyFullChecks;
    return handlers
      .handle("status", () =>
        Effect.gen(function* () {
          const found = yield* membership;
          return yield* statusOf(
            fullChecks,
            found,
            yield* (yield* BoatKeysRepo).byOwner(organizationOwner(found)),
          );
        }),
      )
      .handle("connect", ({ payload }) =>
        Effect.gen(function* () {
          const found = yield* ownership;
          const problem = boatKeyShapeProblem(payload.key);
          if (problem !== null)
            return yield* new BoatKeyRefused({ reason: "shape", message: problem });
          const key = Redacted.make(payload.key.trim());
          const owner = organizationOwner(found);
          const keys = yield* BoatKeysRepo;
          const clients = yield* SealantClients;
          const existing = yield* keys.byOwner(owner);
          if (existing !== null) {
            const rotated = yield* clients
              .rotateBoatAccountKey(existing.sealantBoatAccountId, key)
              .pipe(Effect.tapError(logBoatRefusal), Effect.mapError(boatKeyFailure));
            const replaced = yield* keys.markReplaced(owner);
            yield* record(found, "boat_key.replaced", existing.sealantBoatAccountId);
            return yield* statusOf(fullChecks, found, replaced, rotated);
          }
          const account = yield* clients
            .createBoatAccount(`Mend · ${found.organization.name}`.slice(0, LABEL_LIMIT), key)
            .pipe(Effect.tapError(logBoatRefusal), Effect.mapError(boatKeyFailure));
          const caller = yield* CurrentUser;
          const connected = yield* keys
            .connect({
              owner,
              sealantBoatAccountId: account.boatAccountId,
              connectedByUserId: caller.user.id,
            })
            .pipe(
              Effect.catchTag("BoatKeyTakenError", () =>
                // Another owner's connect won: the account made here holds nothing yet, so it goes.
                clients.removeBoatAccount(account.boatAccountId).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.fail(
                      new BoatKeyConflict({
                        reason: "taken",
                        message:
                          "Another owner connected a Boat key for the organization at the same moment, so this one was not kept. Read the status, and replace the key if it should be this one.",
                        liveRuns: null,
                        buildsInFlight: null,
                        unseen: null,
                      }),
                    ),
                  ),
                ),
              ),
            );
          yield* record(found, "boat_key.connected", account.boatAccountId);
          yield* rewarmStandbys(found);
          return yield* statusOf(fullChecks, found, connected, account);
        }),
      )
      .handle("check", () =>
        Effect.gen(function* () {
          const found = yield* ownership;
          const key = yield* (yield* BoatKeysRepo).byOwner(organizationOwner(found));
          if (key === null) {
            return new BoatKeyCheck({
              state: "none",
              observedAt: yield* DateTime.nowAsDate,
              keyReplacedAt: null,
              report: null,
              unanswered: null,
            });
          }
          return yield* checkBoatKeyAccount(key);
        }),
      )
      .handle("disconnect", () =>
        Effect.gen(function* () {
          const found = yield* ownership;
          const owner = organizationOwner(found);
          const keys = yield* BoatKeysRepo;
          // One key change per organization at a time: a second removal asked meanwhile finds no
          // key once the first is done, and reports nothing it did not do.
          return yield* (yield* SessionEngine).changingBoatKey(found.organization.id, (standbys) =>
            Effect.gen(function* () {
              const existing = yield* keys.byOwner(owner);
              if (existing === null) return yield* statusOf(fullChecks, found, null);
              const drain = yield* removeAccount(existing.sealantBoatAccountId, standbys);
              // Another server process may have removed the row meanwhile: it recorded that.
              if ((yield* keys.remove(owner)) === null)
                return yield* statusOf(fullChecks, found, null);
              yield* record(found, "boat_key.removed", existing.sealantBoatAccountId, {
                standbysDrained: drain.drained,
              });
              const status = yield* statusOf(fullChecks, found, null);
              return new BoatKeyStatus({
                ...status,
                removal: new BoatKeyRemoval({ standbysDrained: drain.drained }),
              });
            }),
          );
        }),
      )
      .handle("fullCheck", () =>
        Effect.gen(function* () {
          const found = yield* ownership;
          const key = yield* (yield* BoatKeysRepo).byOwner(organizationOwner(found));
          if (key === null)
            return yield* new BoatKeyConflict({
              reason: "none",
              message:
                "This organization has no Boat key connected, so there is nothing to check. Connect one first.",
              liveRuns: null,
              buildsInFlight: null,
              unseen: null,
            });
          const run = yield* fullChecks.run(key.sealantBoatAccountId).pipe(
            Effect.tapError(logBoatRefusal),
            Effect.mapError((error) =>
              error._tag === "BoatAccountRefusal" && error.reason === "proof-running"
                ? new BoatKeyConflict({
                    reason: "proof-running",
                    message: `A full check of this key is running, or Sealant is still removing what the last one made in Boat, so no other was started. Sealant says: ${error.message}`,
                    liveRuns: null,
                    buildsInFlight: null,
                    unseen: null,
                  })
                : boatKeyFailure(error),
            ),
          );
          return run._tag === "finished"
            ? new BoatKeyFullCheck({ last: run.proof, runningSince: null })
            : new BoatKeyFullCheck({ last: null, runningSince: run.since });
        }),
      );
  }),
);
