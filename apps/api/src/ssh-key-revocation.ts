import { AuditEventsRepo, type SshKeyRevocation, SshKeyRevocationsRepo } from "@mend/db";
import { SealantClients } from "@mend/sealant";
import { Duration, Effect, Layer, Result, Schedule } from "effect";
import * as Context from "effect/Context";

/** What one attempt at a removed member's keys came to. */
export interface SshKeyRevocationOutcome {
  /** Keys archived by this attempt. */
  readonly removed: number;
  /** Keys still active after it; null when the platform could not list them. */
  readonly outstanding: number | null;
}

/** How long the remover's own first attempt holds the row off the sweep. */
export const SSH_KEY_REVOCATION_LEASE = Duration.minutes(2);
/**
 * How long a member removal waits on its own first attempt before it answers. Past it the attempt
 * stops, what it archived stays archived, and the sweep takes the rest once the lease runs out.
 * A reference so a test can shorten it.
 */
export const SshKeyFirstAttemptLimit: Context.Reference<Duration.Duration> =
  Context.Reference<Duration.Duration>("@mend/api/SshKeyFirstAttemptLimit", {
    defaultValue: () => Duration.seconds(15),
  });
/** How often the worker looks for due revocations. */
export const SSH_KEY_REVOCATION_SWEEP_INTERVAL = Duration.minutes(1);
const RETRY_FLOOR_MS = 30_000;
const RETRY_CEILING_MS = 30 * 60_000;

/** 30 s, doubling per failed attempt, at most 30 minutes: Mend keeps trying until it is done. */
export const sshKeyRevocationRetryMs = (attempts: number): number =>
  Math.min(RETRY_CEILING_MS, RETRY_FLOOR_MS * 2 ** Math.min(attempts, 16));

/**
 * Archiving a removed member's workspace SSH keys (docs/WORKSPACE-SSH.md). The membership's
 * deletion records what is owed (`ssh_key_revocations`); each attempt archives every key the
 * platform still lists for them, past individual failures, and either settles the row or defers it.
 * The worker's sweep retries a deferred row until the platform holds no active key of theirs.
 */
export class SshKeyRevoker extends Context.Service<
  SshKeyRevoker,
  {
    readonly attempt: (owed: SshKeyRevocation) => Effect.Effect<SshKeyRevocationOutcome>;
    /** One pass over the due rows. */
    readonly sweep: () => Effect.Effect<
      ReadonlyArray<{ readonly userId: string; readonly outcome: SshKeyRevocationOutcome }>
    >;
  }
>()("@mend/api/SshKeyRevoker") {}

export const SshKeyRevokerLive: Layer.Layer<
  SshKeyRevoker,
  never,
  AuditEventsRepo | SealantClients | SshKeyRevocationsRepo
> = Layer.effect(
  SshKeyRevoker,
  Effect.gen(function* () {
    const audit = yield* AuditEventsRepo;
    const clients = yield* SealantClients;
    const revocations = yield* SshKeyRevocationsRepo;

    const attempt = Effect.fn("SshKeyRevoker.attempt")(function* (owed: SshKeyRevocation) {
      const keys = clients.sshKeys(owed.userId);
      const retryInMs = sshKeyRevocationRetryMs(owed.attempts);
      const listed = yield* keys.list().pipe(Effect.result);
      if (Result.isFailure(listed)) {
        yield* revocations.defer(owed.id, {
          outstanding: null,
          lastError: listed.failure.message,
          retryInMs,
        });
        return { removed: 0, outstanding: null };
      }
      let removed = 0;
      let lastError: string | null = null;
      let outstanding = 0;
      // One key's failure never stops the rest: each is archived on its own.
      for (const key of listed.success) {
        const archived = yield* keys.remove(key.sshKeyId).pipe(Effect.result);
        if (Result.isFailure(archived)) {
          outstanding += 1;
          lastError = archived.failure.message;
          continue;
        }
        // Null: no longer active (archived since the listing), so nothing is owed for it.
        if (archived.success === null) continue;
        removed += 1;
        yield* audit.record({
          organizationId: owed.organizationId,
          actorUserId: owed.actorUserId,
          action: "ssh_key.removed",
          subjectType: "member",
          subjectId: owed.userId,
          data: {
            sshKeyId: archived.success.sshKeyId,
            fingerprint: archived.success.fingerprint,
            name: archived.success.name,
            memberRemoved: true,
            attempt: owed.attempts + 1,
          },
        });
      }
      if (lastError === null) {
        yield* revocations.settle(owed.id);
      } else {
        yield* revocations.defer(owed.id, { outstanding, lastError, retryInMs });
      }
      return { removed, outstanding };
    });

    const sweep = Effect.fn("SshKeyRevoker.sweep")(function* () {
      const due = yield* revocations.claimDue(20, Duration.toMillis(SSH_KEY_REVOCATION_LEASE));
      const done: Array<{ readonly userId: string; readonly outcome: SshKeyRevocationOutcome }> =
        [];
      for (const owed of due) {
        const outcome = yield* attempt(owed);
        if (outcome.outstanding !== 0) {
          yield* Effect.logWarning("ssh key revocation: keys still active, retrying later").pipe(
            Effect.annotateLogs({
              userId: owed.userId,
              outstanding: outcome.outstanding ?? "unread",
              attempts: owed.attempts + 1,
            }),
          );
        }
        done.push({ userId: owed.userId, outcome });
      }
      return done;
    });

    return { attempt, sweep };
  }),
);

/** The minute's pass, in every worker; the claim keeps each person to one of them at a time. */
export const SshKeyRevocationScheduleLive: Layer.Layer<never, never, SshKeyRevoker> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const revoker = yield* SshKeyRevoker;
      yield* Effect.forkScoped(
        revoker.sweep().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("ssh key revocation: pass failed").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
          Effect.repeat(Schedule.spaced(SSH_KEY_REVOCATION_SWEEP_INTERVAL)),
        ),
      );
    }),
  );
