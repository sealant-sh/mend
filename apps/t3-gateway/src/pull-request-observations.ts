import { createHash, randomUUID } from "node:crypto";

import {
  CommandId,
  ThreadPullRequestSnapshot,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MendPullRequestDetail } from "./mend-pull-requests.ts";
import type { MendChangeLandings } from "./mend-workbench.ts";
import type { PullRequestLinkCommand } from "./pull-request-links.ts";

/** Refresh linked PR observations. A failed host read preserves the last observed snapshot. */
export const observeLinkedPullRequests = <E, E2>(input: {
  readonly threads: () => ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: string;
    readonly links: ReadonlyArray<ThreadPullRequestLink>;
  }>;
  readonly read: (
    projectId: string,
    repository: string,
    number: number,
  ) => Effect.Effect<MendPullRequestDetail, E>;
  readonly apply: (command: PullRequestLinkCommand) => Effect.Effect<number, E2>;
}) =>
  Effect.gen(function* () {
    const reads = new Map<
      string,
      ReadonlyArray<{
        readonly id: ThreadId;
        readonly projectId: string;
        readonly link: ThreadPullRequestLink;
      }>
    >();
    for (const thread of input.threads())
      for (const link of thread.links) {
        if (link.host.toLowerCase() !== "github.com" || link.source === "stack-dismissed") continue;
        const key = `${link.repository.toLowerCase()}:${link.number}`;
        reads.set(key, [...(reads.get(key) ?? []), { ...thread, link }]);
      }
    for (const entries of reads.values()) {
      const first = entries[0];
      if (first === undefined) continue;
      yield* Effect.gen(function* () {
        const { pullRequest: pr } = yield* input.read(
          first.projectId,
          first.link.repository,
          first.link.number,
        );
        const snapshot = yield* Schema.decodeUnknownEffect(ThreadPullRequestSnapshot)({
          ...pr,
          syncedAt: new Date(pr.observedAt).toISOString(),
        });
        for (const entry of entries)
          yield* input.apply({
            type: "thread.pull-request-link.sync",
            commandId: CommandId.make(randomUUID()),
            threadId: entry.id,
            host: entry.link.host,
            repository: entry.link.repository,
            number: entry.link.number,
            snapshot,
            stack: entry.link.stack,
          });
      }).pipe(Effect.catch(() => Effect.void));
    }
  });

/** Bring Mend's recorded landing PR into the native link list once per person and thread. */
export const discoverLandingPullRequests = <E, E2>(input: {
  readonly threads: () => ReadonlyArray<{
    readonly id: ThreadId;
    readonly changeId: string | null;
  }>;
  readonly read: (changeId: string) => Effect.Effect<MendChangeLandings, E>;
  readonly apply: (command: PullRequestLinkCommand) => Effect.Effect<number, E2>;
}) =>
  Effect.gen(function* () {
    for (const thread of input.threads()) {
      const changeId = thread.changeId;
      if (changeId === null) continue;
      yield* Effect.gen(function* () {
        const history = yield* input.read(changeId);
        const landing = history.landings.find((candidate) => candidate.pullRequest !== null);
        const pr = landing?.pullRequest;
        if (landing === undefined || pr === null || pr === undefined) return;
        const parsed =
          /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([0-9]+)\/?$/u.exec(
            pr.url,
          );
        const repository = parsed?.[1];
        if (repository === undefined || Number(parsed?.[2]) !== pr.number) return;
        // The durable command receipt prevents an unlinked landing from being rediscovered,
        // including after a restart. A different PR has its own receipt.
        yield* input.apply({
          type: "thread.pull-request.link",
          commandId: CommandId.make(
            `landing-pr:${createHash("sha256")
              .update(JSON.stringify([thread.id, repository.toLowerCase(), pr.number]))
              .digest("hex")}`,
          ),
          threadId: thread.id,
          host: "github.com",
          repository,
          number: pr.number,
          url: pr.url,
          source: "created",
        });
      }).pipe(Effect.catch(() => Effect.void));
    }
  });
