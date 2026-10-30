import * as fs from "node:fs";
import * as path from "node:path";

import type { WorktreeId } from "@mend/domain";
import type { PersonSessionOptions } from "@mend/sealant";
import { parseMendToml, recipeDigestsOf, resolveDeclarations, SessionEngine } from "@mend/sessions";
import type { CreateOptions, SessionOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { provisionIn } from "./engine/capture-fixture.ts";
import { sealantLaunchLayer, setup, withEngine, type World } from "./engine/fixture.ts";

const OWNER = "user-fixture";
const ownerStart = { kind: "person", userId: OWNER } as const;
const steererRestart = { kind: "person", userId: "maria" } as const;
const agentStart = { kind: "workspace", runsAs: null } as const;
const automaticStart = { kind: "system", runsAs: null } as const;
const agentStop = { kind: "workspace" } as const;

const APPROVED = `
[service.web]
command = "pnpm dev"
port = 3000
cwd = "apps/web"
env = { MODE = "approved" }
depends = ["db"]

[service.db]
command = "postgres"
port = 5432
`;
const EDITED = APPROVED.replace('command = "pnpm dev"', 'command = "pnpm dev --edited"').replace(
  'MODE = "approved"',
  'MODE = "edited"',
);
const CHAIN = `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["db"]

[service.db]
command = "postgres"
port = 5432
depends = ["cache"]

[service.cache]
command = "redis-server"
port = 6379
`;
const ADOPTS_DB = `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["db"]

[service.db]
port = 5432
`;

const digestsOf = (toml: string) =>
  recipeDigestsOf(resolveDeclarations(Effect.runSync(parseMendToml(toml, "mend.toml")), []));

const approvalsIn = (world: World) =>
  Object.fromEntries(
    [...world.recipeApprovals.values()].flatMap((byApprover) =>
      [...byApprover.values()]
        .flatMap((byName) => [...byName.values()])
        .map((approval) => [
          approval.serviceName,
          { digest: approval.digest, approvedBy: approval.approvedBy, argv: approval.spec.argv },
        ]),
    ),
  );

const withRecipes = (
  run: (input: {
    readonly engine: SessionEngine["Service"];
    readonly world: World;
    readonly sessionId: Parameters<SessionEngine["Service"]["runServiceRecipe"]>[0];
    readonly worktreeId: WorktreeId;
    readonly write: (toml: string) => void;
    readonly spawned: ReadonlyArray<ReadonlyArray<string>>;
    readonly opened: ReadonlyArray<SessionOptions | PersonSessionOptions>;
    readonly setupSteps: ReadonlyArray<string>;
  }) => Effect.Effect<void, unknown, SessionEngine>,
) => {
  const created: CreateOptions[] = [];
  const spawned: ReadonlyArray<string>[] = [];
  const opened: Array<SessionOptions | PersonSessionOptions> = [];
  const setupSteps: string[] = [];
  return withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const { engine, session } = yield* provisionIn(project);
        yield* engine.launch(session.id, ["codex"]);
        const file = path.join(tmp, "store", "fixture", "worktrees", session.worktree, "mend.toml");
        fs.writeFileSync(
          path.join(path.dirname(file), "pnpm-lock.yaml"),
          "lockfileVersion: '9.0'\n",
        );
        yield* run({
          engine,
          world,
          sessionId: session.id,
          worktreeId: session.worktreeId,
          write: (toml) => fs.writeFileSync(file, toml),
          spawned,
          opened,
          setupSteps,
        });
      }),
    {
      sealantLayer: sealantLaunchLayer(
        created,
        undefined,
        undefined,
        spawned,
        undefined,
        undefined,
        undefined,
        opened,
        undefined,
        undefined,
        undefined,
        {
          execEffect: (argv) => {
            const at = argv.indexOf("mend-setup");
            const step = at === -1 ? undefined : argv[at + 1];
            if (step === undefined) return undefined;
            return Effect.sync(() => {
              setupSteps.push(step);
              return { exitCode: 0, stdout: "", stderr: "" };
            });
          },
        },
      ),
    },
  );
};

