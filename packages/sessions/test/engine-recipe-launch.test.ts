import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PersonSessionOptions } from "@mend/sealant";
import {
  ForwardAdapter,
  type ForwardDialRecord,
  type ForwardReady,
  type ForwardTarget,
  PreviewUrls,
  ServiceHost,
  type ServiceStartInput,
  SessionEngine,
  serviceProcessEnv,
} from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, SessionOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { provisionIn } from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  makeWorld,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import { resourcePreviewFixture } from "./engine/resource-preview-fixture.ts";

const ownerStart = { kind: "person", userId: "user-fixture" } as const;

const worktreeOf = (tmp: string, worktree: string) =>
  path.join(tmp, "store", "fixture", "worktrees", worktree);

const writeMendToml = (tmp: string, worktree: string, toml: string) =>
  fs.writeFileSync(path.join(worktreeOf(tmp, worktree), "mend.toml"), toml);

const readyRecord = (target: ForwardTarget): ForwardReady => ({
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

const refusedRecord = (target: ForwardTarget) => ({
  ...readyRecord(target),
  kind: "failed" as const,
  issue: { reason: "connection-refused" as const, message: "nothing listens" },
});

const httpForwards = (options: {
  readonly requests: Array<string>;
  readonly answers?: () => boolean;
  readonly refuses?: ReadonlySet<number>;
}): Layer.Layer<ForwardAdapter> =>
  Layer.succeed(ForwardAdapter, {
    probe: (target) =>
      Effect.succeed(
        options.refuses?.has(target.port) === true ? refusedRecord(target) : readyRecord(target),
      ),
    open: (target) =>
      Effect.sync(() => {
        let sent = false;
        return {
          record: readyRecord(target),
          bytes: {
            write: (bytes: Uint8Array) =>
              Effect.sync(() => void options.requests.push(new TextDecoder().decode(bytes))),
            read: () =>
              Effect.sync(() => {
                if (sent || options.answers?.() !== true) return { kind: "eof" as const };
                sent = true;
                return {
                  kind: "bytes" as const,
                  bytes: new TextEncoder().encode("HTTP/1.1 403 Forbidden\r\n\r\n"),
                };
              }),
            finish: () => Effect.void,
            close: () => Effect.void,
          },
        };
      }),
  });

const previewUrlsAt = (urls: Readonly<Record<string, string>>, asked: Array<string> = []) =>
  Layer.succeed(PreviewUrls, {
    of: (_worktreeId, serviceName) =>
      Effect.sync(() => {
        asked.push(serviceName);
        return urls[serviceName] ?? null;
      }),
  });

const WEB_AND_DB = `
[service.web]
command = "pnpm dev"
port = 3000
browserScheme = "http"
cwd = "apps/web"
env = { NODE_ENV = "development" }
depends = ["db"]

[service.db]
command = "docker compose up db"
port = 5432
env = { POSTGRES_PASSWORD = "local" }

[preview]
service = "web"
`;

describe("a recipe's launch", () => {
  it("runs in its cwd with its env, PORT and MEND_PREVIEW_URL, after its dependency", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const asked: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(tmp, session.worktree, WEB_AND_DB);
          const before = opened.length;

          const web = yield* engine.runServiceRecipe(session.id, "web", ownerStart);

          expect(web.service.name).toBe("web");
          expect(spawned.slice(-2)).toEqual([
            ["sh", "-c", "docker compose up db"],
            ["sh", "-c", "pnpm dev"],
          ]);
          expect(opened.slice(before)).toEqual([
            {
              env: {
                POSTGRES_PASSWORD: "local",
                PORT: "5432",
                MEND_PREVIEW_URL: "http://web-label.localhost:3200",
              },
            },
            {
              cwd: "/workspace/repo/apps/web",
              env: {
                NODE_ENV: "development",
                PORT: "3000",
                MEND_PREVIEW_URL: "http://web-label.localhost:3200",
                MEND_SERVICE_DB_HOST: "127.0.0.1",
                MEND_SERVICE_DB_PORT: "5432",
              },
            },
          ]);
          // db is no browser Service: it gets the file's [preview] Service's URL.
          expect(asked).toEqual(["web", "web"]);
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
        ),
        previewUrls: previewUrlsAt({ web: "http://web-label.localhost:3200" }, asked),
      },
    );
  });

  it("opens a Service with mapped resource env and holds a person's stop on a restart", async () => {
    const resources = resourcePreviewFixture();
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\ndepends = [{ shared = "db", env = { TEST_DATABASE_URL = "url" } }]',
          );
          const web = yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          expect(opened.at(-1)?.env).toMatchObject({
            MEND_DB_URL: "postgres://postgres@db:5432/app",
            TEST_DATABASE_URL: "postgres://postgres@db:5432/app",
            PORT: "3000",
          });
          expect(resources.control.starts).toBe(1);
          resources.control.state = {
            kind: "stopped",
            at: new Date(),
            reason: { kind: "person", by: "Maria" },
          };
          const before = opened.length;
          const refused = yield* Effect.result(engine.restartService(web.service.id, ownerStart));
          expect(refused._tag).toBe("Failure");
          if (refused._tag === "Failure")
            expect(refused.failure).toMatchObject({
              message: "@db stopped by Maria",
              resourceStopped: { name: "db", by: "Maria" },
            });
          expect(opened).toHaveLength(before);
        }),
      {
        resourceRuntime: resources.layer,
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          [],
          undefined,
          undefined,
          undefined,
          opened,
        ),
      },
    );
  });

  it("leaves MEND_PREVIEW_URL unset, not empty, when no preview has an address", async () => {
    const created: CreateOptions[] = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(tmp, session.worktree, WEB_AND_DB);
          const before = opened.length;
          yield* engine.runServiceRecipe(session.id, "db", ownerStart);
          const env = opened.slice(before)[0]?.env ?? {};
          expect(env).toEqual({ POSTGRES_PASSWORD: "local", PORT: "5432" });
          expect("MEND_PREVIEW_URL" in env).toBe(false);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          opened,
        ),
      },
    );
  });

  it("restarts from the attempt's launch, not from a mend.toml changed since", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            '[service.api]\ncommand = "node api.js"\nport = 4000\ncwd = "apps/api"\nenv = { MODE = "first" }\n',
          );
          const api = yield* engine.runServiceRecipe(session.id, "api", ownerStart);
          writeMendToml(
            tmp,
            session.worktree,
            '[service.api]\ncommand = "node other.js"\nport = 4000\ncwd = "apps/other"\nenv = { MODE = "second" }\n',
          );
          const before = opened.length;

          yield* engine.restartService(api.service.id, ownerStart);

          expect(spawned.at(-1)).toEqual(["sh", "-c", "node api.js"]);
          expect(opened.slice(before)).toEqual([
            { cwd: "/workspace/repo/apps/api", env: { MODE: "first", PORT: "4000" } },
          ]);
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
        ),
      },
    );
  });

  it("says why a refused recipe does not run", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\nenv = { MEND_TOKEN = "x" }\n[service.api]\ncommand = "x"\nport = 4000\n',
          );
          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);
          expect(error.message).toBe(
            "mend.toml refuses web: web · env.MEND_TOKEN · MEND_* names are Mend's",
          );
          const declared = yield* engine.serviceDeclarations(session.id);
          expect(declared.recipes.map((recipe) => recipe.name)).toEqual(["api"]);
          expect(yield* engine.listServiceRecipes(session.id)).toHaveLength(1);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });

  it("names the file's resource table notices when no recipe matches, in what the in-workspace helper prints", async () => {
    const created: CreateOptions[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          const served = servedSocketApis.get(session.id);
          if (served === undefined) throw new Error("the session serves no channel");
          // The channel answers a failed route with its message; the helper prints "mend: " + it.
          const helperPrints = (name: string) =>
            Effect.promise(() =>
              Effect.runPromise(served.runServiceRecipe(name)).then(
                () => "mend: (started)",
                (error: unknown) =>
                  `mend: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          const recipes = '[service.web]\ncommand = "pnpm dev"\nport = 3000\n';
          writeMendToml(tmp, session.worktree, recipes);
          expect(yield* helperPrints("absent")).toBe(
            'mend: No Service recipe named "absent" exists in this session.',
          );

          writeMendToml(
            tmp,
            session.worktree,
            recipes +
              '[service.api]\ncommand = "x"\nport = 4000\ncwd = "/srv"\n' +
              '[resource.bad]\nimage = "alpine:3.22"\nports = { http = 70000 }\n',
          );
          const missing = (yield* helperPrints("absent")).split("\n");
          expect(missing.slice(0, 2)).toEqual([
            'mend: No Service recipe named "absent" exists in this session.',
            "Resources in .mend/mend.toml (start explicitly with mend resource start <name> --project or --worktree):",
          ]);
          expect(missing.filter((line) => line.includes("resource.bad.ports.http"))).toEqual([
            expect.stringMatching(/^ {2}resource\.bad\.ports\.http · /),
          ]);

          const refused = (yield* helperPrints("api")).split("\n");
          expect(refused.slice(0, 2)).toEqual([
            "mend: mend.toml refuses api: api · cwd · is absolute; name a path inside the repository",
            "Resources in .mend/mend.toml (start explicitly with mend resource start <name> --project or --worktree):",
          ]);
        }),
      { sealantLayer: sealantLaunchLayer(created) },
    );
  });
});

describe("depends", () => {
  it("reuses a dependency live in the session", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(tmp, session.worktree, WEB_AND_DB);
          const db = yield* engine.runServiceRecipe(session.id, "db", ownerStart);
          const before = spawned.length;

          yield* engine.runServiceRecipe(session.id, "web", ownerStart);

          expect(spawned.slice(before)).toEqual([["sh", "-c", "pnpm dev"]]);
          const services = [...world.services.values()].filter(
            (service) => service.sessionId === session.id,
          );
          expect(services.map((service) => service.name).toSorted()).toEqual(["db", "web"]);
          expect(world.services.get(db.service.id)?.currentAttemptId).toBe(
            db.service.currentAttemptId,
          );
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
    );
  });

  it("stops at a dependency that never answers, naming it, and leaves the earlier one running", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["cache", "db"]

[service.cache]
command = "redis-server"
port = 6379

[service.db]
command = "postgres"
port = 5432
ready = { timeout = "1s" }
`,
          );
          const before = spawned.length;

          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);

          expect(error.message).toMatch(/^db did not start, so web was not started · /);
          expect(spawned.slice(before)).toEqual([
            ["sh", "-c", "redis-server"],
            ["sh", "-c", "postgres"],
          ]);
          const byName = new Map(
            [...world.services.values()]
              .filter((service) => service.sessionId === session.id)
              .map((service) => [service.name, service]),
          );
          expect(byName.has("web")).toBe(false);
          const cacheAttempt = world.processes.get(byName.get("cache")?.currentAttemptId ?? "");
          expect(cacheAttempt?.exitedAt).toBeNull();
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        forwardAdapterLayer: httpForwards({ requests: [], refuses: new Set([5432]) }),
      },
    );
  });
});

