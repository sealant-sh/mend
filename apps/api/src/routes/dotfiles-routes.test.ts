import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { dotfilesGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import { ProjectsRepo, UserDotfilesRepo } from "@mend/db";
import type { DotfilesRepository } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { DotfilesStore, SourcePolicy } from "@mend/store";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterAll, describe, expect, it } from "vitest";

import { ProjectAccess } from "../access.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "../budgets.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { DotfilesGroupLive } from "./workbench.ts";

/**
 * Saving a dotfiles repository tries it first, through the launch's own clone and pack: a
 * repository every launch would leave out is refused with the reason, and nothing is saved.
 */

const AUTHORIZATION = "Bearer dotfiles-routes-test";
const DotfilesApi = HttpApi.make("mend").add(dotfilesGroup).prefix("/api");

const scratch: Array<string> = [];
const tmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

/** A committed repo on disk, cloned over `file://` (the stubbed policy lets it through). */
const originWith = (files: Readonly<Record<string, string>>): string => {
  const origin = tmp("mend-dotfiles-route-origin-");
  execFileSync("git", ["init", "--initial-branch", "trunk"], { cwd: origin });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(origin, name)), { recursive: true });
    fs.writeFileSync(path.join(origin, name), content);
  }
  execFileSync("git", ["add", "."], { cwd: origin });
  execFileSync("git", ["commit", "-m", "init"], {
    cwd: origin,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  return `file://${origin}`;
};

const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  issuePasswordReset: () => Effect.die("unused"),
  getSession: (headers) =>
    Effect.succeed(
      headers.get("authorization") === AUTHORIZATION
        ? Option.some({
            user: { id: "user-dotfiles", email: "dots@example.invalid", name: "Dots" },
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          })
        : Option.none(),
    ),
});

type DotfilesRouteServices =
  | Budgets
  | UserDotfilesRepo
  | DotfilesStore
  | SourcePolicy
  | ProjectAccess
  | ProjectsRepo
  | SessionEngine;

/** PUT /api/dotfiles/repository; `saved` is every repository the handler wrote. */
const putRepository = async (
  repository: Partial<DotfilesRepository> & { readonly url: string },
  budgets: Budgets["Service"] = makeBudgets(DEFAULT_BUDGET_LIMITS),
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly saved: ReadonlyArray<DotfilesRepository | null>;
}> => {
  const saved: Array<DotfilesRepository | null> = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(Budgets, budgets),
    Layer.succeed(UserDotfilesRepo, {
      repository: () => Effect.succeed(saved.at(-1) ?? null),
      setRepository: (_userId, value) =>
        Effect.sync(() => {
          saved.push(value);
          return value;
        }),
    }),
    Layer.mock(DotfilesStore, { current: () => Effect.succeed(null) }),
    // Every remote passes: what this route adds is the clone, not the address rules (tested in
    // source-policy-routes.test.ts).
    Layer.mock(SourcePolicy, {
      profile: "operator",
      check: () => Effect.succeed({ scheme: "https", host: "local", port: null, addresses: [] }),
      pinnedEnv: (_clearance, env) => ({ ...env }),
    }),
    Layer.mock(ProjectAccess, { isOperator: () => Effect.succeed(true) }),
    Layer.mock(ProjectsRepo, { listAll: () => Effect.succeed([]) }),
    Layer.mock(SessionEngine, {}),
  );
  const apiLayer = HttpApiBuilder.layer(DotfilesApi).pipe(
    Layer.provide(DotfilesGroupLive),
    Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
    Layer.provide(HttpServer.layerServices),
  );
  const runtime = ManagedRuntime.make(dependencies);
  const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
  try {
    const context = await runtime.runPromise(Effect.context<DotfilesRouteServices>());
    const response = await handler(
      new Request("http://api.internal/api/dotfiles/repository", {
        method: "PUT",
        headers: { authorization: AUTHORIZATION, "content-type": "application/json" },
        body: JSON.stringify({ repository }),
      }),
      context,
    );
    const body: unknown = await response.json();
    return { status: response.status, body, saved };
  } finally {
    await dispose();
    await runtime.dispose();
  }
};

describe("PUT /api/dotfiles/repository", () => {
  it("saves a repository the launch's clone and pack can read", async () => {
    const url = originWith({ "dots/.vimrc": "set nocompatible\n" });
    const result = await putRepository({ url, subdirectory: "dots" });
    expect(result.status).toBe(200);
    expect(result.saved).toEqual([
      { url, ref: null, subdirectory: "dots", manager: "auto", bootstrap: true },
    ]);
  });

  it("refuses a repository that cannot be cloned, with git's reason, and saves nothing", async () => {
    const url = `file://${path.join(tmp("mend-dotfiles-route-missing-"), "nothing-here")}`;
    const result = await putRepository({ url });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      _tag: "SettingsFailure",
      message: expect.stringMatching(/^dotfiles clone of file:\/\/\S+nothing-here failed: /),
    });
    expect(result.saved).toEqual([]);
  });

  it("refuses a subdirectory the repository does not have, and saves nothing", async () => {
    const url = originWith({ ".vimrc": "set nocompatible\n" });
    const result = await putRepository({ url, subdirectory: "dots" });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      message: `the dotfiles repo ${url} has no directory dots at its default branch.`,
    });
    expect(result.saved).toEqual([]);
  });

  it("refuses a branch the repository does not have, and saves nothing", async () => {
    const url = originWith({ ".vimrc": "set nocompatible\n" });
    const result = await putRepository({ url, ref: "no-such-branch" });
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      message: expect.stringMatching(/no-such-branch/),
    });
    expect(result.saved).toEqual([]);
  });

  it("holds one of the account's launch slots while it clones, and refuses past the budget", async () => {
    const url = originWith({ ".vimrc": "set nocompatible\n" });
    const budgets = makeBudgets({ ...DEFAULT_BUDGET_LIMITS, accountLaunchesInFlight: 1 });
    // The account's one slot is taken by a launch still starting.
    const release = await Effect.runPromise(Deferred.make<void>());
    const holding = Effect.runFork(
      budgets.withLaunchSlot("user-dotfiles", Deferred.await(release)),
    );
    await Effect.runPromise(Effect.yieldNow);
    const refused = await putRepository({ url }, budgets);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountLaunchesInFlight",
      limit: 1,
    });
    expect(refused.saved).toEqual([]);

    // Once that launch settles, the slot is free again and the save clones and saves.
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(holding));
    const saved = await putRepository({ url }, budgets);
    expect(saved.status).toBe(200);
    expect(saved.saved).toHaveLength(1);
  });
});
