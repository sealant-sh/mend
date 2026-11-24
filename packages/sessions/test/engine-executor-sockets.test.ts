import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  type ExecutorSockets,
  type ExecutorSocketsBinding,
  executorScopeOf,
  WORKSPACE_SESSION_SOCKET,
} from "../src/executor-sockets.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { sealantLaunchLayer, setup, withEngine } from "./engine/fixture.ts";

/**
 * A capture launch where Mend serves the control root (SLNT-1332): the executor's `capture.sock`
 * and `session.sock` are bound in the scope the create names, before the executor exists.
 */

const recordingSockets = (events: Array<string>) => {
  const binds: Array<ExecutorSocketsBinding> = [];
  const unbinds: Array<string> = [];
  const sockets: ExecutorSockets["Service"] = {
    bind: (binding) =>
      Effect.sync(() => {
        events.push(`bind:${binding.mode}`);
        binds.push(binding);
        return [];
      }),
    unbind: (scope) =>
      Effect.sync(() => {
        events.push("unbind");
        unbinds.push(scope);
      }),
  };
  return { sockets, binds, unbinds };
};

const launchOn = (
  runtime: "docker" | "host-vm",
  options: { readonly sockets?: boolean; readonly refuseCreate?: boolean } = {},
) => {
  const created: Array<CreateOptions> = [];
  const events: Array<string> = [];
  const recorded = recordingSockets(events);
  const run = withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: "codex",
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        return yield* engine.launch(session.id, ["codex"]).pipe(Effect.result);
      }),
    {
      captured: makeMemoryCaptureStore(),
      sessionRuntime: runtime,
      ...(options.sockets === false ? {} : { launchSockets: recorded.sockets }),
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          beforeCreate: () =>
            Effect.suspend(() => {
              events.push("create");
              return options.refuseCreate === true
                ? Effect.fail(
                    new SealantPlatformError({
                      code: "runtime-requirement-unsupported",
                      status: 422,
                      message: "refused in this test",
                      cause: null,
                    }),
                  )
                : Effect.void;
            }),
        },
      ),
    },
  );
  return run.then((outcome) => ({ outcome, created, events, ...recorded }));
};

describe("an executor's sockets at launch", () => {
  it("on Docker, binds both sockets in the scope it names before the create, which asks for both", async () => {
    const { created, events, binds } = await launchOn("docker");
    expect(events.slice(0, 2)).toEqual(["bind:normal", "create"]);
    const [binding] = binds;
    expect(binding?.mode).toBe("normal");
    expect(binding?.scope).toBe(executorScopeOf(binding?.launchId ?? ""));
    expect(binding?.scope).toMatch(/^mend-[0-9a-f]{24}$/);
    expect(created[0]?.controlScope).toBe(binding?.scope);
    expect(created[0]?.executorSockets).toEqual({ capture: true, session: true });
    // The workspace's processes reach the session channel through its socket.
    expect(created[0]?.env?.["MEND_SESSION_SOCKET"]).toBe(WORKSPACE_SESSION_SOCKET);
  });

  it("on a host VM, names the scope and asks for no flag: its runner relays both sockets", async () => {
    const { created, binds } = await launchOn("host-vm");
    expect(binds).toHaveLength(1);
    expect(created[0]?.controlScope).toBe(binds[0]?.scope);
    expect(created[0]?.executorSockets).toBeUndefined();
    expect(created[0]?.env?.["MEND_SESSION_SOCKET"]).toBeUndefined();
  });

  it("names no scope where Mend serves no control root, as before", async () => {
    const { created, binds } = await launchOn("docker", { sockets: false });
    expect(binds).toEqual([]);
    expect(created[0]?.controlScope).toBeUndefined();
    expect(created[0]?.executorSockets).toBeUndefined();
  });

  it("closes the scope's sockets when the create is refused: no executor will dial them", async () => {
    const { outcome, binds, unbinds } = await launchOn("docker", { refuseCreate: true });
    expect(outcome._tag).toBe("Failure");
    expect(unbinds).toContain(binds[0]?.scope);
  });
});
