import { WorkspaceReplaceRefusedError } from "@mend/sessions";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/** "Replace this workspace now" (docs/adr/0016, decision 14), over the two-organization world. */
describe("a pre-release workspace's replacement", () => {
  let api: TenancyApi;
  const shared = ids("shared-a");
  const replace = `/api/sessions/${shared.session}/workspace-retirement/replace`;
  const asked: Array<string> = [];

  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            replaceWorkspaceNow: (sessionId, actor) =>
              Effect.suspend(() => {
                asked.push(actor);
                return actor === "carol"
                  ? Effect.fail(
                      new WorkspaceReplaceRefusedError({
                        sessionId,
                        message: "Only the change's owner replaces this worktree's workspace.",
                      }),
                    )
                  : Effect.void;
              }),
          },
        },
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("asks the engine for whoever sees the session, and says the engine's refusal as it is", async () => {
    const alice = await api.request("alice", "POST", replace);
    const carol = await api.request("carol", "POST", replace);
    const bob = await api.request("bob", "POST", replace);
    expect([alice.status, carol.status, bob.status]).toEqual([204, 409, 404]);
    expect(await carol.json()).toMatchObject({
      _tag: "WorkspaceReplaceRefused",
      message: "Only the change's owner replaces this worktree's workspace.",
    });
    expect(asked).toEqual(["alice", "carol"]);
  });
});
