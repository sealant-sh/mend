import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionId } from "@mend/domain";
import { Expected, NoLiveAgent, SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { lifecycleLayer } from "./engine/capture-fixture.ts";
import { setup, withEngine, type World } from "./engine/fixture.ts";

interface Knobs {
  /** While true, the agent's PTY does not open: the launch settles the session `failed`. */
  openFails: boolean;
  /** Runs as the platform opens the agent's PTY: a test holds a launch there. */
  aroundOpen: () => Effect.Effect<void>;
}

/** What the platform was asked, and the knobs a test turns. */
const platform = () => {
  const created: CreateOptions[] = [];
  const stopped: string[] = [];
  const spawned: ReadonlyArray<string>[] = [];
  const knobs: Knobs = { openFails: false, aroundOpen: () => Effect.void };
  return {
    created,
    stopped,
    spawned,
    knobs,
    layer: lifecycleLayer(created, {
      events: stopped,
      spawned,
      execCalls: [],
      captureOps: {
        openFails: () => knobs.openFails,
        aroundOpen: () => knobs.aroundOpen(),
      },
    }),
  };
};

const provisioned = (tmp: string, world: World) =>
  Effect.gen(function* () {
    const project = yield* setup(tmp, world);
    const session = yield* (yield* SessionEngine).provision({
      projectId: project.id,
      harness: "codex",
      label: null,
      name: null,
      ownerUserId: "user-fixture",
      start: { kind: "base", base: null },
    });
    /**
     * The session's harness state, as a settle harvests it: these worlds run no harness, and a
     * relaunch of a session that ran continues from it.
     */
    const harvested = () => {
      const stateDir = sessionStatePathOf(project.storePath, session.id);
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "");
      fs.writeFileSync(
        path.join(stateDir, "manifest.json"),
        JSON.stringify({
          harness: "codex",
          providerSessionId: "codex-thread-1",
          capturedAt: "2026-10-19T08:00:00.000Z",
        }),
      );
    };
    return { session, harvested };
  });

const liveAgents = (world: World, sessionId: SessionId) =>
  [...world.processes.values()].filter(
    (process) =>
      process.sessionId === sessionId && process.kind === "agent-pty" && process.exitedAt === null,
  );

/** Holds every launch as its agent opens, until released; `asked` once the first gets there. */
const holdOpens = (seen: ReturnType<typeof platform>) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    seen.knobs.aroundOpen = () =>
      Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(release)));
    return { asked, release };
  });

/** What a refused launch must never run. */
const neverAdmitted = Effect.die("a refused launch ran what it does once admitted");

/** Everything a launch could tear down or rewrite, to compare before and after a refusal. */
const footprint = (world: World, sessionId: SessionId, seen: ReturnType<typeof platform>) => {
  const row = world.sessions.get(sessionId);
  return {
    stops: [...seen.stopped],
    creates: seen.created.length,
    opens: seen.spawned.length,
    workspace: row?.sealantWorkspaceId ?? null,
    status: row?.status ?? null,
    settledAt: row?.settledAt ?? null,
    model: row?.model ?? null,
    effort: row?.effort ?? null,
    agents: liveAgents(world, sessionId).map((process) => `${process.id} ${process.status}`),
  };
};

