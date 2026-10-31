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

const steerer = { kind: "person", userId: "maria" } as const;
const agentStart = { kind: "workspace", runsAs: null } as const;
const automaticStart = { kind: "system", runsAs: null } as const;
const agentStop = { kind: "workspace" } as const;

const RECIPE = `
[service.web]
command = "pnpm dev"
port = 3000
cwd = "apps/web"
env = { MODE = "first" }
depends = ["db"]

[service.db]
command = "postgres"
port = 5432
`;
const EDITED = RECIPE.replace('command = "pnpm dev"', 'command = "pnpm dev --edited"').replace(
  'MODE = "first"',
  'MODE = "edited"',
);

const digestsOf = (toml: string) =>
  recipeDigestsOf(resolveDeclarations(Effect.runSync(parseMendToml(toml, "mend.toml")), []));

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

describe("a recipe runs whoever added or changed it (ADR 0017, decision log 4, reversed)", () => {
  it("an automatic start, and a steerer's, run the file as it reads now", () =>
    withRecipes(({ engine, sessionId, write, spawned, opened }) =>
      Effect.gen(function* () {
        write(RECIPE);
        yield* engine.runServiceRecipe(sessionId, "web", automaticStart);
        expect(spawned.slice(-2)).toEqual([
          ["sh", "-c", "postgres"],
          ["sh", "-c", "pnpm dev"],
        ]);
        yield* engine.stopServices(sessionId, agentStop);
        write(EDITED);
        const before = opened.length;
        yield* engine.runServiceRecipe(sessionId, "web", steerer);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev --edited"]);
        expect(opened.slice(before).at(-1)).toMatchObject({
          cwd: "/workspace/repo/apps/web",
          env: { MODE: "edited", PORT: "3000" },
        });
      }),
    ));

  it("a steerer's restart replays the attempt the agent started from an edited file", () =>
    withRecipes(({ engine, sessionId, write, spawned }) =>
      Effect.gen(function* () {
        write(EDITED);
        const started = yield* engine.runServiceRecipe(sessionId, "web", agentStart);
        yield* engine.restartService(started.service.id, steerer);
        expect(spawned.at(-1)).toEqual(["sh", "-c", "pnpm dev --edited"]);
      }),
    ));

  it("lists each runnable recipe's digest", () =>
    withRecipes(({ engine, sessionId, write }) =>
      Effect.gen(function* () {
        write(RECIPE);
        const digests = digestsOf(RECIPE);
        expect((yield* engine.serviceDeclarations(sessionId)).digests).toEqual([
          { name: "web", digest: digests.get("web") },
          { name: "db", digest: digests.get("db") },
        ]);
      }),
    ));
});
