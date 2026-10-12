import {
  AuditEventsRepo,
  type LastOwnerError,
  type MemberNotFoundError,
  MemberRevocationsRepo,
  ProjectsRepo,
  SessionControlEventsRepo,
  UserEvents,
} from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { Cause, Duration, Effect, Layer } from "effect";
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
     * Durable local revocation commits before this answers. Connection closure, session stopping
     * and hot-pool draining are dispatched before notifications and continue in the layer scope.
     */
    readonly remove: (
      input: RemoveMemberInput,
    ) => Effect.Effect<MemberRemovalOutcome, MemberNotFoundError | LastOwnerError>;
  }
>()("@mend/api/MemberRemoval") {}

const bestEffort = (operation: string) => (effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Effect.logWarning("member removal: postcommit delivery failed").pipe(
          Effect.annotateLogs({ operation, cause: String(cause) }),
        ),
    ),
  );

export const MemberRemovalLive: Layer.Layer<
  MemberRemoval,
  never,
  | AuditEventsRepo
  | ConnectionRegistry
  | MemberRevocationsRepo
  | ProjectsRepo
  | SessionControlEventsRepo
  | SessionEngine
  | SshKeyRevoker
  | UserEvents
> = Layer.effect(
  MemberRemoval,
  Effect.gen(function* () {
    const audit = yield* AuditEventsRepo;
    const connections = yield* ConnectionRegistry;
    const controlEvents = yield* SessionControlEventsRepo;
    const revocations = yield* MemberRevocationsRepo;
    const projects = yield* ProjectsRepo;
    const revoker = yield* SshKeyRevoker;
    const engine = yield* SessionEngine;
    const userEvents = yield* UserEvents;
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

    const remove = Effect.fn("MemberRemoval.remove")((input: RemoveMemberInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // The transaction body remains interruptible. Its commit and this short handoff do not:
          // a request disconnect after commit cannot skip dispatching local cleanup to layer scope.
          const removed = yield* revocations.beginRemoval({
            ...input,
            revocationLeaseMs: Duration.toMillis(SSH_KEY_REVOCATION_LEASE),
          });
          yield* Effect.forkIn(
            connections
              .closeForUser(input.userId)
              .pipe(Effect.asVoid, bestEffort("closing connections"), Effect.interruptible),
            scope,
          );
          yield* Effect.forkIn(
            windDown(input).pipe(bestEffort("winding down sessions"), Effect.interruptible),
            scope,
          );
          return yield* restore(
            Effect.gen(function* () {
              // Every local revocation is already committed. Each delivery is independent of the
              // others; notification failure cannot strand credentials or prevent cleanup dispatch.
              yield* userEvents
                .changed(input.userId, "access")
                .pipe(bestEffort("access notification"));
              yield* revocations.announce(removed).pipe(bestEffort("change notifications"));
              for (const session of removed.unshared) {
                yield* controlEvents
                  .record({
                    sessionId: session.id,
                    actorUserId: input.actorUserId,
                    kind: "shared-control-off",
                    refId: null,
                  })
                  .pipe(bestEffort("shared control audit"));
              }
              yield* audit
                .record({
                  organizationId: input.organizationId,
                  actorUserId: input.actorUserId,
                  action: "member.removed",
                  subjectType: "member",
                  subjectId: input.userId,
                })
                .pipe(bestEffort("removal audit"));
              for (const link of removed.linkedSlackFacts) {
                yield* audit
                  .record({
                    organizationId: input.organizationId,
                    actorUserId: input.actorUserId,
                    action: "slack.link_removed",
                    subjectType: "member",
                    subjectId: input.userId,
                    data: {
                      teamId: link.teamId,
                      slackUserId: link.slackUserId,
                      memberRemoved: true,
                    },
                  })
                  .pipe(bestEffort("Slack link audit"));
              }
              const { revocationId, requestedAt } = removed;
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
                  Effect.catchCauseIf(
                    (cause) => !Cause.hasInterrupts(cause),
                    (cause) =>
                      Effect.logWarning(
                        "member removal: the first SSH key revocation attempt failed",
                      ).pipe(
                        Effect.annotateLogs({ userId: input.userId, cause: String(cause) }),
                        Effect.as({ removed: 0, outstanding: null }),
                      ),
                  ),
                );
              if (sshKeys.outstanding !== 0) {
                yield* audit
                  .record({
                    organizationId: input.organizationId,
                    actorUserId: input.actorUserId,
                    action: "ssh_key.revocation_pending",
                    subjectType: "member",
                    subjectId: input.userId,
                    data: { removed: sshKeys.removed, outstanding: sshKeys.outstanding },
                  })
                  .pipe(bestEffort("SSH revocation audit"));
              }
              return { sshKeys };
            }),
          );
        }),
      ),
    );

    return { remove };
  }),
);