const DB_FIRST = (db: string) => `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["db"]

[service.api]
command = "node api.js"
port = 4000
depends = ["db"]

${db}
`;

const servicesOf = (
  world: { services: Map<string, { sessionId: string; name: string }> },
  sessionId: string,
) =>
  new Map(
    [...world.services.values()]
      .filter((service) => service.sessionId === sessionId)
      .map((service) => [service.name, service]),
  );

describe("a dependency already running", () => {
  it("is not reused until it answers: a retry after it never did stops again", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432\nready = { timeout = "1s" }'),
          );
          const first = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);
          expect(first.message).toMatch(/^db did not start, so web was not started · /);

          const again = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);

          expect(again.message).toMatch(/^db did not start, so web was not started · /);
          expect(spawned.filter((argv) => argv.includes("pnpm dev"))).toEqual([]);
          expect(spawned.filter((argv) => argv.includes("postgres"))).toHaveLength(1);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        forwardAdapterLayer: httpForwards({ requests: [], refuses: new Set([5432]) }),
      },
    );
  });

  it("is reused once it answers on the retry, without a second process", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const refuses = new Set([5432]);
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432\nready = { timeout = "1s" }'),
          );
          yield* engine.runServiceRecipe(session.id, "web", ownerStart).pipe(Effect.flip);
          refuses.delete(5432);

          const web = yield* engine.runServiceRecipe(session.id, "web", ownerStart);

          expect(web.service.name).toBe("web");
          expect(spawned.filter((argv) => argv.includes("postgres"))).toHaveLength(1);
          expect(spawned.filter((argv) => argv.includes("pnpm dev"))).toHaveLength(1);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        forwardAdapterLayer: httpForwards({ requests: [], refuses }),
      },
    );
  });

  it("an adopt-only one with a bound forward is looked at again, not taken as up", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\nport = 5432\naddress = "docker"\nready = { timeout = "1s" }'),
          );
          yield* engine.runServiceRecipe(session.id, "db", ownerStart);

          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);

          expect(error.message).toMatch(/^db did not start, so web was not started · /);
          expect(spawned.filter((argv) => argv.includes("pnpm dev"))).toEqual([]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
        forwardAdapterLayer: httpForwards({ requests: [], refuses: new Set([5432]) }),
      },
    );
  });

  it("starts none of a Service's dependencies when the Service itself already runs", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432'),
          );
          yield* engine.runService(session.id, ["pnpm", "dev"], 3000, "web");
          const before = spawned.length;

          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);

          expect(error.message).toMatch(/^A live Service named "web" already exists/);
          expect(spawned.slice(before)).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
    );
  });

  it.effect("two plans sharing it both wait for it to answer, and it starts once", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const refuses = new Set([5432]);
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (_world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            writeMendToml(
              tmp,
              session.worktree,
              DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432'),
            );
            const web = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.forkChild);
            yield* clock.untilChanged(
              () => spawned.some((argv) => argv.includes("postgres")),
              "db's process",
            );
            const api = yield* engine
              .runServiceRecipe(session.id, "api", ownerStart)
              .pipe(Effect.forkChild);
            yield* TestClock.adjust(5_000);
            expect(
              spawned.filter((argv) => argv.includes("node api.js") || argv.includes("pnpm dev")),
              "nothing starts while db has not answered",
            ).toEqual([]);

            refuses.delete(5432);
            yield* TestClock.adjust(1_000);
            yield* Fiber.join(web);
            yield* Fiber.join(api);
            expect(spawned.filter((argv) => argv.includes("postgres"))).toHaveLength(1);
            expect(spawned.filter((argv) => argv.includes("node api.js"))).toHaveLength(1);
            expect(spawned.filter((argv) => argv.includes("pnpm dev"))).toHaveLength(1);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          forwardAdapterLayer: httpForwards({ requests: [], refuses }),
        },
      );
    }),
  );
});

