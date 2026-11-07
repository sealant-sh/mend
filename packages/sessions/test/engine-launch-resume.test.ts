import * as fs from "node:fs";
import * as path from "node:path";

import { SessionProcess } from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { processStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, SessionOptions } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { signalledFixture } from "./engine/clock-fixture.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

describe("SessionEngine", () => {
  it("brings an ask session back asking: resume, follow-up and a relaunch that names no mode", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const authors: Array<string | null> = [];
    const permissionModes: Array<"bypass" | "ask"> = [];
    await withEngine(
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
          yield* engine.launchProtocol(
            session.id,
            {
              mode: "protocol",
              prompt: "inspect replay",
              model: "gpt-test",
              effort: "high",
              permissionMode: "ask",
            },
            "user-1",
          );

          // POST /sessions/:id/resume after a stop (an idle stop included).
          yield* engine.stop(session.id, "idle · stopped after 15 min · reply to resume");
          yield* engine.resumeSession(session.id, null);
          // A follow-up to the stopped session relaunches it.
          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");
          // POST /sessions/:id/launch with no permission mode, as the Slack runner sends it.
          yield* engine.stop(session.id);
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "and the other test" },
            "user-2",
          );

          expect(attached).toHaveLength(4);
          expect(permissionModes).toEqual(["ask", "ask", "ask", "ask"]);
          for (const { process } of attached) {
            expect(process.kind).toBe("agent-protocol");
            expect(process.protocolOptions).toEqual({
              model: "gpt-test",
              effort: "high",
              permissionMode: "ask",
            });
          }

          // A relaunch that names a mode is taken as given.
          yield* engine.stop(session.id);
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            null,
          );
          expect(permissionModes.at(-1)).toBe("bypass");
          expect(attached.at(-1)?.process.protocolOptions?.permissionMode).toBe("bypass");
          // ...and is what the next resume keeps.
          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          expect(permissionModes.at(-1)).toBe("bypass");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(
          attached,
          submitted,
          authors,
          permissionModes,
        ),
      },
    );
  });

  it("resumes a claude ask session without the bypass flag", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const permissionModes: Array<"bypass" | "ask"> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "inspect replay", permissionMode: "ask" },
            "user-1",
          );
          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");

          expect(attached).toHaveLength(3);
          expect(permissionModes).toEqual(["ask", "ask", "ask"]);
          for (const { process } of attached) {
            expect(process.argv).not.toContain("bypassPermissions");
            expect(process.protocolOptions?.permissionMode).toBe("ask");
          }
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted, [], permissionModes),
      },
    );
  });

  it("resumes a bypass session as bypass", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    const permissionModes: Array<"bypass" | "ask"> = [];
    await withEngine(
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
          // A first launch that names no mode runs on the default.
          yield* engine.launchProtocol(session.id, { mode: "protocol", prompt: "go" }, "user-1");
          yield* engine.stop(session.id);
          yield* engine.resumeSession(session.id, null);
          yield* engine.stop(session.id);
          yield* engine.launchFollowUp(session.id, "address the review", "follow-up-1", "user-2");

          expect(permissionModes).toEqual(["bypass", "bypass", "bypass"]);
          expect(attached.map(({ process }) => process.protocolOptions?.permissionMode)).toEqual([
            "bypass",
            "bypass",
            "bypass",
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted, [], permissionModes),
      },
    );
  });

  it("settles a stop with the summary it was given: the idle stop's words", async () => {
    const created: CreateOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    await withEngine(
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "inspect replay", permissionMode: "bypass" },
            "user-1",
          );

          yield* engine.stop(session.id, "idle · stopped after 15 min · reply to resume");

          const settled = world.sessions.get(session.id);
          expect(settled?.status).toBe("stopped");
          expect(settled?.summary).toBe("idle · stopped after 15 min · reply to resume");
          const agent = [...world.processes.values()].find(
            (process) => process.kind === "agent-protocol",
          );
          expect(agent?.status).toBe("stopped");
          expect(agent?.exitedAt).not.toBeNull();

          // Resume works as after any stop.
          yield* engine.resumeSession(session.id, null);
          expect(attached[1]?.process.kind).toBe("agent-protocol");
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("resumes an idle protocol session in the workspace retained by its shell", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const openedOptions: SessionOptions[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    await withEngine(
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const shell = yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(1);
          expect(stopped).toEqual([]);
          expect(world.processes.get(shell.id)?.exitedAt).toBeNull();
          expect(attached).toHaveLength(2);
          expect(attached[1]?.mode).toBe("pipe");
          expect(attached[1]?.process.kind).toBe("agent-protocol");
          expect(attached[1]?.process.sealantWorkspaceId).toBe(shell.sealantWorkspaceId);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          stopped,
          undefined,
          undefined,
          undefined,
          undefined,
          openedOptions,
        ),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it("honors a fresh protocol resume while a shell retains the old workspace", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    await withEngine(
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          const shell = yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");

          const resumed = yield* engine.resumeSession(session.id, null, true);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(world.processes.get(shell.id)?.exitedAt).not.toBeNull();
          expect(attached).toHaveLength(2);
          expect(attached[1]?.process.kind).toBe("agent-protocol");
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, stopped),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });

  it.effect("restores harvested state into the fresh workspace a protocol resume provisions", () =>
    Effect.gen(function* () {
      // Live failure 2026-08-28 (PoC session 59e473f4): launchProtocol passed an explicit
      // null state to launchInternal, which skips the restore — while the composed argv
      // still resumed by provider id. On a fresh workspace claude then exited 1 with
      // "No conversation found with session ID". The restore must reach the new workspace.
      const created: CreateOptions[] = [];
      const stopped: string[] = [];
      const spawned: ReadonlyArray<string>[] = [];
      const execCalls: ReadonlyArray<string>[] = [];
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const submitted: string[] = [];
      const { world, tmp, untilChanged, changed } = yield* signalledFixture("mend-launch-test-");
      // Every exec the engine ran wakes `untilChanged`: the settle-path harvest runs forked.
      const signallingExecs = Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (client) => ({
          ...client,
          exec: (workspace, argv, options) =>
            client.exec(workspace, argv, options).pipe(Effect.ensuring(Effect.sync(changed))),
        })),
      ).pipe(
        Layer.provide(
          sealantLaunchLayer(
            created,
            undefined,
            stopped,
            spawned,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            execCalls,
          ),
        ),
      );
      yield* withPreparedEngineEffect(
        (_world, dir) => setup(dir, world),
        (_world, _dir, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launchProtocol(
              session.id,
              { mode: "protocol", permissionMode: "bypass" },
              "user-1",
            );
            const agent = [...world.processes.values()].find(
              (process) => process.kind === "agent-protocol",
            );
            if (agent === undefined || agent.providerSessionId === null) {
              throw new Error("the protocol launch recorded no provider session id");
            }
            yield* engine.stop(session.id);
            // The settle-path harvest (forked) clears the manifest before its capture fails
            // against the empty exec output; wait for its pack attempt before planting state.
            const packRan = () =>
              execCalls.some((argv) => argv.join(" ").includes("mend-harness-state"));
            yield* untilChanged(packRan, "the harvest's pack attempt");
            expect(packRan()).toBe(true);
            const stateDir = processStatePathOf(project.storePath, session.id, agent.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness: "claude",
                providerSessionId: agent.providerSessionId,
                capturedAt: new Date().toISOString(),
              }),
            );
            fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");

            const resumed = yield* engine.resumeSession(session.id, null);
            expect(resumed.status).toBe("running");
            expect(created).toHaveLength(2);
            // The saved state was staged into the worktree and unpacked in the NEW workspace
            // before the harness started.
            const restoreExec = execCalls.find((argv) =>
              argv.join(" ").includes(".mend-harness-state-"),
            );
            expect(restoreExec?.join(" ")).toContain("tar -xzf");
            // And the relaunch still resumes the native conversation.
            const resumeArgv = spawned.at(-1) ?? [];
            expect(resumeArgv).toContain("--resume");
            expect(resumeArgv).toContain(agent.providerSessionId);
          }),
        {
          fixture: { world, tmp },
          sealantLayer: signallingExecs,
          protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
        },
      );
    }),
  );

  it("falls back to a fresh protocol launch when the retained workspace disappears", async () => {
    const created: CreateOptions[] = [];
    const stopped: string[] = [];
    const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
    const submitted: string[] = [];
    let simulateDisappearance = false;
    let workspaceLookups = 0;
    await withEngine(
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
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-1",
          );
          yield* engine.openShell(session.id);
          yield* engine.stop(session.id);
          expect(world.sessions.get(session.id)?.status).toBe("idle");
          simulateDisappearance = true;

          const resumed = yield* engine.resumeSession(session.id, null);

          expect(resumed.status).toBe("running");
          expect(created).toHaveLength(2);
          expect(stopped).toEqual(["workspace-1"]);
          expect(attached).toHaveLength(2);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, stopped, undefined, () => {
          if (!simulateDisappearance) return false;
          workspaceLookups += 1;
          return workspaceLookups === 2;
        }),
        protocolHostLayer: recordingProtocolHostLayer(attached, submitted),
      },
    );
  });
});
