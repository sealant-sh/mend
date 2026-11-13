import {
  BoatKeyCheck,
  BoatKeyConflict,
  BoatKeyDetails,
  BoatKeyOwnersOnly,
  BoatKeyRefused,
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
import { type BoatKeyOwner, boatKeyShapeProblem } from "@mend/domain/workbench";
import { type BoatAccountRefusal, SealantClients, type SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { DateTime, Effect, Redacted } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { membership } from "./organization.ts";

/** Core keeps at most 200 characters of a Boat account's label. */
const LABEL_LIMIT = 200;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What a Core refusal means for the person who asked, by the call that was refused. */
type BoatKeyCall = "connect" | "replace" | "remove" | "check";

const UNREACHABLE =
  "Mend could not reach this server's Sealant, so nothing changed. Try again in a minute.";

/**
 * Core's refusal in words the owner can act on (SLNT-790). Core's own message is never passed on:
 * it is written for Core's operators, and the reason and counts carry everything it says.
 */
export const boatKeyFailure =
  (call: BoatKeyCall) =>
  (
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
      case "in-use": {
        if (call !== "remove") {
          return conflict(
            "in-use",
            "A Boat session in the organization is starting right now, and only the current key can find its VM. Nothing changed. Try again once it has started.",
          );
        }
        const held = [
          error.liveRuns === null || error.liveRuns === 0
            ? null
            : plural(error.liveRuns, "workspace whose VM", "workspaces whose VMs"),
          error.buildsInFlight === null || error.buildsInFlight === 0
            ? null
            : plural(error.buildsInFlight, "image build", "image builds"),
        ].filter((part) => part !== null);
        const counted = held.length === 0 ? "workspaces whose VMs" : held.join(" and ");
        return conflict(
          "in-use",
          `The organization's Boat account still has ${counted} Boat may be running, standby workspaces included. Removing the key now would leave them where Mend can no longer reach them, so nothing changed. Stop the organization's Boat sessions, set hot sessions to 0 on projects that keep standbys, then remove the key again.`,
        );
      }
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
    const sessionRuntime = (yield* DeploymentConfig).sessionRuntime ?? null;
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

const record = (
  found: OrganizationMembership,
  action: "boat_key.connected" | "boat_key.replaced" | "boat_key.removed",
  sealantBoatAccountId: string,
) =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    yield* (yield* AuditEventsRepo).record({
      organizationId: found.organization.id,
      actorUserId: caller.user.id,
      action,
      subjectType: "boat_key",
      subjectId: sealantBoatAccountId,
      data: {},
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
            .pipe(Effect.mapError(boatKeyFailure("replace")));
          const replaced = yield* keys.markReplaced(owner);
          yield* record(found, "boat_key.replaced", existing.sealantBoatAccountId);
          return yield* statusOf(found, replaced);
        }
        const account = yield* clients
          .createBoatAccount(`Mend · ${found.organization.name}`.slice(0, LABEL_LIMIT), key)
          .pipe(Effect.mapError(boatKeyFailure("connect")));
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
            const failure = boatKeyFailure("check")(error);
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
        const existing = yield* keys.byOwner(owner);
        if (existing === null) return yield* statusOf(found, null);
        // Core refuses while the account still holds VMs; one it no longer has, or is already
        // removing, is gone as far as new sessions go.
        yield* (yield* SealantClients).removeBoatAccount(existing.sealantBoatAccountId).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (error) =>
              error._tag === "BoatAccountRefusal" &&
              (error.reason === "not-found" || error.reason === "removing"),
            () => Effect.void,
          ),
          Effect.mapError(boatKeyFailure("remove")),
        );
        yield* keys.remove(owner);
        yield* record(found, "boat_key.removed", existing.sealantBoatAccountId);
        yield* rewarmStandbys(found);
        return yield* statusOf(found, null);
      }),
    ),
);