/** Holds every open once armed, until released: `opening` once the first gets there. */
const heldOpens = () => {
  const knobs = { armed: false, fails: false, opens: 0 };
  const opening = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  return {
    knobs,
    opening,
    release,
    captureOps: {
      aroundOpen: () =>
        Effect.suspend(() => {
          if (!knobs.armed) return Effect.void;
          knobs.opens += 1;
          return Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(release)));
        }),
      openFails: () => knobs.fails,
    },
  };
};

const heldLaunchLayer = (
  created: CreateOptions[],
  spawned: ReadonlyArray<string>[],
  held: ReturnType<typeof heldOpens>,
) =>
  sealantLaunchLayer(
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
    held.captureOps,
  );

describe("a dependency being launched", () => {
  it("is joined by a plan that finds it opening, which waits instead of failing", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const held = heldOpens();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432'),
          );
          held.knobs.armed = true;
          const web = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.forkChild);
          yield* Deferred.await(held.opening);
          const api = yield* engine
            .runServiceRecipe(session.id, "api", ownerStart)
            .pipe(Effect.forkChild);
          yield* Effect.sleep("300 millis");
          expect(api.pollUnsafe(), "api waits while db opens").toBeUndefined();

          yield* Deferred.succeed(held.release, undefined);
          expect((yield* Fiber.join(web)).service.name).toBe("web");
          expect((yield* Fiber.join(api)).service.name).toBe("api");
          expect(spawned.filter((argv) => argv.includes("postgres"))).toHaveLength(1);
        }),
      {
        sealantLayer: heldLaunchLayer(created, spawned, held),
        forwardAdapterLayer: httpForwards({ requests: [] }),
      },
    );
  });

  it("is joined by a plan while a start of its own opens it", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const held = heldOpens();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432'),
          );
          held.knobs.armed = true;
          const db = yield* engine
            .runServiceRecipe(session.id, "db", ownerStart)
            .pipe(Effect.forkChild);
          yield* Deferred.await(held.opening);
          const web = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.forkChild);
          yield* Effect.sleep("300 millis");
          expect(web.pollUnsafe(), "web waits while db opens").toBeUndefined();

          yield* Deferred.succeed(held.release, undefined);
          expect((yield* Fiber.join(db)).service.name).toBe("db");
          expect((yield* Fiber.join(web)).service.name).toBe("web");
          expect(spawned.filter((argv) => argv.includes("postgres"))).toHaveLength(1);
        }),
      {
        sealantLayer: heldLaunchLayer(created, spawned, held),
        forwardAdapterLayer: httpForwards({ requests: [] }),
      },
    );
  });

  it("is started once by two plans that both began before it existed", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const held = heldOpens();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432'),
          );
          held.knobs.armed = true;
          const web = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.forkChild);
          const api = yield* engine
            .runServiceRecipe(session.id, "api", ownerStart)
            .pipe(Effect.forkChild);
          yield* Deferred.await(held.opening);
          yield* Effect.sleep("300 millis");

          yield* Deferred.succeed(held.release, undefined);
          expect((yield* Fiber.join(web)).service.name).toBe("web");
          expect((yield* Fiber.join(api)).service.name).toBe("api");
          expect(spawned.filter((argv) => argv.includes("postgres"))).toHaveLength(1);
        }),
      {
        sealantLayer: heldLaunchLayer(created, spawned, held),
        forwardAdapterLayer: httpForwards({ requests: [] }),
      },
    );
  });

  it("stops every plan that joined it, naming it, when its open fails", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    const held = heldOpens();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            DB_FIRST('[service.db]\ncommand = "postgres"\nport = 5432'),
          );
          held.knobs.armed = true;
          const web = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(held.opening);
          const api = yield* engine
            .runServiceRecipe(session.id, "api", ownerStart)
            .pipe(Effect.flip, Effect.forkChild);
          yield* Effect.sleep("300 millis");
          expect(api.pollUnsafe(), "api waits while db opens").toBeUndefined();

          held.knobs.fails = true;
          yield* Deferred.succeed(held.release, undefined);
          expect((yield* Fiber.join(web)).message).toBe(
            "db did not start, so web was not started · the platform did not open the session",
          );
          expect((yield* Fiber.join(api)).message).toBe(
            "db did not start, so api was not started · the platform did not open the session",
          );
          expect(held.knobs.opens, "db was opened once").toBe(1);
        }),
      {
        sealantLayer: heldLaunchLayer(created, spawned, held),
        forwardAdapterLayer: httpForwards({ requests: [] }),
      },
    );
  });
});

