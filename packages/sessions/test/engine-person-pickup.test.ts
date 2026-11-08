import { SessionId } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type {
  CreateOptions,
  Workspace,
  WorkspaceCaptureOwnerMap,
  WorkspaceCaptureReplanned,
} from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer, memoryHotPool } from "./engine/capture-fixture.ts";
import { makeStandbyClock } from "./engine/clock-fixture.ts";
import {
  isPickupExec,
  recordingProtocolHostLayer,
  redeemPickupExec,
  secretFilesLayerOf,
  servedSocketApis,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

describe("who may redeem a pickup ticket (review of mend#555, P3-10)", () => {
  const npmrc = "//registry.npmjs.org/:_authToken=npm_redeem_rules_0123456789";
  const sealedNpmrc = () =>
    secretFilesLayerOf(() =>
      Effect.succeed([
        {
          path: ".npmrc",
          sealedContents: `sealed:${Buffer.from(npmrc, "utf8").toString("base64")}`,
        },
      ]),
    );

  it("a same-owner sibling's socket redeems; another owner's socket in the same worktree does not, on a retained run", async () => {
    const created: Array<CreateOptions> = [];
    const answers: Array<string> = [];
    // Through which session's socket the next delivery's ticket is presented.
    let via: SessionId | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const first = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          via = first.id;
          yield* engine.launch(first.id, ["codex"]);
          yield* engine.openShell(first.id);
          // The holder's own delivery, through its own socket.
          expect(answers).toEqual(["answered"]);

          // A second session of the same owner joins the executor: its delivery, through the
          // socket the workspace mounts (the first session's), is answered.
          const sibling = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          const converse = (sessionId: SessionId, owner: string) =>
            engine.launchProtocol(sessionId, { mode: "protocol", permissionMode: "bypass" }, owner);
          yield* converse(sibling.id, "user-fixture");
          expect(world.sessions.get(sibling.id)?.sealantWorkspaceId).toBe("workspace-1");
          expect(answers).toEqual(["answered", "answered"]);

          // Maria's session in the same worktree: no delivery of hers there (another person's
          // home), but her socket is served. A retained run of the sibling presents its ticket
          // through her socket: refused, and spent.
          const maria = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-maria",
          });
          yield* converse(maria.id, "user-maria");
          expect(answers).toHaveLength(2);
          via = maria.id;
          yield* engine.stop(sibling.id);
          yield* converse(sibling.id, "user-fixture");
          expect(created).toHaveLength(1);
          expect(answers).toEqual([
            "answered",
            "answered",
            "refused: this pickup ticket is another session's",
          ]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: lifecycleLayer(created, {
          execCalls: [],
          captureOps: {
            execEffect: (argv) => {
              if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
              return redeemPickupExec(argv, via).pipe(
                Effect.match({
                  onFailure: (error) => {
                    answers.push(`refused: ${error.message}`);
                    return {
                      exitCode: 0,
                      stdout: `refused\t.npmrc\t${error.message}\n`,
                      stderr: "",
                    };
                  },
                  onSuccess: (answer) => {
                    expect(Buffer.from(answer.files[0]?.base64 ?? "", "base64").toString()).toBe(
                      npmrc,
                    );
                    answers.push("answered");
                    return { exitCode: 0, stdout: "written\t.npmrc\n", stderr: "" };
                  },
                }),
              );
            },
          },
        }),
        secretFilesLayer: sealedNpmrc(),
        protocolHostLayer: recordingProtocolHostLayer([], []),
      },
    );
  });

  it.effect(
    "a launch that claimed a standby redeems through the standby's launch, and through no other",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        const memory = makeMemoryCaptureStore();
        const pool = memoryHotPool();
        const clock = yield* makeStandbyClock(pool);
        const answers: Array<string> = [];
        let executor: SessionId | null = null;
        const replan = (workspace: Workspace) =>
          Effect.gen(function* () {
            if (executor === null) throw new Error("no executor to replan");
            const api = servedSocketApis.get(executor)?.capture;
            if (api === undefined) throw new Error("the executor serves no capture api");
            const plan = yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(
              Effect.mapError(
                (error) =>
                  new SealantPlatformError({
                    code: "replan_refused",
                    status: error.status,
                    message: `${error.reason}: ${error.message}`,
                    cause: error,
                  }),
              ),
            );
            void workspace;
            return {
              worktreeId: plan.worktree_id,
              epoch: plan.epoch,
              ...(plan.head === null
                ? {}
                : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
              filesWritten: 0,
              bytesWritten: 0,
              filesSkipped: 0,
              bytesSkipped: 0,
              removed: 0,
              unchanged: true,
            } satisfies WorkspaceCaptureReplanned;
          });
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, _tmp, project) =>
            Effect.gen(function* () {
              world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
              const engine = yield* SessionEngine;
              yield* engine.reconcileHotSessions(project.id);
              yield* clock.untilReady(
                () => pool.entries.some((entry) => entry.status === "ready"),
                "a standby",
              );
              const session = yield* clock.claim(
                engine.provision({
                  projectId: project.id,
                  harness: "codex",
                  label: null,
                  name: null,
                  ownerUserId: "user-fixture",
                  start: { kind: "base", base: null },
                }),
              );
              executor = session.id;
              yield* engine.launch(session.id, ["codex"]);
              expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
              expect(answers).toEqual([
                "refused: this pickup ticket is another executor's",
                "refused: this pickup ticket was already redeemed, perhaps through another channel",
              ]);
            }),
          {
            captured: memory,
            hotWorkspacesLayer: clock.poolLayer,
            wrapCaptureChannel: clock.wrapCaptureChannel,
            secretFilesLayer: sealedNpmrc(),
            sealantLayer: lifecycleLayer(created, {
              captureOps: {
                replan,
                execEffect: (argv) => {
                  if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
                  const attempt = (launch: string) =>
                    redeemPickupExec(argv, executor, launch).pipe(
                      Effect.match({
                        onFailure: (error) => void answers.push(`refused: ${error.message}`),
                        onSuccess: () => void answers.push("answered"),
                      }),
                    );
                  // The cold launch key the session would have had, then the standby's own: the
                  // first presentation spends the ticket, so this proves the binding refuses a
                  // launch that is not the standby's.
                  return attempt("not-the-standby-launch").pipe(
                    Effect.andThen(attempt(`standby:${executor ?? ""}`)),
                    Effect.as({ exitCode: 0, stdout: "refused\t.npmrc\tspent\n", stderr: "" }),
                  );
                },
              },
            }),
          },
        );
      }),
  );

  it.effect("the standby's own launch is the one a claimed launch's ticket is bound to", () =>
    Effect.gen(function* () {
      const created: Array<CreateOptions> = [];
      const replanned: Array<
        { readonly expectedOwnerMap: WorkspaceCaptureOwnerMap | null } | undefined
      > = [];
      const pool = memoryHotPool();
      const clock = yield* makeStandbyClock(pool);
      const answers: Array<string> = [];
      let executor: SessionId | null = null;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
            const engine = yield* SessionEngine;
            yield* engine.reconcileHotSessions(project.id);
            yield* clock.untilReady(
              () => pool.entries.some((entry) => entry.status === "ready"),
              "a standby",
            );
            const session = yield* clock.claim(
              engine.provision({
                projectId: project.id,
                harness: "codex",
                label: null,
                name: null,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              }),
            );
            executor = session.id;
            yield* engine.launch(session.id, ["codex"]);
            expect(answers).toEqual(["answered"]);
          }),
        {
          captured: makeMemoryCaptureStore(),
          hotWorkspacesLayer: clock.poolLayer,
          wrapCaptureChannel: clock.wrapCaptureChannel,
          secretFilesLayer: sealedNpmrc(),
          sealantLayer: lifecycleLayer(created, {
            captureOps: {
              replan: (workspace, options) =>
                Effect.gen(function* () {
                  void workspace;
                  replanned.push(options);
                  const api = servedSocketApis.get(executor ?? SessionId.make(""))?.capture;
                  if (api === undefined) throw new Error("the executor serves no capture api");
                  const plan = yield* api
                    .planGet({ worktree_id: null, epoch: 0 })
                    .pipe(Effect.orDie);
                  return {
                    worktreeId: plan.worktree_id,
                    epoch: plan.epoch,
                    ...(plan.head === null
                      ? {}
                      : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
                    filesWritten: 0,
                    bytesWritten: 0,
                    filesSkipped: 0,
                    bytesSkipped: 0,
                    removed: 0,
                    unchanged: true,
                  } satisfies WorkspaceCaptureReplanned;
                }),
              execEffect: (argv) => {
                if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
                return redeemPickupExec(argv, executor, `standby:${executor ?? ""}`).pipe(
                  Effect.match({
                    onFailure: (error) => {
                      answers.push(`refused: ${error.message}`);
                      return {
                        exitCode: 0,
                        stdout: `refused\t.npmrc\t${error.message}\n`,
                        stderr: "",
                      };
                    },
                    onSuccess: () => {
                      answers.push("answered");
                      return { exitCode: 0, stdout: "written\t.npmrc\n", stderr: "" };
                    },
                  }),
                );
              },
            },
          }),
        },
      );
      // A standby boots with no owner map, and a claim says it expects none (sealant#333), so Core
      // refuses one booted with a map before its daemon is reached.
      expect(replanned).toEqual([{ expectedOwnerMap: null }]);
    }),
  );
});
