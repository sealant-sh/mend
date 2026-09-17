import {
  AuditEventsRepo,
  DevicesRepo,
  type LastOwnerError,
  type MemberNotFoundError,
  OrganizationsRepo,
  ProjectsRepo,
  PushDevicesRepo,
  SessionControlEventsRepo,
  SessionsRepo,
  UserEvents,
  UsersRepo,
} from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { ConnectionRegistry } from "./connections.ts";

export interface RemoveMemberInput {
  readonly organizationId: OrganizationId;
  readonly userId: string;
  /** The owner removing them, for the audit log. */
  readonly actorUserId: string;
}

/**
 * Removing a member (docs/adr/0003-organizations-and-tenancy.md): the membership goes, the account
 * is deactivated, every way it signs in is revoked, its open connections close on every process,
 * and its unsettled sessions stop. Stopping flushes and checkpoints like any stop, so the work so
 * far stays reviewable. Private projects stay where they are until an owner takes them over.
 */
export class MemberRemoval extends Context.Service<
  MemberRemoval,
  {
    /**
     * Revocation happens before this answers; stopping sessions and draining hot pools continue in
     * the background, since a stop waits on the workspace.
     */
    readonly remove: (
      input: RemoveMemberInput,
    ) => Effect.Effect<void, MemberNotFoundError | LastOwnerError>;
  }
>()("@mend/api/MemberRemoval") {}

/** How many of the removed account's sessions stop at once. */
const STOP_CONCURRENCY = 4;

export const MemberRemovalLive: Layer.Layer<
  MemberRemoval,
  never,
  | AuditEventsRepo
  | ConnectionRegistry
  | DevicesRepo
  | OrganizationsRepo
  | ProjectsRepo
  | PushDevicesRepo
  | SessionControlEventsRepo
  | SessionEngine
  | SessionsRepo
  | UserEvents
  | UsersRepo
> = Layer.effect(
  MemberRemoval,
  Effect.gen(function* () {
    const audit = yield* AuditEventsRepo;
    const connections = yield* ConnectionRegistry;
    const controlEvents = yield* SessionControlEventsRepo;
    const devices = yield* DevicesRepo;
    const organizations = yield* OrganizationsRepo;
    const projects = yield* ProjectsRepo;
    const pushDevices = yield* PushDevicesRepo;
    const engine = yield* SessionEngine;
    const sessions = yield* SessionsRepo;
    const userEvents = yield* UserEvents;
    const users = yield* UsersRepo;
    const scope = yield* Effect.scope;

    /** Stop what the account left running, then let each pool drop its standbys. */
    const windDown = (input: RemoveMemberInput) =>
      Effect.gen(function* () {
        const running = yield* sessions.listUnsettledForOwner(input.userId);
        yield* Effect.forEach(
          running,
          (session) =>
            engine
              .stop(session.id)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("member removal: a session did not stop").pipe(
                    Effect.annotateLogs({ sessionId: session.id, cause: String(cause) }),
                  ),
                ),
              ),
          { concurrency: STOP_CONCURRENCY, discard: true },
        );
        const inOrganization = yield* projects.listForOrganization(input.organizationId);
        yield* Effect.forEach(
          inOrganization,
          (project) => engine.reconcileHotSessions(project.id),
          { discard: true },
        );
      });

    const remove = Effect.fn("MemberRemoval.remove")(function* (input: RemoveMemberInput) {
      // The owner lock refuses removing the last owner before anything else moves.
      yield* organizations.removeMember(input.organizationId, input.userId);
      // Nobody keeps steering on the removed account's credentials, even before their sessions stop.
      const unshared = yield* sessions.disableSharedControlForOwner(input.userId);
      yield* Effect.forEach(
        unshared,
        (sessionId) =>
          controlEvents.record({
            sessionId,
            actorUserId: input.actorUserId,
            kind: "shared-control-off",
            refId: null,
          }),
        { discard: true },
      );
      yield* users.deactivate(input.userId);
      yield* users.revokeAuthSessions(input.userId);
      yield* devices.revokeAllForUser(input.userId);
      yield* pushDevices.removeAllForUser(input.userId);
      yield* audit.record({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: "member.removed",
        subjectType: "member",
        subjectId: input.userId,
      });
      // Other processes close on the event; this one closes now.
      yield* userEvents.changed(input.userId, "access");
      yield* connections.closeForUser(input.userId);
      yield* Effect.forkIn(
        windDown(input).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("member removal: winding down the account's sessions failed").pipe(
              Effect.annotateLogs({ userId: input.userId, cause: String(cause) }),
            ),
          ),
        ),
        scope,
      );
    });

    return { remove };
  }),
);