describe("an adopt-only dependency", () => {
  it.effect("is waited for within its ready timeout, not looked at once", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const refuses = new Set([5432]);
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (_world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            writeMendToml(
              tmp,
              session.worktree,
              DB_FIRST(
                '[service.db]\nport = 5432\naddress = "docker"\nready = { timeout = "30s" }',
              ),
            );
            const web = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.forkChild);
            yield* TestClock.adjust(10_000);
            expect(web.pollUnsafe(), "still waiting for compose at 10 s").toBeUndefined();
            refuses.delete(5432);
            yield* TestClock.adjust(1_000);
            const view = yield* Fiber.join(web);
            expect(view.service.name).toBe("web");
            expect(spawned.filter((argv) => argv.includes("pnpm dev"))).toHaveLength(1);
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          forwardAdapterLayer: httpForwards({ requests: [], refuses }),
        },
      );
    }),
  );
});

describe("a recipe start's plan", () => {
  it.effect("goes on to the end when its request is cut while it waits on a dependency", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const refuses = new Set([5432]);
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            writeMendToml(
              tmp,
              session.worktree,
              DB_FIRST(
                '[service.db]\ncommand = "postgres"\nport = 5432\nready = { timeout = "5m" }',
              ),
            );
            const request = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.forkChild);
            yield* clock.untilChanged(
              () => spawned.some((argv) => argv.includes("postgres")),
              "db's process",
            );
            yield* TestClock.adjust(2_000);
            yield* Fiber.interrupt(request);

            refuses.delete(5432);
            yield* TestClock.adjust(1_000);
            yield* clock.untilChanged(
              () => spawned.some((argv) => argv.includes("pnpm dev")),
              "web's process, with no request waiting",
            );
            yield* TestClock.adjust(1_000);
            yield* clock.untilChanged(() => {
              const web = servicesOf(world, session.id).get("web");
              const attempt =
                web === undefined
                  ? undefined
                  : world.processes.get(
                      String((web as { currentAttemptId?: string }).currentAttemptId),
                    );
              return attempt?.status === "running";
            }, "web running");
            const web = [...world.services.values()].find(
              (service) => service.sessionId === session.id && service.name === "web",
            );
            expect(web?.currentForwardId).not.toBeNull();
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          forwardAdapterLayer: httpForwards({ requests: [], refuses }),
        },
      );
    }),
  );

  it.effect(
    "answers its request after a minute with where it stands, and its progress follows it to the end",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeEngineClock(["processes", "sessions"]);
        const spawned = clock.watched<ReadonlyArray<string>>();
        const refuses = new Set([5432]);
        const startId = "4a1f7e0e-8a5e-4d5b-9b0e-0d6f0b3c6a11";
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              writeMendToml(
                tmp,
                session.worktree,
                DB_FIRST(
                  '[service.db]\ncommand = "postgres"\nport = 5432\nready = { timeout = "10m" }',
                ),
              );
              const request = yield* engine
                .runServiceRecipe(session.id, "web", ownerStart, startId)
                .pipe(Effect.flip, Effect.forkChild);
              yield* clock.untilChanged(
                () => spawned.some((argv) => argv.includes("postgres")),
                "db's process",
              );
              yield* TestClock.adjust(61_000);
              const held = yield* Fiber.join(request);
              expect(held._tag).toBe("ServiceStartUnderWayError");
              expect(held.message).toBe(
                "web waits on db, which has not answered yet · the start goes on · mend service list",
              );
              const waiting = yield* engine.serviceStartProgress(session.id, startId);
              expect(waiting).toMatchObject({
                service: "web",
                state: "running",
                steps: [
                  { name: "db", state: "starting" },
                  { name: "web", state: "waiting" },
                ],
              });

              yield* TestClock.adjust(240_000);
              refuses.delete(5432);
              yield* TestClock.adjust(1_000);
              yield* clock.untilChanged(
                () => spawned.some((argv) => argv.includes("pnpm dev")),
                "web's process",
              );
              yield* TestClock.adjust(1_000);
              const progress = yield* engine.serviceStartProgress(session.id, startId);
              expect(progress).toMatchObject({
                state: "started",
                steps: [
                  { name: "db", state: "ready" },
                  { name: "web", state: "ready" },
                ],
              });
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
            forwardAdapterLayer: httpForwards({ requests: [], refuses }),
          },
        );
      }),
  );

  it.effect("ends at a person's Stop of its dependency: nothing after it starts", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions"]);
      const spawned = clock.watched<ReadonlyArray<string>>();
      const startId = "0b8d3a52-6f4e-4f7a-bd8e-6f2b1c0a9e77";
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            writeMendToml(
              tmp,
              session.worktree,
              DB_FIRST(
                '[service.db]\ncommand = "postgres"\nport = 5432\nready = { timeout = "5m" }',
              ),
            );
            const request = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart, startId)
              .pipe(Effect.flip, Effect.forkChild);
            yield* clock.untilChanged(
              () => spawned.some((argv) => argv.includes("postgres")),
              "db's process",
            );
            yield* TestClock.adjust(2_000);
            const db = [...world.services.values()].find(
              (service) => service.sessionId === session.id && service.name === "db",
            );
            if (db === undefined) throw new Error("db has no Service row");

            yield* engine.stopService(db.id, ownerStart);
            yield* TestClock.adjust(1_000);
            const error = yield* Fiber.join(request);

            expect(error.message).toBe("a Stop came before web started");
            expect(spawned.filter((argv) => argv.includes("pnpm dev"))).toEqual([]);
            expect(yield* engine.serviceStartProgress(session.id, startId)).toMatchObject({
              state: "stopped",
              message: "a Stop came before web started",
            });
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          forwardAdapterLayer: httpForwards({ requests: [], refuses: new Set([5432]) }),
        },
      );
    }),
  );
});

