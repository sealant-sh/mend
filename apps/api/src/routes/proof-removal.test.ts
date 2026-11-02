import { RemovalFenceId } from "@mend/db";
import { proofBlobPrefix } from "@mend/domain/workbench";
import { BlobStoreError } from "@mend/store";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

it("keeps failed proof blob deletion retryable before cascading the worktree", async () => {
  const target = ids("private-alice");
  const listed: Array<string> = [];
  const removed: Array<string> = [];
  let refuse = true;
  let handedOver = false;
  const mark = RemovalFenceId.make("proof-removal-mark");
  const api = await createTenancyApi(
    {},
    {
      implement: {
        engine: { launchUnderWay: () => false, captureHolds: () => Effect.succeed([]) },
        forwards: { listOpen: () => Effect.succeed([]) },
        store: { removeWorktreeForce: () => Effect.succeed({ leftover: null }) },
        removalFences: {
          take: () =>
            Effect.succeed(handedOver ? { _tag: "finish", id: mark } : { _tag: "held", id: mark }),
          commit: () => Effect.succeed(true),
          renew: () => Effect.succeed(true),
          handOver: () =>
            Effect.sync(() => {
              handedOver = true;
            }),
        },
        proofBlobs: {
          identity: "test:proof",
          list: (prefix) =>
            Effect.sync(() => {
              listed.push(prefix);
              return [{ key: `${prefix}image.png`, size: 8 }];
            }),
          remove: (key) =>
            refuse
              ? Effect.fail(
                  new BlobStoreError({ operation: "remove", key, cause: "disk unavailable" }),
                )
              : Effect.sync(() => {
                  removed.push(key);
                }),
        },
      },
    },
  );
  try {
    const change = api.world.changes.get(target.change);
    expect(change).toBeDefined();
    const first = await api.request(
      "alice",
      "DELETE",
      `/api/worktrees/${target.worktree}?force=true`,
    );
    expect(first.status).toBe(500);
    expect(api.world.worktrees.has(target.worktree)).toBe(true);
    refuse = false;
    const second = await api.request(
      "alice",
      "DELETE",
      `/api/worktrees/${target.worktree}?force=true`,
    );
    expect(second.status).toBe(200);
    expect(listed).toEqual([proofBlobPrefix(target.change), proofBlobPrefix(target.change)]);
    expect(removed).toEqual([`${proofBlobPrefix(target.change)}image.png`]);
    expect(api.world.worktrees.has(target.worktree)).toBe(false);
  } finally {
    await api.dispose();
  }
});