describe("SessionEngine launch admission (SLNT-167)", () => {
  it("launches over the failed attempt its caller saw, and runs what its caller does once admitted", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session } = yield* provisioned(tmp, world);
          seen.knobs.openFails = true;
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          seen.knobs.openFails = false;
          const failed = world.sessions.get(session.id);
          expect(failed?.status).toBe("failed");
          const settledAt = failed?.settledAt ?? null;
          expect(settledAt).not.toBeNull();

          const admitted: Array<string> = [];
          yield* engine.launch(session.id, ["codex"], {
            over: Expected(settledAt),
            onAdmitted: Effect.sync(() => {
              admitted.push(`${seen.created.length} created`);
            }),
          });

          expect(world.sessions.get(session.id)?.status).toBe("running");
          expect(liveAgents(world, session.id)).toHaveLength(1);
          expect(admitted).toEqual([`${seen.created.length - 1} created`]);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("refuses the attempt it saw once another client's resume has brought the agent up, and tears nothing down", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          seen.knobs.openFails = true;
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          seen.knobs.openFails = false;
          const stale = world.sessions.get(session.id)?.settledAt ?? null;
          harvested();
          yield* engine.resumeSession(session.id, null);
          expect(liveAgents(world, session.id)).toHaveLength(1);
          const before = footprint(world, session.id, seen);

          const refused = yield* engine
            .launch(session.id, ["codex"], { over: Expected(stale), onAdmitted: neverAdmitted })
            .pipe(Effect.flip);

          expect(refused._tag).toBe("SessionMovedOnError");
          expect(refused.message).toBe(
            "the session moved on · it reads running · nothing launched",
          );
          expect(footprint(world, session.id, seen)).toEqual(before);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("admits the attempt it saw again after a retry that failed before its agent started", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session } = yield* provisioned(tmp, world);
          seen.knobs.openFails = true;
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          const seenAt = world.sessions.get(session.id)?.settledAt ?? null;
          yield* Effect.sleep("5 millis");
          yield* engine.launch(session.id, ["codex"], { over: Expected(seenAt) }).pipe(Effect.exit);
          // As Postgres keeps it: the first settle wins, and no agent ran in between.
          expect(world.sessions.get(session.id)?.settledAt?.getTime()).toBe(seenAt?.getTime());
          seen.knobs.openFails = false;

          yield* engine.launch(session.id, ["codex"], { over: Expected(seenAt) });

          expect(world.sessions.get(session.id)?.status).toBe("running");
          expect(liveAgents(world, session.id)).toHaveLength(1);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("refuses the attempt it saw once an agent ran and the session settled again", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          seen.knobs.openFails = true;
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          seen.knobs.openFails = false;
          const stale = world.sessions.get(session.id)?.settledAt ?? null;
          harvested();
          yield* Effect.sleep("5 millis");
          yield* engine.resumeSession(session.id, null);
          yield* engine.stop(session.id);
          const settledAgain = world.sessions.get(session.id)?.settledAt ?? null;
          expect(settledAgain).not.toBeNull();
          expect(settledAgain?.getTime()).not.toBe(stale?.getTime());
          // The stop's tail still runs: what this launch would have done is create and open.
          const before = { creates: seen.created.length, opens: seen.spawned.length };

          const refused = yield* engine
            .launch(session.id, ["codex"], { over: Expected(stale) })
            .pipe(Effect.flip);

          expect(refused).toMatchObject({
            _tag: "SessionMovedOnError",
            status: world.sessions.get(session.id)?.status,
            settledAt: settledAgain,
          });
          expect({ creates: seen.created.length, opens: seen.spawned.length }).toEqual(before);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("launches over the open workbench shell, and still refuses over the agent it started", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          yield* engine.resumeSession(session.id, "shell");
          const [shell] = liveAgents(world, session.id);
          expect(shell?.harness).toBe("shell");
          harvested();

          yield* engine.launch(session.id, ["codex"], { over: NoLiveAgent });

          const [agent] = liveAgents(world, session.id);
          expect(liveAgents(world, session.id)).toHaveLength(1);
          expect(agent?.harness).toBe("codex");
          expect(world.processes.get(shell?.id ?? "")?.exitedAt).not.toBeNull();
          const before = footprint(world, session.id, seen);

          const refused = yield* engine
            .launch(session.id, ["codex"], { over: NoLiveAgent })
            .pipe(Effect.flip);

          expect(refused._tag).toBe("SessionAgentLiveError");
          expect(footprint(world, session.id, seen)).toEqual(before);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("refuses a never-launched attempt once another client's launch brought its agent up", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          yield* engine.launch(session.id, ["codex"], { over: Expected(null) });
          expect(world.sessions.get(session.id)?.settledAt).toBeNull();
          harvested();
          const before = footprint(world, session.id, seen);

          const refused = yield* engine
            .launch(session.id, ["codex"], { over: Expected(null) })
            .pipe(Effect.flip);

          expect(refused).toMatchObject({ _tag: "SessionMovedOnError", status: "running" });
          expect(footprint(world, session.id, seen)).toEqual(before);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("refuses the attempt it saw while another launch of it is under way, and tears nothing down", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          seen.knobs.openFails = true;
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          seen.knobs.openFails = false;
          const stale = world.sessions.get(session.id)?.settledAt ?? null;
          harvested();
          const { asked, release } = yield* holdOpens(seen);
          const resuming = yield* engine.resumeSession(session.id, null).pipe(Effect.forkChild);
          yield* Deferred.await(asked);
          expect(engine.launchUnderWay(session.id)).toBe(true);
          const before = footprint(world, session.id, seen);

          const refused = yield* engine
            .launch(session.id, ["codex"], { over: Expected(stale) })
            .pipe(Effect.flip);

          expect(refused).toMatchObject({ _tag: "SessionMovedOnError", status: "starting" });
          expect(footprint(world, session.id, seen)).toEqual(before);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(resuming);
          expect(liveAgents(world, session.id)).toHaveLength(1);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("refuses a launch that names nothing over a live agent, and tears nothing down", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          yield* engine.launch(session.id, ["codex"]);
          expect(liveAgents(world, session.id)).toHaveLength(1);
          harvested();
          const before = footprint(world, session.id, seen);

          const refused = yield* engine
            .launch(session.id, ["codex"], { over: NoLiveAgent, onAdmitted: neverAdmitted })
            .pipe(Effect.flip);

          expect(refused._tag).toBe("SessionAgentLiveError");
          expect(refused.message).toBe(
            "the session's agent is live · nothing restarted · attach to it, or stop it and launch again",
          );
          expect(footprint(world, session.id, seen)).toEqual(before);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("restarts a live agent when asked: the old workspace stopped, a new agent", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session, harvested } = yield* provisioned(tmp, world);
          yield* engine.launch(session.id, ["codex"]);
          const [first] = liveAgents(world, session.id);
          const workspace = world.sessions.get(session.id)?.sealantWorkspaceId ?? null;
          expect(first).toBeDefined();
          expect(seen.stopped).toEqual([]);
          harvested();

          yield* engine.launch(session.id, ["codex"]);

          expect(seen.stopped).toEqual([workspace]);
          const agents = liveAgents(world, session.id);
          expect(agents).toHaveLength(1);
          expect(agents[0]?.id).not.toBe(first?.id);
          expect(world.processes.get(first?.id ?? "")?.exitedAt).not.toBeNull();
        }),
      { sealantLayer: seen.layer },
    );
  });

  it.each([
    { label: "a failed session, naming nothing", failed: true, expected: false },
    { label: "a never-launched session, naming nothing", failed: false, expected: false },
    { label: "a never-launched session, naming it unsettled", failed: false, expected: true },
  ])("launches $label", async ({ failed, expected }) => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session } = yield* provisioned(tmp, world);
          if (failed) {
            seen.knobs.openFails = true;
            yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
            seen.knobs.openFails = false;
            expect(world.sessions.get(session.id)?.status).toBe("failed");
          }

          yield* engine.launch(session.id, ["codex"], {
            over: expected ? Expected(null) : NoLiveAgent,
          });

          expect(world.sessions.get(session.id)?.status).toBe("running");
          expect(liveAgents(world, session.id)).toHaveLength(1);
        }),
      { sealantLayer: seen.layer },
    );
  });

  it("runs exactly one of two launches over the same attempt", async () => {
    const seen = platform();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const { session } = yield* provisioned(tmp, world);
          seen.knobs.openFails = true;
          yield* engine.launch(session.id, ["codex"]).pipe(Effect.exit);
          seen.knobs.openFails = false;
          const settledAt = world.sessions.get(session.id)?.settledAt ?? null;
          const createsBefore = seen.created.length;
          const { asked, release } = yield* holdOpens(seen);

          const [first, second] = yield* Effect.all(
            [
              engine.launch(session.id, ["codex"], { over: Expected(settledAt) }).pipe(Effect.exit),
              engine.launch(session.id, ["codex"], { over: Expected(settledAt) }).pipe(Effect.exit),
              Deferred.await(asked).pipe(Effect.andThen(Deferred.succeed(release, undefined))),
            ],
            { concurrency: "unbounded" },
          );

          const outcomes = [first, second];
          expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
          const refusals = outcomes.filter(Exit.isFailure);
          expect(refusals).toHaveLength(1);
          expect(JSON.stringify(refusals[0])).toContain("SessionMovedOnError");
          expect(seen.created.length - createsBefore).toBe(1);
          expect(liveAgents(world, session.id)).toHaveLength(1);
        }),
      { sealantLayer: seen.layer },
    );
  });
});