describe("an HTTP ready rule", () => {
  it.effect(
    "keeps a start waiting while the port accepts and HTTP answers nothing, until its timeout",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeEngineClock(["processes", "sessions"]);
        const requests = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              writeMendToml(
                tmp,
                session.worktree,
                '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\nready = { http = "/health", timeout = "5s" }\n',
              );
              const start = yield* engine
                .runServiceRecipe(session.id, "web", ownerStart)
                .pipe(Effect.forkChild);
              yield* clock.untilChanged(() => requests.length >= 1, "the first HTTP request");
              expect(requests[0]).toMatch(/^GET \/health HTTP\/1\.1\r\nHost: localhost:3000\r\n/);

              yield* TestClock.adjust(4_000);
              expect(start.pollUnsafe(), "still waiting at 4 s").toBeUndefined();
              yield* TestClock.adjust(1_500);
              const view = yield* Fiber.join(start);

              expect(requests.length).toBeGreaterThan(5);
              expect(view.latestObservation).toMatchObject({
                state: "unreachable",
                error: "no HTTP answer to GET /health",
              });
              const attempt = world.processes.get(view.service.currentAttemptId ?? "");
              expect(attempt?.status).toBe("running");
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created),
            forwardAdapterLayer: httpForwards({ requests }),
          },
        );
      }),
  );

  it.effect("counts any status line as answered", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions"]);
      const requests = clock.watched<string>();
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (_world, tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            writeMendToml(
              tmp,
              session.worktree,
              '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\nready = { http = "/", timeout = "2m" }\n',
            );
            const start = yield* engine
              .runServiceRecipe(session.id, "web", ownerStart)
              .pipe(Effect.forkChild);
            yield* clock.untilChanged(() => requests.length >= 1, "the first HTTP request");
            yield* TestClock.adjust(1_000);
            expect(start.pollUnsafe(), "a 403 answers the fourth request").toBeUndefined();
            yield* TestClock.adjust(500);
            const view = yield* Fiber.join(start);
            expect(view.latestObservation).toMatchObject({ state: "reachable", error: null });
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(created),
          forwardAdapterLayer: httpForwards({ requests, answers: () => requests.length >= 4 }),
        },
      );
    }),
  );

  it.effect(
    "waits outside the lifecycle permit: another session's Stop goes through meanwhile",
    () =>
      Effect.gen(function* () {
        const created: CreateOptions[] = [];
        const clock = yield* makeEngineClock(["processes", "sessions"]);
        const requests = clock.watched<string>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const other = yield* provisionIn(project);
              yield* engine.launch(other.session.id, ["codex"]);
              const running = yield* engine.runService(
                other.session.id,
                ["pnpm", "api"],
                4000,
                "api",
              );

              const { session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              writeMendToml(
                tmp,
                session.worktree,
                '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\nready = { http = "/", timeout = "2m" }\n',
              );
              const start = yield* engine
                .runServiceRecipe(session.id, "web", ownerStart)
                .pipe(Effect.forkChild);
              yield* clock.untilChanged(() => requests.length >= 1, "the first HTTP request");

              const stopped = yield* engine
                .stopService(running.service.id, ownerStart)
                .pipe(Effect.timeoutOption("1 second"), TestClock.withLive);
              expect(stopped._tag, "the Stop did not wait on the 2 min ready").toBe("Some");
              expect(start.pollUnsafe()).toBeUndefined();
              yield* Fiber.interrupt(start);
            }),
          {
            prepareWorld: clock.prepareWorld,
            sealantLayer: sealantLaunchLayer(created),
            forwardAdapterLayer: httpForwards({ requests }),
          },
        );
      }),
  );
});