describe("who approves a recipe, and what runs without the owner (ADR 0017, decision log 4)", () => {
  it("the owner's Start approves each recipe of its plan, and approves a changed digest again", () =>
    withRecipes(({ engine, world, sessionId, write }) =>
      Effect.gen(function* () {
        write(APPROVED);
        const before = yield* engine.serviceDeclarations(sessionId);
        expect(before.digests.map(({ name, state }) => ({ name, state }))).toEqual([
          { name: "web", state: "unapproved" },
          { name: "db", state: "unapproved" },
        ]);

        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        const approved = digestsOf(APPROVED);
        expect(approvalsIn(world)).toEqual({
          web: {
            digest: approved.get("web"),
            approvedBy: OWNER,
            argv: ["sh", "-c", "pnpm dev"],
          },
          db: { digest: approved.get("db"), approvedBy: OWNER, argv: ["sh", "-c", "postgres"] },
        });

        write(EDITED);
        const changed = yield* engine.serviceDeclarations(sessionId);
        expect(changed.digests).toEqual([
          expect.objectContaining({
            name: "web",
            digest: digestsOf(EDITED).get("web"),
            state: "changed",
            approvedBy: OWNER,
          }),
          expect.objectContaining({ name: "db", state: "approved" }),
        ]);

        yield* engine.stopServices(sessionId, agentStop);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        expect(approvalsIn(world)["web"]).toEqual({
          digest: digestsOf(EDITED).get("web"),
          approvedBy: OWNER,
          argv: ["sh", "-c", "pnpm dev --edited"],
        });
      }),
    ));

  it("the agent's own start runs the file and approves nothing", () =>
    withRecipes(({ engine, world, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        expect(spawned.slice(-2)).toEqual([
          ["sh", "-c", "postgres"],
          ["sh", "-c", "pnpm dev"],
        ]);
        expect(approvalsIn(world)).toEqual({});
      }),
    ));

  it("an automatic start refuses a recipe never approved, with words, and starts nothing", () =>
    withRecipes(({ engine, world, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        const before = spawned.length;
        const refused = yield* engine
          .runServiceRecipe(sessionId, "web", automaticStart)
          .pipe(Effect.flip);
        expect(refused.message).toBe("web · recipe not approved · the owner's Start runs it");
        expect(spawned.length).toBe(before);
        expect(approvalsIn(world)).toEqual({});
      }),
    ));

  it("an automatic start runs the approved version after a turn changed the file, and the file's once it matches", () =>
    withRecipes(({ engine, world, sessionId, write, spawned, opened }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(EDITED);

        const before = opened.length;
        const view = yield* engine.runServiceRecipe(sessionId, "web", automaticStart);
        expect(view.approvedVersion).toBe(true);
        expect(spawned.slice(-2)).toEqual([
          ["sh", "-c", "postgres"],
          ["sh", "-c", "pnpm dev"],
        ]);
        expect(opened.slice(before).at(-1)).toMatchObject({
          cwd: "/workspace/repo/apps/web",
          env: { MODE: "approved", PORT: "3000" },
        });
        expect(approvalsIn(world)["web"]?.argv).toEqual(["sh", "-c", "pnpm dev"]);

        yield* engine.stopServices(sessionId, agentStop);
        write(APPROVED);
        const matching = yield* engine.runServiceRecipe(sessionId, "web", automaticStart);
        expect(matching.approvedVersion).toBe(false);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev"]);
      }),
    ));

  it("a steerer's restart runs the approved version, never the attempt a turn started from an edited file, which the owner's replays", () =>
    withRecipes(({ engine, world, sessionId, write, spawned, opened }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(EDITED);
        const edited = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev --edited"]);
        const replayed = yield* engine.restartService(edited.service.id, ownerStart);
        expect(replayed.approvedVersion).toBe(false);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev --edited"]);

        const before = opened.length;
        const restarted = yield* engine.restartService(edited.service.id, steererRestart);
        expect(restarted.approvedVersion).toBe(true);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev"]);
        expect(opened.slice(before)).toEqual([
          expect.objectContaining({ env: expect.objectContaining({ MODE: "approved" }) }),
        ]);
        expect(approvalsIn(world)["web"]?.argv).toEqual(["sh", "-c", "pnpm dev"]);
      }),
    ));

  it("a steerer's restart of a recipe never approved refuses, with words", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        const started = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        const before = spawned.length;
        const refused = yield* engine
          .restartService(started.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe("web · recipe not approved · the owner's Start runs it");
        expect(spawned.length).toBe(before);
      }),
    ));

  it("a start by anyone but the owner approves nothing and runs only an approved digest", () =>
    withRecipes(({ engine, world, sessionId, write }) =>
      Effect.gen(function* () {
        write(APPROVED);
        const refused = yield* engine
          .runServiceRecipe(sessionId, "web", steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe("web · recipe not approved · the owner's Start runs it");
        expect(approvalsIn(world)).toEqual({});
      }),
    ));

  it("a recipe a turn left without its command, and with an edited [setup], runs its approved version and approved setup", () =>
    withRecipes(({ engine, sessionId, write, spawned, setupSteps }) =>
      Effect.gen(function* () {
        const withSetup = `[setup]\nrun = ["pnpm install"]\ninputs = ["pnpm-lock.yaml"]\n${APPROVED}`;
        write(withSetup);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        expect(setupSteps).toEqual(["pnpm install"]);
        yield* engine.stopServices(sessionId, agentStop);
        write(
          withSetup
            .replace('command = "pnpm dev"\n', "")
            .replace('run = ["pnpm install"]', 'run = ["curl unapproved | sh"]'),
        );

        const view = yield* engine.runServiceRecipe(sessionId, "web", automaticStart);
        expect(setupSteps).not.toContain("curl unapproved | sh");
        expect(view.approvedVersion).toBe(true);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev"]);
      }),
    ));

  it("a steerer's restart of a recipe attempt on a Service an explicit command made first runs only an approved recipe", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runService(sessionId, ["node", "server.js"], 3000, "web");
        yield* engine.stopServices(sessionId, agentStop);
        const recipe = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev"]);
        const before = spawned.length;

        const refused = yield* engine
          .restartService(recipe.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe("web · recipe not approved · the owner's Start runs it");
        expect(spawned.length).toBe(before);
      }),
    ));

  it("a steerer's restart of an explicit command on a Service a recipe made first replays the command, not the recipe's approval", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        const explicit = yield* engine.runService(sessionId, ["node", "server.js"], 3000, "web");

        const restarted = yield* engine.restartService(explicit.service.id, steererRestart);
        expect(restarted.service.id).toBe(explicit.service.id);
        expect(spawned.at(-1)).toEqual(["node", "server.js"]);
        expect(restarted.approvedVersion).toBe(false);
      }),
    ));

  it("an automatic start refuses a graph nobody approved: a parent with a dependency approved apart from it", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(APPROVED.replace('command = "postgres"', 'command = "postgres -c v2"'));
        yield* engine.runServiceRecipe(sessionId, "db", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        const before = spawned.length;

        const refused = yield* engine
          .runServiceRecipe(sessionId, "web", automaticStart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "web · its approved version runs with a db the owner has approved again since · the owner's Start runs it",
        );
        expect(spawned.length).toBe(before);
      }),
    ));

  it("an automatic start refuses to use a running dependency its approval does not match, and leaves it running", () =>
    withRecipes(({ engine, world, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(APPROVED.replace('command = "postgres"', 'command = "postgres -c unapproved"'));
        const db = yield* engine.runServiceRecipe(sessionId, "db", agentStart);
        const before = spawned.length;

        const refused = yield* engine
          .runServiceRecipe(sessionId, "web", automaticStart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "db did not start, so web was not started · the running db is not the version its approval names, and is left running",
        );
        expect(spawned.length).toBe(before);
        const live = [...world.processes.values()].filter(
          (row) => row.serviceId === db.service.id && row.exitedAt === null,
        );
        expect(live.map((row) => row.argv)).toEqual([["sh", "-c", "postgres -c unapproved"]]);
      }),
    ));

  it("an approval is its approver's: another owner's Start in the same worktree never runs for this session", () =>
    withRecipes(({ engine, sessionId, worktreeId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        const maria = yield* engine.provisionSessionIn(worktreeId, {
          harness: "codex",
          label: null,
          ownerUserId: "maria",
        });
        yield* engine.launch(maria.id, ["codex"]);
        yield* engine.runServiceRecipe(maria.id, "web", { kind: "person", userId: "maria" });
        yield* engine.stopServices(maria.id, agentStop);
        const before = spawned.length;

        const refused = yield* engine
          .runServiceRecipe(sessionId, "web", automaticStart)
          .pipe(Effect.flip);
        expect(refused.message).toBe("web · recipe not approved · the owner's Start runs it");
        expect(spawned.length).toBe(before);
      }),
    ));

  it("a steerer's restart refuses beside a running dependency its approval does not match", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(APPROVED.replace('command = "postgres"', 'command = "postgres -c unapproved"'));
        const web = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        const before = spawned.length;

        const refused = yield* engine
          .restartService(web.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "web was not restarted · the running db is not the version its approval names, and is left running",
        );
        expect(spawned.length).toBe(before);
      }),
    ));

  it("a steerer's restart of an attempt with no record of what launched it refuses, with words", () =>
    withRecipes(({ engine, world, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        const web = yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        const attemptId = web.attempts.at(-1)?.id;
        const launch = attemptId === undefined ? undefined : world.launches.get(attemptId);
        if (attemptId === undefined || launch === undefined) throw new Error("web is not running");
        world.launches.set(attemptId, { ...launch, source: "unrecorded" });
        const before = spawned.length;

        const refused = yield* engine
          .restartService(web.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "web · started before Mend recorded what launched it · the owner's restart runs it",
        );
        expect(spawned.length).toBe(before);
      }),
    ));

  it("an automatic start runs the approved graph when a turn's edit to depends left the file's refused", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(APPROVED);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(APPROVED.replace('depends = ["db"]', 'depends = ["db", "missing"]'));

        const view = yield* engine.runServiceRecipe(sessionId, "web", automaticStart);
        expect(view.approvedVersion).toBe(true);
        expect(spawned.slice(-2)).toEqual([
          ["sh", "-c", "postgres"],
          ["sh", "-c", "pnpm dev"],
        ]);
      }),
    ));

  it("a steerer's restart refuses beside a running dependency of a dependency its approval does not match, and leaves it running", () =>
    withRecipes(({ engine, world, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(CHAIN);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(CHAIN.replace('command = "redis-server"', 'command = "redis-server --unapproved"'));
        const web = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        const before = spawned.length;

        const refused = yield* engine
          .restartService(web.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "web was not restarted · the running cache is not the version its approval names, and is left running",
        );
        expect(spawned.length).toBe(before);
        const live = [...world.processes.values()].filter((row) => row.exitedAt === null);
        expect(live.map((row) => row.argv)).toEqual(
          expect.arrayContaining([
            ["sh", "-c", "redis-server --unapproved"],
            ["sh", "-c", "pnpm dev"],
          ]),
        );
      }),
    ));

  it("a steerer's restart runs beside a whole graph at its approved launches", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(CHAIN);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        const web = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        const before = spawned.length;

        yield* engine.restartService(web.service.id, steererRestart);
        expect(spawned.slice(before)).toEqual([["sh", "-c", "pnpm dev"]]);
      }),
    ));

  it("a steerer's restart refuses beside a dependency approved as adopted that a turn gave a command", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(ADOPTS_DB);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        write(ADOPTS_DB.replace("port = 5432", 'command = "postgres -c unapproved"\nport = 5432'));
        const web = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        expect(spawned.slice(-2)).toEqual([
          ["sh", "-c", "postgres -c unapproved"],
          ["sh", "-c", "pnpm dev"],
        ]);
        const before = spawned.length;

        const refused = yield* engine
          .restartService(web.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "web · its approved version runs with a db mend.toml has changed since · the owner's Start runs it",
        );
        expect(spawned.length).toBe(before);
      }),
    ));

  it("a steerer's restart and an automatic start refuse beside a dependency approved as adopted that runs a command, and leave it running", () =>
    withRecipes(({ engine, world, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(ADOPTS_DB);
        yield* engine.runServiceRecipe(sessionId, "web", ownerStart);
        yield* engine.stopServices(sessionId, agentStop);
        const db = yield* engine.runService(
          sessionId,
          ["postgres", "-c", "unapproved"],
          5432,
          "db",
        );
        const web = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        const before = spawned.length;

        const refused = yield* engine
          .restartService(web.service.id, steererRestart)
          .pipe(Effect.flip);
        expect(refused.message).toBe(
          "web was not restarted · the running db runs a command its approved version does not, and is left running",
        );
        yield* engine.stopService(web.service.id, agentStop);
        const automatic = yield* engine
          .runServiceRecipe(sessionId, "web", automaticStart)
          .pipe(Effect.flip);
        expect(automatic.message).toBe(
          "db did not start, so web was not started · the running db runs a command its approved version does not, and is left running",
        );
        expect(spawned.length).toBe(before);
        const live = [...world.processes.values()].filter(
          (row) => row.serviceId === db.service.id && row.exitedAt === null,
        );
        expect(live.map((row) => row.argv)).toEqual([["postgres", "-c", "unapproved"]]);
      }),
    ));
});
