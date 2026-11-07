import { ProjectId, WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("explicit pull request merging through T3", () => {
  it.live("sends only the selected remote merge as the paired person", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "app");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PR-MERGE");
        yield* rpc[WS_METHODS.pullRequestsRunAction]({
          projectId: ProjectId.make("project-1"),
          repository: "acme/app",
          number: 42,
          host: "github.com",
          expectedAccountId: "alice",
          action: "merge",
          mergeMethod: "squash",
        });
        const mutations = mend.workbench.calls.filter((call) => call.method === "POST");
        assert.strictEqual(mutations.length, 1);
        assert.strictEqual(mutations[0]?.path, "/api/projects/project-1/pull-requests/42/merge");
        assert.deepStrictEqual(mutations[0]?.body, {
          repository: "acme/app",
          method: "squash",
          expectedAccountId: "alice",
          removeAgentCredits: false,
        });
        assert.strictEqual(mutations[0]?.authorization, `Bearer ${mend.claims[0]?.token}`);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