describe("the host listener of an HTTP-ready Service", () => {
  it("probes with the attempt's HTTP rule, not a bare TCP accept", async () => {
    const created: CreateOptions[] = [];
    const started: Array<ServiceStartInput> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\nready = { http = "/health", timeout = "1s" }\n',
          );
          yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          expect(started.map((input) => input.ready)).toEqual([
            { _tag: "Http", path: "/health", host: "localhost:3000", tls: false },
          ]);
        }),
      {
        sealantLayer: sealantLaunchLayer(created),
        forwardAdapterLayer: httpForwards({ requests: [], answers: () => true }),
        serviceHostLayer: Layer.succeed(ServiceHost, {
          bindAddresses: () => Effect.succeed(["127.0.0.1"]),
          start: (input) =>
            Effect.sync(() => {
              started.push(input);
              return { hostPort: 43127, boundAddresses: ["127.0.0.1"] };
            }),
          hold: () => Effect.void,
          sever: () => Effect.void,
          stop: () => Effect.void,
        }),
      },
    );
  });
});

describe("an HTTP-ready attempt after a restart", () => {
  it("is not counted ready because its port accepts: boot checks its own rule", async () => {
    const world = makeWorld();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-recipe-boot-"));
    const created: CreateOptions[] = [];
    const platform = sealantLaunchLayer(created);
    const accepting = httpForwards({ requests: [] });
    try {
      const attemptId = await Effect.runPromise(
        withPreparedEngineEffect(
          (w, dir) => setup(dir, w),
          (_world, dir, project) =>
            Effect.gen(function* () {
              const { engine, session } = yield* provisionIn(project);
              yield* engine.launch(session.id, ["codex"]);
              writeMendToml(
                dir,
                session.worktree,
                '[service.web]\ncommand = "pnpm dev"\nport = 3000\nbrowserScheme = "http"\nready = { http = "/health", timeout = "1s" }\n',
              );
              const view = yield* engine.runServiceRecipe(session.id, "web", ownerStart);
              expect(view.latestObservation?.state).toBe("unreachable");
              return view.service.currentAttemptId;
            }),
          { fixture: { world, tmp }, sealantLayer: platform, forwardAdapterLayer: accepting },
        ),
      );
      if (attemptId === null) throw new Error("the start recorded no attempt");
      const observedBefore = world.serviceObservations.size;

      await Effect.runPromise(
        withPreparedEngineEffect(
          () => Effect.void,
          () =>
            Effect.gen(function* () {
              for (let tries = 0; world.serviceObservations.size === observedBefore; tries += 1) {
                if (tries > 400) throw new Error("boot recorded no observation");
                yield* Effect.sleep("5 millis");
              }
            }),
          { fixture: { world, tmp }, sealantLayer: platform, forwardAdapterLayer: accepting },
        ),
      );

      expect(world.reachedAttempts.has(attemptId)).toBe(false);
      const latest = [...world.serviceObservations.values()].at(-1);
      expect(latest).toMatchObject({
        state: "unreachable",
        error: "no HTTP answer to GET /health",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("an attempt that ends while its start waits", () => {
  it.effect("is never given a forward once its exit is being recorded", () =>
    Effect.gen(function* () {
      const created: CreateOptions[] = [];
      const clock = yield* makeEngineClock(["processes", "sessions"]);
      const { ptyStates } = clock;
      const probes = clock.watched<number>();
      const answer = yield* Deferred.make<void>();
      const exitWriting = yield* Deferred.make<void>();
      const exitWritten = yield* Deferred.make<void>();
      let held: string | null = null;
      const forwards: Layer.Layer<ForwardAdapter> = Layer.succeed(ForwardAdapter, {
        probe: (target) =>
          Effect.suspend((): Effect.Effect<ForwardDialRecord> => {
            probes.push(probes.length);
            return probes.length === 1
              ? Effect.succeed(refusedRecord(target))
              : Effect.as(Deferred.await(answer), readyRecord(target));
          }),
        open: () => Effect.die("no HTTP rule here"),
      });
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const { engine, session } = yield* provisionIn(project);
            yield* engine.launch(session.id, ["codex"]);
            const start = yield* engine
              .runService(session.id, ["pnpm", "dev"], 3000, "web")
              .pipe(Effect.forkChild);
            yield* clock.untilChanged(() => probes.length >= 1, "the wait's first probe");
            yield* TestClock.adjust(500);
            yield* clock.untilChanged(() => probes.length >= 2, "the wait's second probe");
            const attempt = [...world.processes.values()].find(
              (process) => process.kind === "service",
            );
            if (attempt?.sealantSessionId == null) throw new Error("no Service attempt recorded");
            held = attempt.id;
            ptyStates.set(attempt.sealantSessionId, {
              status: "exited",
              exitCode: 1,
              outputHighWater: 0n,
            });
            yield* TestClock.adjust(1_500);
            yield* Deferred.await(exitWriting);

            yield* Deferred.succeed(answer, undefined);
            // Live time for the start's second half to run, or to queue behind the exit.
            yield* Effect.sleep("50 millis").pipe(TestClock.withLive);
            yield* Deferred.succeed(exitWritten, undefined);
            const view = yield* Fiber.join(start);

            expect(world.processes.get(attempt.id)?.exitedAt).not.toBeNull();
            expect(view.currentForward).toBeNull();
            expect(world.services.get(view.service.id)?.currentForwardId).toBeNull();
          }),
        {
          prepareWorld: clock.prepareWorld,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            ptyStates,
          ),
          forwardAdapterLayer: forwards,
          wrapProcesses: (inner) => ({
            ...inner,
            markExited: (id, outcome, exitCode) =>
              id === held
                ? Deferred.succeed(exitWriting, undefined).pipe(
                    Effect.andThen(Deferred.await(exitWritten)),
                    Effect.andThen(inner.markExited(id, outcome, exitCode)),
                  )
                : inner.markExited(id, outcome, exitCode),
          }),
        },
      );
    }),
  );
});

describe("serviceProcessEnv", () => {
  it("layers the resources, the recipe, Mend's names, then the person's, each over the last", () => {
    expect(
      serviceProcessEnv({
        resources: { DATABASE_URL: "shared", A: "shared" },
        recipe: { A: "recipe", B: "recipe", HOME: "/recipe" },
        port: 3000,
        previewUrl: "https://x.example",
        dependencies: [
          { name: "db", host: "127.0.0.1", port: 5432 },
          { name: "search.v2", host: "docker", port: 9200 },
        ],
        person: { HOME: "/home/maria", MEND_SESSION_ID: "s1" },
      }),
    ).toEqual({
      DATABASE_URL: "shared",
      A: "recipe",
      B: "recipe",
      HOME: "/home/maria",
      PORT: "3000",
      MEND_PREVIEW_URL: "https://x.example",
      MEND_SERVICE_DB_HOST: "127.0.0.1",
      MEND_SERVICE_DB_PORT: "5432",
      MEND_SERVICE_SEARCH_V2_HOST: "docker",
      MEND_SERVICE_SEARCH_V2_PORT: "9200",
      MEND_SESSION_ID: "s1",
    });
  });
});

/** Every probe answers; the ports in `docker` only on the Docker sidecar. */
const routedForwards = (docker: ReadonlySet<number>): Layer.Layer<ForwardAdapter> =>
  Layer.succeed(ForwardAdapter, {
    probe: (target) =>
      Effect.succeed(
        docker.has(target.port)
          ? { ...readyRecord(target), arrival: { route: "docker", proof: { kind: "port" } } }
          : readyRecord(target),
      ),
    open: () => Effect.die("no HTTP rule in these recipes"),
  });

const WEB_DB_CACHE = `
[service.web]
command = "pnpm dev"
port = 3000
depends = ["db", "cache"]

[service.db]
command = "postgres"
port = 5432

[service.cache]
command = "docker compose up cache"
port = 6379
address = "docker"
`;

describe("a dependency's address in a Service's env", () => {
  it("is each dependency's host and port as it is reached, recomputed at a restart, never recorded", async () => {
    const created: CreateOptions[] = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const docker = new Set<number>();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(tmp, session.worktree, WEB_DB_CACHE);
          const before = opened.length;

          const web = yield* engine.runServiceRecipe(session.id, "web", ownerStart);

          expect(opened.slice(before).map((options) => options.env)).toEqual([
            { PORT: "5432" },
            { PORT: "6379" },
            {
              PORT: "3000",
              MEND_SERVICE_DB_HOST: "127.0.0.1",
              MEND_SERVICE_DB_PORT: "5432",
              MEND_SERVICE_CACHE_HOST: "127.0.0.1",
              MEND_SERVICE_CACHE_PORT: "6379",
            },
          ]);
          const attempt = web.service.currentAttemptId;
          expect(attempt === null ? undefined : world.launches.get(attempt)?.env).toEqual({});

          // Docker now publishes cache on its sidecar only.
          docker.add(6379);
          yield* engine.restartService(web.service.id, ownerStart);
          expect(opened.at(-1)?.env).toEqual({
            PORT: "3000",
            MEND_SERVICE_DB_HOST: "127.0.0.1",
            MEND_SERVICE_DB_PORT: "5432",
            MEND_SERVICE_CACHE_HOST: "docker",
            MEND_SERVICE_CACHE_PORT: "6379",
          });
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          opened,
        ),
        forwardAdapterLayer: routedForwards(docker),
      },
    );
  });

  it("a restart binds the dependencies its attempt was started with, whatever mend.toml says now", async () => {
    const created: CreateOptions[] = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(tmp, session.worktree, WEB_DB_CACHE);
          const web = yield* engine.runServiceRecipe(session.id, "web", ownerStart);
          const attempt = web.service.currentAttemptId;
          expect(attempt === null ? undefined : world.launches.get(attempt)?.depends).toEqual([
            "db",
            "cache",
          ]);

          writeMendToml(
            tmp,
            session.worktree,
            WEB_DB_CACHE.replace('depends = ["db", "cache"]', 'depends = ["cache"]'),
          );
          yield* engine.restartService(web.service.id, ownerStart);
          writeMendToml(tmp, session.worktree, "[service.web\n");
          yield* engine.restartService(web.service.id, ownerStart);

          const bound = {
            PORT: "3000",
            MEND_SERVICE_DB_HOST: "127.0.0.1",
            MEND_SERVICE_DB_PORT: "5432",
            MEND_SERVICE_CACHE_HOST: "127.0.0.1",
            MEND_SERVICE_CACHE_PORT: "6379",
          };
          expect(opened.slice(-2).map((options) => options.env)).toEqual([bound, bound]);
        }),
      {
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          opened,
        ),
        forwardAdapterLayer: routedForwards(new Set()),
      },
    );
  });

  it("refuses a recipe two of whose dependencies would set the same names", async () => {
    const created: CreateOptions[] = [];
    const spawned: ReadonlyArray<string>[] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const { engine, session } = yield* provisionIn(project);
          yield* engine.launch(session.id, ["codex"]);
          writeMendToml(
            tmp,
            session.worktree,
            [
              "[service.web]",
              'command = "pnpm dev"',
              "port = 3000",
              'depends = ["db-1", "db_1"]',
              "[service.db-1]",
              'command = "postgres"',
              "port = 5432",
              "[service.db_1]",
              'command = "postgres"',
              "port = 5433",
            ].join("\n"),
          );
          const before = spawned.length;

          const error = yield* engine
            .runServiceRecipe(session.id, "web", ownerStart)
            .pipe(Effect.flip);

          expect(error.message).toBe(
            "mend.toml refuses web: web · depends · names db-1 and db_1, which both set MEND_SERVICE_DB_1_HOST",
          );
          expect(spawned.slice(before)).toEqual([]);
        }),
      { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
    );
  });
});
