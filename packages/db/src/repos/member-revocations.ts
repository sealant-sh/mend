import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId, SessionId } from "@mend/domain";
import { and, eq, isNull } from "drizzle-orm";
import { Cause, DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { type MendEvent, notifyEvent } from "../events.ts";
import { agentSessions, agentTurns, projects } from "../schema/workbench.ts";
import { cancelOpenTurnRows } from "./agent-conversation.ts";
import { disableOwnerSharedControl } from "./agent-sessions.ts";
import { DevicesRepo } from "./devices.ts";
import {
  deleteMemberWithSshDebt,
  type LastOwnerError,
  type MemberNotFoundError,
} from "./organizations.ts";
import { PushDevicesRepo } from "./push-devices.ts";
import { SlackLinksRepo } from "./slack-links.ts";
import { UsersRepo } from "./users.ts";

/** The committed removal's facts, retained before cascading membership links disappear. */
export const MemberRevocation = Schema.Struct({
  organizationId: OrganizationId,
  userId: Schema.String,
  revocationId: Schema.String,
  requestedAt: Schema.Date,
  unshared: Schema.Array(Schema.Struct({ id: SessionId, projectId: ProjectId })),
  queuedSessions: Schema.Array(Schema.Struct({ id: SessionId, projectId: ProjectId })),
  linkedSlackFacts: Schema.Array(
    Schema.Struct({ teamId: Schema.String, slackUserId: Schema.String }),
  ),
});

/** Immutable facts for postcommit dispatch and notification. */
export type MemberRevocation = typeof MemberRevocation.Type;

/** Membership deletion and every local credential/control revocation have one durable outcome. */
export class MemberRevocationsRepo extends Context.Service<
  MemberRevocationsRepo,
  {
    /**
     * All local mutations and SSH debt commit together, or none do. The transaction body remains
     * interruptible even while the caller masks the commit-to-dispatch handoff. No events are sent.
     */
    readonly beginRemoval: (input: {
      readonly organizationId: OrganizationId;
      readonly userId: string;
      readonly actorUserId: string;
      readonly revocationLeaseMs: number;
    }) => Effect.Effect<MemberRevocation, MemberNotFoundError | LastOwnerError>;
    /** Postcommit pointers; failure of one does not skip the others. */
    readonly announce: (removed: MemberRevocation) => Effect.Effect<void>;
  }
>()("@mend/db/MemberRevocationsRepo") {}

/** The existing repositories share this PostgreSQL client's ambient transaction connection. */
export const MemberRevocationsRepoLive: Layer.Layer<
  MemberRevocationsRepo,
  never,
  MendDB | PgClient.PgClient | UsersRepo | DevicesRepo | PushDevicesRepo | SlackLinksRepo
> = Layer.effect(
  MemberRevocationsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;
    const users = yield* UsersRepo;
    const devices = yield* DevicesRepo;
    const pushDevices = yield* PushDevicesRepo;
    const slackLinks = yield* SlackLinksRepo;

    const beginRemoval: MemberRevocationsRepo["Service"]["beginRemoval"] = Effect.fn(
      "MemberRevocationsRepo.beginRemoval",
    )((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const revocationId = crypto.randomUUID();
            const requestedAt = yield* DateTime.nowAsDate;
            const linkedSlackFacts = yield* slackLinks.listForUser(input.userId);
            yield* deleteMemberWithSshDebt(tx, input.organizationId, input.userId, {
              id: revocationId,
              actorUserId: input.actorUserId,
              leaseMs: input.revocationLeaseMs,
            });
            yield* users.deactivate(input.userId);
            yield* users.revokeAuthSessions(input.userId);
            yield* devices.revokeAllForUser(input.userId);
            const unshared = yield* disableOwnerSharedControl(tx, input.userId);
            // A competing claim must see these turns cancelled once the locked rows are released.
            const queued = yield* tx
              .select({ turnId: agentTurns.id, id: agentSessions.id, projectId: projects.id })
              .from(agentTurns)
              .innerJoin(agentSessions, eq(agentTurns.sessionId, agentSessions.id))
              .innerJoin(projects, eq(agentSessions.projectId, projects.id))
              .where(
                and(
                  eq(agentTurns.author, input.userId),
                  eq(agentTurns.status, "queued"),
                  isNull(agentSessions.settledAt),
                  eq(projects.organizationId, input.organizationId),
                ),
              )
              .for("update", { of: agentTurns })
              .pipe(Effect.orDie);
            yield* cancelOpenTurnRows(
              tx,
              queued.map((turn) => turn.turnId),
            );
            yield* pushDevices.removeAllForUser(input.userId);
            return Schema.decodeUnknownSync(MemberRevocation)({
              organizationId: input.organizationId,
              userId: input.userId,
              revocationId,
              requestedAt,
              unshared,
              queuedSessions: [
                ...new Map(
                  queued.map((turn) => [turn.id, { id: turn.id, projectId: turn.projectId }]),
                ).values(),
              ],
              linkedSlackFacts,
            });
          }).pipe(Effect.interruptible),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error))),
    );

    const announce = Effect.fn("MemberRevocationsRepo.announce")(function* (
      removed: MemberRevocation,
    ) {
      const events: ReadonlyArray<MendEvent> = [
        { type: "organization", organizationId: removed.organizationId },
        ...removed.unshared.flatMap(
          (session): ReadonlyArray<MendEvent> => [
            { type: "session", sessionId: session.id, projectId: session.projectId },
            {
              type: "shared-control-off",
              sessionId: session.id,
              projectId: session.projectId,
              ownerUserId: removed.userId,
            },
          ],
        ),
        ...removed.queuedSessions.map(
          (session): MendEvent => ({
            type: "agent-conversation",
            sessionId: session.id,
            projectId: session.projectId,
          }),
        ),
      ];
      for (const event of events) {
        yield* notifyEvent(pg, event).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) =>
              Effect.logWarning("member revocation: a pointer could not be published").pipe(
                Effect.annotateLogs({
                  revocationId: removed.revocationId,
                  event: event.type,
                  cause: String(cause),
                }),
              ),
          ),
        );
      }
    });
    return { beginRemoval, announce };
  }),
);
