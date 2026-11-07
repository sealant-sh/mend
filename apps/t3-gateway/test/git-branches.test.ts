import { WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const cwd = "/var/lib/mend/store/project-1/worktrees/wt-session-1";

describe("the owner's thread branch", () => {
  it.live("creates and switches through Mend, then accepts T3's matching metadata update", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "BRANCHES");
        assert.deepStrictEqual(
          yield* rpc[WS_METHODS.vcsCreateRef]({ cwd, refName: "feature/new", switchRef: true }),
          { refName: "feature/new" },
        );
        assert.deepStrictEqual(
          yield* rpc[WS_METHODS.vcsSwitchRef]({ cwd, refName: "main" }),
          { refName: "main" },
        );
        const actions = mend.workbench.calls.filter((call) => call.path.endsWith("/branch"));
        assert.deepStrictEqual(actions.map((call) => call.body), [
          { kind: "create", refName: "feature/new", switchRef: true },
          { kind: "switch", refName: "main" },
        ]);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );

  it.live("keeps Mend's refusal and never treats the bare project root as a checkout", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "BRANCH-REFUSAL");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(rpc[WS_METHODS.vcsSwitchRef]({
          cwd: "/var/lib/mend/store/project-1/repo.git", refName: "main",
        }))));
        assert.lengthOf(mend.workbench.calls.filter((call) => call.path.endsWith("/branch")), 0);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );
});
