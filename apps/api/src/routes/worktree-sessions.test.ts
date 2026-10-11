import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * A new conversation inside an existing worktree (the web composer's start): the session's own
 * "Land when a turn completes" override reaches the engine (docs/adr/0007-landing.md).
 */

const sharedA = ids("shared-a");

interface Provisioned {
  readonly worktreeId: string;
  readonly harness: string;
  readonly ownerUserId: string | null;
  readonly autoLand: boolean | null | undefined;
}

let provisioned: Array<Provisioned> = [];

describe("POST /worktrees/:id/sessions", () => {
  let api: TenancyApi;

  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            provisionSessionIn: (worktreeId, input) =>
              Effect.suspend(() => {
                provisioned.push({
                  worktreeId,
                  harness: input.harness,
                  ownerUserId: input.ownerUserId,
                  autoLand: input.autoLand,
                });
                const session = api.world.sessions.get(sharedA.session);
                return session === undefined
                  ? Effect.die("no session in the world")
                  : Effect.succeed(session);
              }),
          },
        },
      },
    );
  });

  afterAll(async () => {
    await api.dispose();
  });

  beforeEach(() => {
    provisioned = [];
  });

  const start = (body: object) =>
    api.request("alice", "POST", `/api/worktrees/${sharedA.worktree}/sessions`, body);

  it("passes the composer's override to the engine", async () => {
    expect((await start({ harness: "claude", autoLand: true })).status).toBe(200);
    expect((await start({ harness: "claude", autoLand: false })).status).toBe(200);
    expect(provisioned).toEqual([
      { worktreeId: sharedA.worktree, harness: "claude", ownerUserId: "alice", autoLand: true },
      { worktreeId: sharedA.worktree, harness: "claude", ownerUserId: "alice", autoLand: false },
    ]);
  });

  it("follows the project when an older client leaves the key out", async () => {
    expect((await start({ harness: "claude" })).status).toBe(200);
    expect(provisioned).toEqual([
      { worktreeId: sharedA.worktree, harness: "claude", ownerUserId: "alice", autoLand: null },
    ]);
  });
});
