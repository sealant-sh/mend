import {
  SLACK_EVENT_CLAIM_RETENTION_MS,
  SlackEventClaimsRepo,
  SlackInstallsRepo,
  type SealedSlackInstall,
} from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { SLACK_LINKED_MENTION_JOB, SlackLinkedMentionJob } from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SLACK_TOKEN_REFUSALS } from "@mend/slack/client";
import { SlackSocket } from "@mend/slack/socket";
import { SecretCipher } from "@mend/store";
import { Effect, Exit, FiberMap, Layer, Schedule, Schema, Stream } from "effect";

import { SlackRunner } from "./slack-runner.ts";

/**
 * The worker's Slack half (docs/adr/0006-slack.md, "Socket Mode, outbound only"): one Socket Mode
 * connection per installed organization per worker process, kept in step with `slack_installs`,
 * and the job that runs a mention once its author links.
 *
 * Installs are reconciled on an interval rather than on a notification: an install saved on
 * another process (the API, in `api` mode) is seen here within one interval without a new
 * channel, and a missed notification can never leave a socket open for a removed install.
 */

/** How often the worker reads `slack_installs` to open, replace or close sockets. */
export const SLACK_RECONCILE_INTERVAL = "30 seconds";
/** How often spent event claims are swept. */
export const SLACK_CLAIM_SWEEP_INTERVAL = "1 hour";

const BACKOFF_FLOOR_MS = 1_000;
const BACKOFF_CEILING_MS = 5 * 60_000;
/** A socket that stayed up this long was healthy: its end starts the backoff over. */
const HEALTHY_MS = 60_000;

/**
 * The wait before reconnecting, after `failures` failed or short-lived connections in a row. A
 * token Slack refused waits the longest: only the owner replacing it helps, and that restarts
 * the connection anyway.
 */
export const reconnectDelayMs = (failures: number, refused: boolean): number =>
  refused
    ? BACKOFF_CEILING_MS
    : Math.min(BACKOFF_CEILING_MS, BACKOFF_FLOOR_MS * 2 ** Math.max(0, failures - 1));

/** What makes a socket stale: another Slack workspace, or another app-level token. */
const fingerprint = (install: SealedSlackInstall): string =>
  `${install.teamId}\n${install.sealedAppToken}`;

export const makeSlackSockets = Effect.gen(function* () {
  const installs = yield* SlackInstallsRepo;
  const cipher = yield* SecretCipher;
  const socket = yield* SlackSocket;
  const runner = yield* SlackRunner;
  const connections = yield* FiberMap.make<OrganizationId>();
  const opened = new Map<OrganizationId, string>();

  /** One install's connection, reconnected for as long as it is supervised. */
  const supervise = (install: SealedSlackInstall) =>
    Effect.gen(function* () {
      let failures = 0;
      const log = { organizationId: install.organizationId, teamId: install.teamId };
      while (true) {
        const openedAt = Date.now();
        const exit = yield* cipher.decrypt(install.sealedAppToken).pipe(
          Effect.flatMap((appToken) =>
            socket
              .connect(appToken)
              .pipe(
                Stream.runForEach((envelope) => runner.receive(install.organizationId, envelope)),
              ),
          ),
          Effect.exit,
        );
        failures = Date.now() - openedAt >= HEALTHY_MS ? 0 : failures + 1;
        const refused =
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" &&
              reason.error._tag === "SlackApiError" &&
              SLACK_TOKEN_REFUSALS.has(reason.error.code),
          );
        const delay = reconnectDelayMs(failures, refused);
        yield* (
          Exit.isFailure(exit)
            ? Effect.logWarning("slack socket: connection failed").pipe(
                Effect.annotateLogs({ cause: String(exit.cause), refused }),
              )
            : Effect.logInfo("slack socket: connection closed")
        ).pipe(Effect.annotateLogs({ ...log, reconnectInMs: delay }));
        yield* Effect.sleep(delay);
      }
    });

  /** Open a socket for every install, replace a changed one, close a removed one. */
  const reconcile = Effect.gen(function* () {
    const current = yield* installs.list();
    const wanted = new Map(current.map((install) => [install.organizationId, install]));
    for (const [organizationId, print] of opened) {
      const install = wanted.get(organizationId);
      if (install !== undefined && fingerprint(install) === print) continue;
      opened.delete(organizationId);
      yield* FiberMap.remove(connections, organizationId);
      yield* Effect.logInfo("slack socket: closed for a removed or replaced install").pipe(
        Effect.annotateLogs({ organizationId }),
      );
    }
    for (const install of current) {
      if (opened.has(install.organizationId)) continue;
      const print = fingerprint(install);
      opened.set(install.organizationId, print);
      yield* FiberMap.run(
        connections,
        install.organizationId,
        // A supervisor that ends for any reason is opened again on the next reconcile.
        supervise(install).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (opened.get(install.organizationId) === print)
                opened.delete(install.organizationId);
            }),
          ),
        ),
      );
    }
  });

  return {
    reconcile,
    /** The organizations with a supervised socket right now. */
    open: () => [...opened.keys()],
  };
});

const decodeLinkedMention = Schema.decodeUnknownEffect(SlackLinkedMentionJob);

/**
 * The mention that waited for its author to link (the confirm route enqueues it, once per code).
 * A payload that does not decode is a defect, and the job, like a claimed event, is not retried.
 */
export const SlackLinkedMentionWorkerLive: Layer.Layer<never, never, JobRunner | SlackRunner> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const jobs = yield* JobRunner;
      const runner = yield* SlackRunner;
      yield* jobs.work(SLACK_LINKED_MENTION_JOB, (payload) =>
        decodeLinkedMention(payload).pipe(Effect.flatMap(runner.runLinked), Effect.orDie),
      );
    }),
  );

/** The worker's Slack sockets, the reconcile loop and the claim sweep. */
export const SlackSocketsLive: Layer.Layer<
  never,
  never,
  SecretCipher | SlackEventClaimsRepo | SlackInstallsRepo | SlackRunner | SlackSocket
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const sockets = yield* makeSlackSockets;
    const claims = yield* SlackEventClaimsRepo;
    yield* sockets.reconcile.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("slack socket: reconcile failed").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
      Effect.repeat(Schedule.spaced(SLACK_RECONCILE_INTERVAL)),
      Effect.forkScoped,
    );
    yield* Effect.suspend(() =>
      claims.sweep(new Date(Date.now() - SLACK_EVENT_CLAIM_RETENTION_MS)),
    ).pipe(Effect.repeat(Schedule.spaced(SLACK_CLAIM_SWEEP_INTERVAL)), Effect.forkScoped);
  }),
);
