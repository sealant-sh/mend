import {
  BoatKeyCheck,
  BoatKeyConflict,
  BoatKeyDetails,
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

const statusOf = (found: OrganizationMembership, key: BoatKey | null) =>
  Effect.gen(function* () {
    // Where this organization's new sessions run: its key is used only for Boat sessions.
    const sessionRuntime = (yield* organizationSessionRuntime(found.organization.id)).effective;
    if (key === null || found.role !== "owner") {
      return new BoatKeyStatus({ connected: key !== null, sessionRuntime, details: null });
    }
    const connectedBy = yield* (yield* UsersRepo).byId(key.connectedByUserId);
    return new BoatKeyStatus({
      connected: true,
      sessionRuntime,
      details: new BoatKeyDetails({
        sealantBoatAccountId: key.sealantBoatAccountId,
        connectedByUserId: key.connectedByUserId,
        connectedByName: connectedBy?.name ?? null,
        connectedAt: key.connectedAt,
        keyReplacedAt: key.keyReplacedAt,
        // SLNT-781 seam: Core's last report for the account (`boatAccounts.list()`), once the
        // pinned SDK returns one. Until then Mend has observed nothing about the key itself.
        report: null,
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
        const problem = boatKeyShapeProblem(payload.key);
        if (problem !== null)
          return yield* new BoatKeyRefused({ reason: "shape", message: problem });
        const key = Redacted.make(payload.key.trim());
        const owner = organizationOwner(found);
        const keys = yield* BoatKeysRepo;
        const clients = yield* SealantClients;
        const existing = yield* keys.byOwner(owner);
        if (existing !== null) {
          yield* clients
            .rotateBoatAccountKey(existing.sealantBoatAccountId, key)
            .pipe(Effect.mapError(boatKeyFailure));
          const replaced = yield* keys.markReplaced(owner);
          yield* record(found, "boat_key.replaced", existing.sealantBoatAccountId);
          return yield* statusOf(found, replaced);
        }
        const account = yield* clients
          .createBoatAccount(`Mend · ${found.organization.name}`.slice(0, LABEL_LIMIT), key)
          .pipe(Effect.mapError(boatKeyFailure));
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
        return yield* statusOf(found, connected);
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
          });
        }
        const accounts = yield* (yield* SealantClients).listBoatAccounts().pipe(
          Effect.mapError((error) => {
            const failure = boatKeyFailure(error);
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
            if (existing === null) return yield* statusOf(found, null);
            const drain = yield* removeAccount(existing.sealantBoatAccountId, standbys);
            // Another server process may have removed the row meanwhile: it recorded that.
            if ((yield* keys.remove(owner)) === null) return yield* statusOf(found, null);
            yield* record(found, "boat_key.removed", existing.sealantBoatAccountId, {
              standbysDrained: drain.drained,
            });
            const status = yield* statusOf(found, null);
            return new BoatKeyStatus({
              ...status,
              removal: new BoatKeyRemoval({ standbysDrained: drain.drained }),
            });
          }),
        );
      }),
    ),
);
