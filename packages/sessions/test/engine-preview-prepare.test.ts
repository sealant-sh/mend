import * as fs from "node:fs";
import * as path from "node:path";

import { AgentConversationRepo } from "@mend/db";
import {
  AgentTurnId,
  type PreviewId,
  type ServiceId,
  SessionId,
  SessionProcessId,
} from "@mend/domain";
import {
  AgentTurn,
  type PreviewPhase,
  type PreviewPreparationHold,
  previewTurnStartId,
  type ServiceStopCause,
} from "@mend/domain/workbench";
import {
  ForwardAdapter,
  type ForwardReady,
  type ForwardTarget,
  SessionEngine,
} from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { provisionIn } from "./engine/capture-fixture.ts";
import {
  agentConversationStub,
  sealantLaunchLayer,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";

const OWNER = "user-fixture";
const STEERER = "user-maria";
const ownerStart = { kind: "person", userId: OWNER } as const;
const agentStop: ServiceStopCause = { kind: "workspace" };
const steererStop: ServiceStopCause = { kind: "person", userId: STEERER };

const RECIPES = `
[setup]
run = ["pnpm install --frozen-lockfile"]
inputs = ["pnpm-lock.yaml"]

[service.web]
command = "pnpm dev"
port = 3000
browserScheme = "http"
depends = ["db"]
ready = { http = "/", timeout = "5s" }

[service.db]
command = "postgres"
port = 5432

[preview]
service = "web"
`;
const EDITED = RECIPES.replace('command = "pnpm dev"', 'command = "pnpm dev --edited"');
const RECIPE_COMMANDS: ReadonlySet<string> = new Set(["pnpm dev", "pnpm dev --edited", "postgres"]);
const LOCK_A = "lockfileVersion: '9.0'\n";
const LOCK_B = "lockfileVersion: '9.0'\n# a dependency added\n";

const answering = (target: ForwardTarget): ForwardReady => ({
  dialId: "dial",
  purpose: "readiness",
  workspaceId: target.workspaceId,
  port: target.port,
  requested: target.binding,
  lookupMs: 0,
  attempts: [],
  totalMs: 0,
  kind: "ready",
  arrival: { route: "loopback", proof: { kind: "port" } },
});

const answers200: Layer.Layer<ForwardAdapter> = Layer.succeed(ForwardAdapter, {
  probe: (target) => Effect.succeed(answering(target)),
  open: (target) =>
    Effect.sync(() => {
      let sent = false;
      return {
        record: answering(target),
        bytes: {
          write: () => Effect.void,
          read: () =>
            Effect.sync(() => {
              if (sent) return { kind: "eof" as const };
              sent = true;
              return {
                kind: "bytes" as const,
                bytes: new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n"),
              };
            }),
          finish: () => Effect.void,
          close: () => Effect.void,
        },
      };
    }),
});

type Prepared = Effect.Success<ReturnType<SessionEngine["Service"]["preparePreview"]>>;

interface Harness {
  readonly engine: SessionEngine["Service"];
  readonly world: World;
  readonly sessionId: SessionId;
  readonly write: (file: string, text: string) => void;
  readonly timeline: ReadonlyArray<string>;
  readonly setup: {
    exitCode: number;
    /** Runs inside each setup step, as the step runs. */
    during: Effect.Effect<void> | null;
  };
  readonly workspace: { ended: boolean };
  /** Prepares turn `n` under a hold that always holds, unless one is given. */
  readonly prepare: (
    n: number,
    hold?: PreviewPreparationHold,
    sessionId?: SessionId,
  ) => Effect.Effect<
    { readonly outcome: Prepared; readonly reports: ReadonlyArray<PreviewPhase> },
    unknown
  >;
  /** A second live session in the same worktree. */
  readonly sibling: () => Effect.Effect<SessionId, unknown>;
  readonly previewId: () => PreviewId;
  readonly webOf: () => ServiceId;
  readonly senderByTurn: Map<number, string>;
}

const withPreview = (run: (harness: Harness) => Effect.Effect<void, unknown, SessionEngine>) => {
  const created: CreateOptions[] = [];
  const timeline: string[] = [];
  const spawned: ReadonlyArray<string>[] = [];
  const control: Harness["setup"] = { exitCode: 0, during: null };
  const workspace: Harness["workspace"] = { ended: false };
  const senderByTurn = new Map<number, string>();
  return withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const { engine, session } = yield* provisionIn(project);
        yield* engine.launch(session.id, ["codex"]);
        const dir = path.join(tmp, "store", "fixture", "worktrees", session.worktree);
        const write = (file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
        write("pnpm-lock.yaml", LOCK_A);
        write("mend.toml", RECIPES);
        const webOf = () => {
          const web = [...world.services.values()].find(
            (service) => service.sessionId === session.id && service.name === "web",
          );
          if (web === undefined) throw new Error("no web Service");
          return web.id;
        };
        yield* run({
          engine,
          world,
          sessionId: session.id,
          write,
          timeline,
          setup: control,
          workspace,
          sibling: () =>
            Effect.gen(function* () {
              const second = yield* engine.provisionSessionIn(session.worktreeId, {
                harness: "codex",
                label: null,
                ownerUserId: OWNER,
              });
              yield* engine.launch(second.id, ["codex"]);
              return second.id;
            }),
          prepare: (n, hold, sessionId = session.id) =>
            Effect.gen(function* () {
              const reports: PreviewPhase[] = [];
              const recording: PreviewPreparationHold = {
                report: (starting) =>
                  Effect.sync(() => void reports.push(starting.phase)).pipe(
                    Effect.andThen(hold?.report(starting) ?? Effect.succeed(true)),
                  ),
                holds: hold?.holds ?? Effect.succeed(true),
              };
              const outcome = yield* engine.preparePreview(
                sessionId,
                AgentTurnId.make(`turn-${n}`),
                recording,
              );
              return { outcome, reports };
            }),
          previewId: () => {
            const preview = [...world.previews.values()].find((kept) => kept.serviceName === "web");
            if (preview === undefined) throw new Error("no web preview");
            return preview.id;
          },
          webOf,
          senderByTurn,
        });
      }),
    {
      forwardAdapterLayer: answers200,
      conversationLayer: Layer.succeed(AgentConversationRepo, {
        ...agentConversationStub,
        byTurnId: (id) =>
          Effect.sync(() => {
            const n = Number(id.replace("turn-", ""));
            const author = senderByTurn.get(n);
            return author === undefined
              ? null
              : new AgentTurn({
                  id,
                  sessionId: SessionId.make("session-of-the-turn"),
                  processId: SessionProcessId.make("process-turns"),
                  ordinal: n,
                  author,
                  input: "change it",
                  status: "completed",
                  providerTurnId: null,
                  error: null,
                  usage: null,
                  createdAt: new Date(),
                  startedAt: new Date(),
                  endedAt: new Date(),
                });
          }),
      }),
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        spawned,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          execEffect: (argv) => {
            const at = argv.indexOf("mend-setup");
            const step = at === -1 ? undefined : argv[at + 1];
            if (step === undefined) return undefined;
            return Effect.gen(function* () {
              timeline.push(`setup:${step}`);
              if (control.during !== null) yield* control.during;
              return { exitCode: control.exitCode, stdout: "", stderr: "" };
            });
          },
          status: () => (workspace.ended ? "stopped" : undefined),
          beforeOpen: (argv) => {
            const command = argv.at(-1);
            if (command !== undefined && RECIPE_COMMANDS.has(command)) timeline.push(command);
          },
        },
      ),
    },
  );
};

