import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionEngine, startFromBase } from "@mend/sessions";
import { worktreePathOf } from "@mend/store";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { ProtocolHost } from "../src/protocol-host.ts";
import {
  makeWorld,
  protocolHostStubLayer,
  recordedTurnsLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { makeHistoryMemory } from "./session-history-memory.ts";

// Ordinary trigger: Undo on a session's first message, including when it joins an older worktree.
it("seals this session's pre-prompt files before dispatch, rather than reusing worktree zero", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-rollback-origin-"));
  const history = makeHistoryMemory();
  const host = Layer.effect(
    ProtocolHost,
    Effect.map(ProtocolHost, (stub) => ({
      ...stub,
      attach: (input) => input.hooks.beforeDispatch?.() ?? Effect.void,
    })),
  ).pipe(Layer.provide(protocolHostStubLayer));
  try {
    await withEngine(
      (world, directory) =>
        Effect.gen(function* () {
          const project = yield* setup(directory, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: "Origin",
            name: "origin",
            start: startFromBase(null),
            ownerUserId: "user-fixture",
          });
          const repository = worktreePathOf(project.storePath, session.worktree);
          fs.writeFileSync(path.join(repository, "before-prompt.txt"), "session-local baseline\n");
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const observations = [...history.observations.values()];
          const origin = observations.find(
            (item) => item.kind === "ready" && item.boundary.anchor.kind === "threadStart",
          );
          expect(origin?.kind).toBe("ready");
          if (origin?.kind !== "ready") return;
          expect(origin.boundary.nativeSeedId).toBeNull();
          expect(origin.boundary.originProof?.beforeFirstDispatch).toBe(true);
          expect(origin.boundary.sessionId).toBe(session.id);
          expect(origin.boundary.checkpointId).not.toBe(world.checkpoints[0]?.id);
          expect(fs.readFileSync(path.join(repository, "before-prompt.txt"), "utf8")).toBe(
            "session-local baseline\n",
          );
        }),
      {
        fixture: { tmp, world: makeWorld() },
        history,
        sealantLayer: sealantLaunchLayer([]),
        conversationLayer: recordedTurnsLayer([]),
        protocolHostLayer: host,
      },
    );
  } finally {
    console.info("Removing task-owned origin fixture", tmp, fs.readdirSync(tmp));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
