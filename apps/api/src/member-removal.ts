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
  SlackLinksRepo,
  UserEvents,
  UsersRepo,
} from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { Duration, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { ConnectionRegistry } from "./connections.ts";
import {
  SSH_KEY_REVOCATION_LEASE,
  SshKeyFirstAttemptLimit,
  type SshKeyRevocationOutcome,
  SshKeyRevoker,
} from "./ssh-key-revocation.ts";

export interface RemoveMemberInput {
  readonly organizationId: OrganizationId;
  readonly userId: string;
  /** The owner removing them, for the audit log. */
  readonly actorUserId: string;
}

/** What a removal leaves for the owner to know: the workspace SSH keys not yet archived. */
export interface MemberRemovalOutcome {
  readonly sshKeys: SshKeyRevocationOutcome;
}

/**
 * Removing a member (docs/adr/0003-organizations-and-tenancy.md): the membership goes, the account
 * is deactivated, every way it signs in is revoked, its open connections close on every process,
 * its Slack links go (docs/adr/0006-slack.md), its workspace SSH keys are archived on the platform
 * (docs/WORKSPACE-SSH.md), and its unsettled sessions stop. The keys owed are recorded with the
 * membership's deletion, so a key the platform does not archive now is retried by the worker until
 * it is. Stopping flushes
 * and checkpoints like any stop, so the work so far stays reviewable. Private projects stay where
 * they are until an owner takes them over.
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
    ) => Effect.Effect<MemberRemovalOutcome, MemberNotFoundError | LastOwnerError>;
  }
>()("@mend/api/MemberRemoval") {}

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
  | SlackLinksRepo
  | SshKeyRevoker
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
    const revoker = yield* SshKeyRevoker;
    const engine = yield* SessionEngine;
    const sessions = yield* SessionsRepo;
    const slackLinks = yield* SlackLinksRepo;
    const userEvents = yield* UserEvents;
    const users = yield* UsersRepo;
    const scope = yield* Effect.scope;

    /**
     * End what the account left running, then let each pool drop its standbys. Every agent, shell
     * and Service of theirs ends, in their own executors and in others' they joined, and every
     * executor they started is retired: others working in it are stopped with words to start
     * their own, and it saves through the normal Stop (`SessionEngine.windDownPerson`, mend#558).
     */
    const windDown = (input: RemoveMemberInput) =>
      Effect.gen(function* () {
        const done = yield* engine.windDownPerson(input.userId);
        if (done.remaining > 0) {
          yield* Effect.logWarning(
            "member removal: some of the account's processes are still running",
          ).pipe(Effect.annotateLogs({ userId: input.userId, remaining: done.remaining }));
        }
        const inOrganization = yield* projects.listForOrganization(input.organizationId);
        yield* Effect.forEach(
          inOrganization,
          (project) => engine.reconcileHotSessions(project.id),
          { discard: true },
        );
      });

    const remove = Effect.fn("MemberRemoval.remove")(function* (input: RemoveMemberInput) {
      // Read first: the membership going takes the Slack links with it.
      const linked = yield* slackLinks.listForUser(input.userId);
      // The owner lock refuses removing the last owner before anything else moves; the keys owed
      // are recorded in the same transaction as the membership's deletion.
      const requestedAt = new Date();
      const { revocationId } = yield* organizations.removeMember(
        input.organizationId,
        input.userId,
        {
          actorUserId: input.actorUserId,
          revocationLeaseMs: Duration.toMillis(SSH_KEY_REVOCATION_LEASE),
        },
      );
      // Their open pages hear why before anything they ask is refused: a page that is refused
      // first walks to a plain sign-in that cannot say why (live pass 2026-10-10). Other
      // processes close the account's connections on it; this one closes them below.
      yield* userEvents.changed(input.userId, "access");
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
      // Their queued turns in anyone's session go: none of them runs (docs/adr/0016, decision 6).
      const inOrganization = yield* projects.listForOrganization(input.organizationId);
      const live = (yield* Effect.forEach(inOrganization, (project) =>
        sessions.listForProject(project.id),
      ))
        .flat()
        .filter((session) => session.settledAt === null)
        .map((session) => session.id);
      yield* engine.cancelQueuedTurnsBy(input.userId, live);
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
      // Nobody in Slack acts as the removed account any more. The database already dropped the
      // links with the membership; this says so explicitly and records each one.
      for (const link of linked) {
        yield* slackLinks.unlink(link.teamId, link.slackUserId);
        yield* audit.record({
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: "slack.link_removed",
          subjectType: "member",
          subjectId: input.userId,
          data: { teamId: link.teamId, slackUserId: link.slackUserId, memberRemoved: true },
        });
      }
      // Mend's own revocation never waits on the platform. This process closes the account's
      // connections now, and the sessions begin to stop.
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
      // Only now the platform: no workspace SSH key of theirs opens a new connection at the
      // gateway. Every key is tried, for at most `SshKeyFirstAttemptLimit`; what the platform
      // does not archive in that time stays owed, the worker retries it, and the owner is told.
      // An interrupted removal leaves the row too, so nothing below this line is lost with it.
      const firstAttemptLimit = yield* SshKeyFirstAttemptLimit;
      const sshKeys = yield* revoker
        .attempt({
          id: revocationId,
          userId: input.userId,
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          requestedAt,
          attempts: 0,
          outstanding: null,
          lastError: null,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: firstAttemptLimit,
            orElse: () =>
              Effect.logWarning(
                "member removal: SSH key revocation still running at the limit; the sweep takes it",
              ).pipe(
                Effect.annotateLogs({ userId: input.userId }),
                Effect.as<SshKeyRevocationOutcome>({ removed: 0, outstanding: null }),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("member removal: the first SSH key revocation attempt failed").pipe(
              Effect.annotateLogs({ userId: input.userId, cause: String(cause) }),
              Effect.as({ removed: 0, outstanding: null }),
            ),
          ),
        );
      if (sshKeys.outstanding !== 0) {
        yield* audit.record({
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          action: "ssh_key.revocation_pending",
          subjectType: "member",
          subjectId: input.userId,
          data: { removed: sshKeys.removed, outstanding: sshKeys.outstanding },
        });
      }
      return { sshKeys };
    });

    return { remove };
  }),
);