const startedOnceThenAgentStopped = (harness: Harness) =>
  Effect.gen(function* () {
    yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
    yield* harness.engine.stopServices(harness.sessionId, agentStop);
  });

const commandsAfter = (timeline: ReadonlyArray<string>, from: number) => timeline.slice(from);

describe("preparing the preview after a changed turn (ADR 0017, After the agent is done)", () => {
  it("runs changed setup, then the dependency, then the Service, then its HTTP check, as its last starter", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.world.serviceStarters.set(harness.webOf(), STEERER);
        harness.write("pnpm-lock.yaml", LOCK_B);
        const before = harness.timeline.length;

        const { outcome, reports } = yield* harness.prepare(1);

        expect(outcome).toEqual({
          _tag: "Started",
          service: "web",
          previewId: harness.previewId(),
          note: null,
        });
        expect(commandsAfter(harness.timeline, before)).toEqual([
          "setup:pnpm install --frozen-lockfile",
          "postgres",
          "pnpm dev",
        ]);
        expect(harness.world.setupRuns).toMatchObject([{ state: "done", runsAs: STEERER }]);
        const web = harness.world.services.get(harness.webOf());
        const observed = [...harness.world.serviceObservations.values()].filter(
          (observation) => observation.serviceId === web?.id,
        );
        expect(observed.at(-1)).toMatchObject({ state: "reachable", httpStatus: 200 });
        expect(reports).toEqual(["setup", "depends", "service"]);
      }),
    ));

  it("leaves a running preview alone, and says when the turn changed its setup inputs", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
        const before = harness.timeline.length;

        const unchanged = yield* harness.prepare(1);
        harness.write("pnpm-lock.yaml", LOCK_B);
        const lockfile = yield* harness.prepare(2);

        expect([unchanged, lockfile].map(({ outcome }) => outcome)).toEqual([
          { _tag: "Running", service: "web", previewId: harness.previewId(), note: null },
          {
            _tag: "Running",
            service: "web",
            previewId: harness.previewId(),
            note: "setup-inputs-changed",
          },
        ]);
        expect(commandsAfter(harness.timeline, before), "nothing ran again").toEqual([]);
      }),
    ));

  it("starts a running preview again from the file once the turn changed its recipe, as the turn's sender", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
        const first = harness.webOf();
        harness.write("mend.toml", EDITED);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.senderByTurn.set(1, STEERER);
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1);
        const again = yield* harness.prepare(2);

        expect(outcome).toEqual({
          _tag: "Started",
          service: "web",
          previewId: harness.previewId(),
          note: null,
        });
        expect(commandsAfter(harness.timeline, before), "db is reused").toEqual([
          "setup:pnpm install --frozen-lockfile",
          "pnpm dev --edited",
        ]);
        expect(harness.webOf()).toBe(first);
        expect(harness.world.setupRuns.at(-1)).toMatchObject({ state: "done", runsAs: STEERER });
        expect(again.outcome, "the next turn finds the file's launch running").toMatchObject({
          _tag: "Running",
        });
      }),
    ));

  it("restarts the preview selected in a sibling session as the turn's sender", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
        const original = harness.webOf();
        const sibling = yield* harness.sibling();
        harness.write("mend.toml", EDITED);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.senderByTurn.set(1, STEERER);
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1, undefined, sibling);

        expect(outcome).toMatchObject({ _tag: "Started", service: "web" });
        expect(commandsAfter(harness.timeline, before)).toContain("pnpm dev --edited");
        expect(harness.world.services.get(original)?.currentAttemptId).not.toBeNull();
        expect(harness.world.setupRuns.at(-1)).toMatchObject({ state: "done", runsAs: STEERER });
        expect(
          [...harness.world.services.values()].filter((service) => service.name === "web"),
        ).toHaveLength(1);
        expect((yield* harness.prepare(2, undefined, sibling)).outcome._tag).toBe("Running");
      }),
    ));

  it("starts nothing a person stopped; the agent's own stop does not hold it", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
        yield* harness.engine.stopServices(harness.sessionId, agentStop);
        yield* harness.engine.stopService(harness.webOf(), steererStop);
        const before = harness.timeline.length;

        const stopped = yield* harness.prepare(1);
        expect(stopped.outcome).toEqual({
          _tag: "Stopped",
          service: "web",
          previewId: harness.previewId(),
        });
        expect(commandsAfter(harness.timeline, before)).toEqual([]);

        yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
        yield* harness.engine.stopServices(harness.sessionId, agentStop);
        const agentStopped = yield* harness.prepare(2);
        expect(agentStopped.outcome).toMatchObject({ _tag: "Started", service: "web" });
      }),
    ));

  it("a person's Stop of the start while its setup runs holds, through the start and the next turn", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.setup.during = harness.engine
          .stopServiceStarts(harness.sessionId, "web", steererStop)
          .pipe(Effect.orDie, Effect.asVoid);
        const before = harness.timeline.length;

        const stopped = yield* harness.prepare(1);
        harness.setup.during = null;
        const next = yield* harness.prepare(2);

        expect(stopped.outcome).toEqual({
          _tag: "Stopped",
          service: "web",
          previewId: harness.previewId(),
        });
        expect(next.outcome).toEqual(stopped.outcome);
        expect(commandsAfter(harness.timeline, before)).not.toContain("pnpm dev");
      }),
    ));

  it("a person's Stop of the owner's first Start, during its setup, holds before web has a row", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        const setupRuns = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        harness.setup.during = Deferred.succeed(setupRuns, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const starting = yield* harness.engine
          .runServiceRecipe(harness.sessionId, "web", ownerStart)
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(setupRuns);
        expect(
          [...harness.world.services.values()].some((service) => service.name === "web"),
          "web has no row yet",
        ).toBe(false);
        yield* harness.engine.stopServiceStarts(harness.sessionId, "web", steererStop);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(starting);
        harness.setup.during = null;
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1);

        expect(outcome).toEqual({
          _tag: "Stopped",
          service: "web",
          previewId: harness.previewId(),
        });
        expect(commandsAfter(harness.timeline, before)).toEqual([]);
      }),
    ));

  it("an agent's Stop of a start under way does not hold the next turn's start", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.setup.during = harness.engine
          .stopServiceStarts(harness.sessionId, "web", agentStop)
          .pipe(Effect.orDie, Effect.asVoid);

        const stopped = yield* harness.prepare(1);
        harness.setup.during = null;
        harness.write("pnpm-lock.yaml", LOCK_A);
        const next = yield* harness.prepare(2);

        expect(stopped.outcome).toMatchObject({ _tag: "Stopped", service: "web" });
        expect(next.outcome).toMatchObject({ _tag: "Started", service: "web" });
      }),
    ));

  it.each([
    {
      ended: "a defect",
      during: Effect.die("setup fell over"),
      reason: "the start failed unexpectedly",
    },
    {
      ended: "an interruption",
      during: Effect.interrupt,
      reason: "the start was interrupted before it ended",
    },
  ])("answers a start that ended in $ended as refused", ({ during, reason }) =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.setup.during = during;

        const { outcome } = yield* harness.prepare(1);

        expect(outcome).toEqual({
          _tag: "Refused",
          service: "web",
          previewId: harness.previewId(),
          reason,
        });
      }),
    ),
  );

  it("a second call for the same turn follows the start under way to its end", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        const setupRuns = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        harness.setup.during = Deferred.succeed(setupRuns, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const before = harness.timeline.length;
        const first = yield* harness.prepare(1).pipe(Effect.forkChild);
        yield* Deferred.await(setupRuns);
        const joining = yield* Deferred.make<void>();
        const retry = yield* harness
          .prepare(1, {
            report: () => Deferred.succeed(joining, undefined).pipe(Effect.as(true)),
            holds: Effect.succeed(true),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(joining);
        yield* Deferred.succeed(release, undefined);

        const followed = yield* Fiber.join(retry);
        yield* Fiber.join(first);

        expect(followed.outcome).toEqual({
          _tag: "Started",
          service: "web",
          previewId: harness.previewId(),
          note: null,
        });
        expect(harness.timeline.slice(before).filter((entry) => entry === "pnpm dev")).toEqual([
          "pnpm dev",
        ]);
      }),
    ));

  it("starts nothing once its claim no longer holds when the Service's attempt would begin", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1, {
          report: () => Effect.succeed(true),
          holds: Effect.succeed(false),
        });

        expect(outcome).toEqual({
          _tag: "Skipped",
          why: "the preparation lost its claim, so this start started nothing more",
        });
        expect(commandsAfter(harness.timeline, before)).not.toContain("pnpm dev");
      }),
    ));

  it("a claim lost during setup starts no dependency and no Service after it", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        const claim = { held: true };
        harness.setup.during = Effect.sync(() => {
          claim.held = false;
        });
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1, {
          report: () => Effect.sync(() => claim.held),
          holds: Effect.sync(() => claim.held),
        });
        harness.setup.during = null;

        expect(outcome).toEqual({
          _tag: "Skipped",
          why: "the preparation lost its claim, so this start started nothing more",
        });
        expect(commandsAfter(harness.timeline, before)).toEqual([
          "setup:pnpm install --frozen-lockfile",
        ]);
      }),
    ));

  it("a preparation abandoned during setup leaves its plan to start nothing after setup", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        const setupRuns = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        harness.setup.during = Deferred.succeed(setupRuns, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const before = harness.timeline.length;

        const preparing = yield* harness.prepare(1).pipe(Effect.forkChild);
        yield* Deferred.await(setupRuns);
        yield* Fiber.interrupt(preparing);
        yield* Deferred.succeed(release, undefined);
        const startId = previewTurnStartId(AgentTurnId.make("turn-1"));
        for (let tick = 0; tick < 200; tick += 1) {
          const progress = yield* harness.engine.serviceStartProgress(harness.sessionId, startId);
          if (progress === null || progress.state !== "running") break;
          yield* Effect.sleep("25 millis");
        }
        harness.setup.during = null;

        expect(commandsAfter(harness.timeline, before)).toEqual([
          "setup:pnpm install --frozen-lockfile",
        ]);
      }),
    ));

  it("two sessions of one worktree end changed turns at once, and one web starts", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        const sibling = yield* harness.sibling();
        const before = harness.timeline.length;

        const [first, second] = yield* Effect.all(
          [harness.prepare(1), harness.prepare(1, undefined, sibling)],
          { concurrency: 2 },
        );

        expect([first.outcome, second.outcome].map((prepared) => prepared._tag).toSorted()).toEqual(
          ["Skipped", "Started"],
        );
        expect(
          commandsAfter(harness.timeline, before).filter((entry) => entry === "pnpm dev"),
        ).toEqual(["pnpm dev"]);
      }),
    ));

  it("starts nothing for a preview another start holds", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1, {
          report: () => Effect.succeed(false),
          holds: Effect.succeed(true),
        });

        expect(outcome).toEqual({ _tag: "Skipped", why: "another start of web holds the preview" });
        expect(commandsAfter(harness.timeline, before)).toEqual([]);
      }),
    ));

  it("records the session's end, before planning and once setup ran into it", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.setup.during = Effect.sync(() => {
          harness.workspace.ended = true;
        });
        const before = harness.timeline.length;
        const during = yield* harness.prepare(1);
        harness.setup.during = null;
        const after = yield* harness.prepare(2);

        expect(during.outcome).toEqual({ _tag: "SessionEnded" });
        expect(after.outcome).toEqual({ _tag: "SessionEnded" });
        expect(commandsAfter(harness.timeline, before)).toEqual([
          "setup:pnpm install --frozen-lockfile",
        ]);
      }),
    ));

  it("refuses, in mend.toml's words, a recipe whose depends names a Service it does not declare", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write(
          "mend.toml",
          RECIPES.replace('depends = ["db"]', 'depends = ["db", "missing"]'),
        );
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1);

        expect(outcome).toMatchObject({
          _tag: "Refused",
          service: "web",
          reason: expect.stringContaining("mend.toml refuses web"),
        });
        expect(commandsAfter(harness.timeline, before)).toEqual([]);
      }),
    ));

  it("does not run again a setup that failed at the same fingerprint", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.setup.exitCode = 1;
        const first = yield* harness.prepare(1);
        const ranOnce = harness.timeline.filter((entry) => entry.startsWith("setup:")).length;
        harness.setup.exitCode = 0;
        const second = yield* harness.prepare(2);

        expect(first.outcome).toMatchObject({ _tag: "Refused", service: "web" });
        expect(second.outcome).toMatchObject({
          _tag: "Refused",
          service: "web",
          reason: expect.stringContaining("an automatic start does not run it again"),
        });
        expect(harness.timeline.filter((entry) => entry.startsWith("setup:"))).toHaveLength(
          ranOnce,
        );
        expect(harness.timeline.filter((entry) => entry === "pnpm dev")).toHaveLength(1);
      }),
    ));

  it("starts a committed recipe nobody ever started, with no Start", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        const { outcome } = yield* harness.prepare(1);
        expect(outcome).toEqual({
          _tag: "Started",
          service: "web",
          previewId: harness.previewId(),
          note: null,
        });
        expect(harness.timeline).toEqual([
          "setup:pnpm install --frozen-lockfile",
          "postgres",
          "pnpm dev",
        ]);
      }),
    ));

  it("runs the recipe as the turn changed it", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("mend.toml", EDITED);
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1);

        expect(outcome).toMatchObject({ _tag: "Started", service: "web", note: null });
        expect(commandsAfter(harness.timeline, before)).toEqual(["postgres", "pnpm dev --edited"]);
      }),
    ));

  it("runs the recipe a steerer's turn changed, as the steerer", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* startedOnceThenAgentStopped(harness);
        harness.write("mend.toml", EDITED);
        harness.write("pnpm-lock.yaml", LOCK_B);
        harness.senderByTurn.set(1, STEERER);
        const before = harness.timeline.length;

        const { outcome } = yield* harness.prepare(1);

        expect(outcome).toMatchObject({ _tag: "Started", service: "web", note: null });
        expect(commandsAfter(harness.timeline, before)).toEqual([
          "setup:pnpm install --frozen-lockfile",
          "postgres",
          "pnpm dev --edited",
        ]);
        expect(harness.world.setupRuns.at(-1)).toMatchObject({ state: "done", runsAs: STEERER });
      }),
    ));

  it("a project without [preview] starts nothing", () =>
    withPreview((harness) =>
      Effect.gen(function* () {
        yield* harness.engine.runServiceRecipe(harness.sessionId, "web", ownerStart);
        yield* harness.engine.stopServices(harness.sessionId, agentStop);
        harness.write("mend.toml", RECIPES.replace('[preview]\nservice = "web"\n', ""));
        const before = harness.timeline.length;
        const { outcome } = yield* harness.prepare(1);
        expect(outcome).toEqual({ _tag: "NoPreview" });
        expect(commandsAfter(harness.timeline, before)).toEqual([]);
      }),
    ));
});
