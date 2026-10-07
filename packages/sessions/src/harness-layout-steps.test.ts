import {
  HarnessLayoutsRepo,
  type HarnessLayoutsMemoryState,
  OrganizationsRepo,
  harnessLayoutsRepoMemory,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { OrganizationId, WorktreeId, defaultWorkspaceImage } from "@mend/domain";
import { type HomeLogins, PersonLayoutPlatform, SealantPlatformError } from "@mend/sealant";
import { claudeCode, type Run, type Workspace } from "@sealant/sdk";
import { Duration, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { loginRefusal, makeHarnessLayoutSteps } from "./harness-layout-steps.ts";

/**
 * The per-person steps' own memory (docs/adr/0016): the layout each launch runs, as the session
 * channel reads it on every request, and what prepare's report makes of a person who could not
 * be given their identity.
 */

const never = () => new Promise<never>(() => {});
const notInTest = async (): Promise<never> => {
  throw new Error("not in test");
};
/** What an exec's result names as its run: nothing here reads it. */
const execRun: Run = {
  id: "run-exec",
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes: { files: [], diff: async () => "" },
  artifacts: { list: async () => [], get: async () => new Uint8Array() },
  record: {
    runId: "run-exec",
    replay: notInTest,
    commands: async () => [],
    transcript: async () => "",
    stream: async function* () {},
    timeline: async function* () {},
    scrollback: async function* () {},
    loss: notInTest,
    summary: notInTest,
    fileTreeAt: notInTest,
    processTreeAt: notInTest,
  },
  wait: async function () {
    return this;
  },
};
const workspace: Workspace = {
  id: "workspace-1",
  name: "fake",
  status: async () => "ready",
  runtimeDeadline: async () => null,
  runtime: async () => null,
  launch: undefined,
  recover: never,
  captureDrain: async () => null,
  ready: async function () {
    return this;
  },
  harness: { run: never, start: never, session: never },
  exec: never,
  bind: async () => [],
  capture: { flush: never, status: never, replan: never },
  sessions: { open: never, get: never, list: async () => [] },
  events: async function* () {},
  forward: never,
  stop: async () => ({ state: "stopped" }),
  restart: async function () {
    return this;
  },
  expire: async () => undefined,
  image: async () => null,
  credentials: { put: never, release: never, list: async () => [] },
};

/** Every credentials call the platform was asked for, and how Core answers a POST. */
interface CoreCalls {
  readonly calls: Array<string>;
  readonly posts: Array<{
    readonly onBehalfOf: string;
    readonly home: string;
    readonly owner: { readonly uid: number; readonly gid: number } | undefined;
    readonly logins: HomeLogins;
  }>;
  /** Core's answer to the nth POST (0-based): a failure, or nothing for a write. */
  answer: (index: number, logins: HomeLogins) => SealantPlatformError | null;
  homes: ReadonlyArray<{
    home: string;
    onBehalfOf: string;
    providers: ReadonlyArray<"claude" | "codex" | "github">;
  }>;
}

const coreCalls = (): CoreCalls => ({ calls: [], posts: [], answer: () => null, homes: [] });

const platformOf = (core: CoreCalls) =>
  Layer.succeed(PersonLayoutPlatform, {
    processUser: true,
    withOwnerMap: null,
    imageReport: () =>
      Effect.succeed({ digest: "sha256:img", runtime: "docker", person: true, missing: [] }),
    postCredentials: (_workspace, input) =>
      Effect.suspend(() => {
        const index = core.posts.length;
        core.posts.push({
          onBehalfOf: input.onBehalfOf,
          home: input.home,
          owner: input.owner,
          logins: input.logins,
        });
        core.calls.push(`post:${input.onBehalfOf}:${input.home}`);
        const failure = core.answer(index, input.logins);
        return failure === null ? Effect.void : Effect.fail(failure);
      }),
    deleteCredentials: (_workspace, input) =>
      Effect.sync(() => {
        core.calls.push(`delete:${input.home}`);
      }),
    listCredentials: () =>
      Effect.sync(() => {
        core.calls.push("list");
        return core.homes;
      }),
    applyDotfiles: () => Effect.void,
  });

const platformLayer = platformOf(coreCalls());

const organizationsLayer = Layer.mock(OrganizationsRepo, { members: () => Effect.succeed([]) });

/** The steps over the in-memory repo, counting every launch layout read from the store. */
const stepsWith = (
  flag: "person" | "shared",
  state: HarnessLayoutsMemoryState,
  options: {
    readonly platform?: Layer.Layer<PersonLayoutPlatform>;
    readonly execs?: Array<string>;
    readonly revoked?: Array<string>;
    readonly forks?: Array<Effect.Effect<void>>;
    readonly grace?: Duration.Duration;
  } = {},
) =>
  Effect.gen(function* () {
    const repo = yield* HarnessLayoutsRepo;
    const reads: Array<string> = [];
    // As the engine does at startup: one query.
    const anyRecorded = yield* repo.anyRecorded();
    const steps = makeHarnessLayoutSteps({
      flag,
      repo: {
        ...repo,
        launchLayout: (launchId) =>
          Effect.sync(() => reads.push(launchId)).pipe(Effect.andThen(repo.launchLayout(launchId))),
        worktreeLayout: (worktreeId) =>
          Effect.sync(() => reads.push(`worktree:${worktreeId}`)).pipe(
            Effect.andThen(repo.worktreeLayout(worktreeId)),
          ),
      },
      anyRecorded,
      platform: yield* PersonLayoutPlatform,
      organizations: yield* OrganizationsRepo,
      sealant: {
        exec: (_workspace, argv) => {
          const execs = options.execs;
          return execs === undefined
            ? Effect.die("not in test")
            : Effect.sync(() => {
                execs.push(argv[2] ?? "");
                return { exitCode: 0, stdout: "", stderr: "", run: execRun };
              });
        },
      },
      harnessHome: "/workspace/harness-home",
      fork: (effect) => Effect.sync(() => options.forks?.push(effect)),
      identityTicket: () => Effect.succeed("t".repeat(43)),
      discardTicket: () => {},
      revokePersonToken: (launchId, accountId) =>
        Effect.sync(() => options.revoked?.push(`${launchId}:${accountId}`)),
      ...(options.grace === undefined ? {} : { loginReleaseGrace: options.grace }),
    });
    return { steps, reads, repo };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        harnessLayoutsRepoMemory(state),
        options.platform ?? platformLayer,
        organizationsLayer,
      ),
    ),
  );

const decideInput = (launchId: string) => ({
  worktreeId: WorktreeId.make("wt-1"),
  sessionId: "sess-1",
  launchId,
  ownerUserId: "user-alice",
  organizationId: OrganizationId.make("org-1"),
  image: Effect.succeed(defaultWorkspaceImage),
  harness: claudeCode(),
  headHasPeople: Effect.succeed(false),
});

const settleInput = (launchId: string, stdout: string) => ({
  launchId,
  worktreeId: WorktreeId.make("wt-1"),
  workspace,
  stdout,
  fallback: { credentials: { claude: true, github: true }, dotfiles: [] },
});

describe("the layout each launch runs, as the channel reads it (docs/adr/0016)", () => {
  it("stays person through prepare and after, even when the cache flushes mid-prepare", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { steps } = yield* stepsWith("person", makeHarnessLayoutsMemoryState());
        const layout = yield* steps.decide(decideInput("launch-person"));
        // Every launch's first channel request looks its layout up: 2,048 of them, then the
        // identity pickup of this launch's prepare, which asks inside prepare's own exec.
        for (let i = 0; i < 2_048; i++) yield* steps.layoutOfLaunch(`launch-${i}`);
        const duringPrepare = yield* steps.layoutOfLaunch("launch-person");
        const settled = yield* steps.settlePrepare({
          layout,
          ...settleInput(
            "launch-person",
            "mend-layout probed\nmend-layout made mxlcv7ihf\nmend-layout ready\n",
          ),
        });
        for (let i = 2_048; i < 4_096; i++) yield* steps.layoutOfLaunch(`launch-${i}`);
        return {
          decided: layout.layout,
          duringPrepare,
          settled: settled.layout,
          afterConfirm: yield* steps.layoutOfLaunch("launch-person"),
        };
      }),
    );
    expect(result).toEqual({
      decided: "person",
      duringPrepare: "person",
      settled: "person",
      afterConfirm: "person",
    });
  });

  it("with the flag off and nothing recorded, reads nothing, before and after a restart", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const before = yield* stepsWith("shared", state);
        yield* before.steps.decide(decideInput("launch-live"));
        yield* before.steps.mayRunPerson(WorktreeId.make("wt-1"));
        yield* before.steps.standbyMayServe(WorktreeId.make("wt-1"));
        // Mend restarts: a new process, its cache empty, the launch still live.
        const after = yield* stepsWith("shared", state);
        const layouts = [
          yield* after.steps.layoutOfLaunch("launch-live"),
          yield* after.steps.layoutOfLaunch("launch-from-before"),
        ];
        const runsPerson = yield* after.steps.mayRunPerson(WorktreeId.make("wt-1"));
        const standby = yield* after.steps.standbyMayServe(WorktreeId.make("wt-1"));
        yield* after.steps.decide(decideInput("launch-next"));
        return { layouts, runsPerson, standby, reads: [...before.reads, ...after.reads] };
      }),
    );
    expect(result).toEqual({
      layouts: ["shared", "shared"],
      runsPerson: false,
      standby: true,
      reads: [],
    });
  });

  it("with the flag off, asks nothing until Mend itself records a layout, then reads it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps, reads } = yield* stepsWith("shared", state);
        const before = {
          possible: steps.personPossible(),
          runsPerson: yield* steps.mayRunPerson(WorktreeId.make("wt-1")),
        };
        // The operator's `harnessLayout` on a start that made the worktree: the engine's own
        // write path notes it, and from then on the steps read the store.
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        steps.noteRecorded();
        const after = {
          possible: steps.personPossible(),
          runsPerson: yield* steps.mayRunPerson(WorktreeId.make("wt-1")),
        };
        return { before, after, reads };
      }),
    );
    expect(result).toEqual({
      before: { possible: false, runsPerson: false },
      after: { possible: true, runsPerson: true },
      reads: ["worktree:wt-1"],
    });
  });

  it("with the flag on, a person layout is always possible", async () => {
    const possible = await Effect.runPromise(
      Effect.gen(function* () {
        const { steps } = yield* stepsWith("person", makeHarnessLayoutsMemoryState());
        return steps.personPossible();
      }),
    );
    expect(possible).toBe(true);
  });

  it("with the flag off, a person worktree recorded before a restart is still read, and still person", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        const { steps, reads } = yield* stepsWith("shared", state);
        return { runsPerson: yield* steps.mayRunPerson(WorktreeId.make("wt-1")), reads };
      }),
    );
    expect(result).toEqual({ runsPerson: true, reads: ["worktree:wt-1"] });
  });

  it("with the flag off, the layout is known at decide: the channel never reads it from the store", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps, reads } = yield* stepsWith("shared", state);
        yield* steps.decide(decideInput("launch-shared"));
        const layouts = [];
        for (let i = 0; i < 5; i++) layouts.push(yield* steps.layoutOfLaunch("launch-shared"));
        return { layouts, reads, recorded: state.launches.size };
      }),
    );
    expect(result).toEqual({ layouts: Array(5).fill("shared"), reads: [], recorded: 0 });
  });

  it("refuses a person launch whose people could not be given their identity, with words to try again", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps } = yield* stepsWith("person", state);
        const layout = yield* steps.decide(decideInput("launch-identity"));
        const refused = yield* steps
          .settlePrepare({
            layout,
            ...settleInput(
              "launch-identity",
              "mend-layout probed\nmend-layout made mxlcv7ihf\n" +
                "mend-layout failed mxlcv7ihf identity: the pickup could not reach Mend\n",
            ),
          })
          .pipe(Effect.flip);
        return { message: refused.message, capabilities: state.capabilities.size };
      }),
    );
    expect(failure.message).toBe(
      "This workspace could not give each person their Mend identity (mxlcv7ihf: identity: the pickup could not reach Mend). Nothing was started; the next launch tries again.",
    );
    expect(failure.message).not.toContain("image");
    // Nothing is held against the image.
    expect(failure.capabilities).toBe(0);
  });
});

const notConnected = (provider: string) =>
  new SealantPlatformError({
    code: "WorkspaceNotFoundError",
    status: 404,
    message: `No ${provider} connected account matches "default".`,
    cause: null,
  });
const needsReconnect = (provider: string) =>
  new SealantPlatformError({
    code: "connected-account-invalid",
    status: 409,
    message: `Connected ${provider} account "default" is invalid — reconnect it.`,
    cause: null,
  });

describe("standbys and person launches (docs/adr/0016; sealant#333)", () => {
  it("a launch that could be person never claims a standby: its owner map is read only at boot", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const flagOn = yield* stepsWith("person", makeHarnessLayoutsMemoryState());
        const personWorktree = makeHarnessLayoutsMemoryState();
        personWorktree.worktrees.set(WorktreeId.make("wt-1"), {
          layout: "person",
          requested: null,
        });
        const recorded = yield* stepsWith("shared", personWorktree);
        const asked = makeHarnessLayoutsMemoryState();
        asked.worktrees.set(WorktreeId.make("wt-1"), { layout: null, requested: "person" });
        const operator = yield* stepsWith("shared", asked);
        const off = yield* stepsWith("shared", makeHarnessLayoutsMemoryState());
        const wt = WorktreeId.make("wt-1");
        return [
          yield* flagOn.steps.standbyMayServe(wt),
          yield* recorded.steps.standbyMayServe(wt),
          yield* operator.steps.standbyMayServe(wt),
          yield* off.steps.standbyMayServe(wt),
        ];
      }),
    );
    expect(result).toEqual([false, false, false, true]);
  });
});

describe("logins per person (docs/adr/0016, decision 5)", () => {
  /** Alice's person launch, prepared; then whatever `then` does with its steps. */
  const withPersonExecutor = <A, E>(
    core: CoreCalls,
    then: (input: {
      readonly steps: ReturnType<typeof makeHarnessLayoutSteps>;
      readonly repo: HarnessLayoutsRepo["Service"];
      readonly execs: Array<string>;
      readonly revoked: Array<string>;
      readonly forks: Array<Effect.Effect<void>>;
    }) => Effect.Effect<A, E>,
    grace: Duration.Duration = Duration.zero,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const execs: Array<string> = [];
        const revoked: Array<string> = [];
        const forks: Array<Effect.Effect<void>> = [];
        const { steps, repo } = yield* stepsWith("person", makeHarnessLayoutsMemoryState(), {
          platform: platformOf(core),
          execs,
          revoked,
          forks,
          grace,
        });
        const layout = yield* steps.decide(decideInput("launch-1"));
        const alice = yield* repo.ensureIdentity("user-alice");
        yield* steps.settlePrepare({
          layout,
          ...settleInput(
            "launch-1",
            `mend-layout probed\nmend-layout made ${alice.name}\nmend-layout ready\n`,
          ),
        });
        return yield* then({ steps, repo, execs, revoked, forks });
      }),
    );

  const start = (
    steps: ReturnType<typeof makeHarnessLayoutSteps>,
    accountId: string,
    harness = "claude",
  ) =>
    steps.processAs({
      workspace,
      launchId: "launch-1",
      accountId,
      sessionId: "sess-1",
      worktreeId: "wt-1",
      harness,
    });

  it("a join writes only the joiner's own logins, once, into their own home, and never touches the holder's", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(core, ({ steps, repo, execs }) =>
      Effect.gen(function* () {
        // The launcher's processes: their create-time home already holds their logins.
        yield* start(steps, "user-alice");
        const afterLauncher = [...core.calls];
        const maria = yield* repo.ensureIdentity("user-maria");
        const alice = yield* repo.ensureIdentity("user-alice");
        const started = yield* start(steps, "user-maria");
        // A second process of Maria's: her home already holds what it needs.
        yield* start(steps, "user-maria");
        return { afterLauncher, maria, alice, started, execs };
      }),
    );
    expect(result.afterLauncher).toEqual([]);
    // Exactly one Core call for the join, naming Maria and Maria's home, with her numeric owner.
    expect(core.posts).toEqual([
      {
        onBehalfOf: "user-maria",
        home: `/home/${result.maria.name}`,
        owner: { uid: result.maria.uid, gid: 40_000 },
        logins: { claude: true, github: true },
      },
    ]);
    // Nothing anyone ran for Maria reads, names or writes Alice's home.
    const aliceHome = `/home/${result.alice.name}`;
    for (const script of result.execs) expect(script).not.toContain(aliceHome);
    expect(core.calls.some((call) => call.includes(aliceHome))).toBe(false);
    expect(result.started?.user.home).toBe(`/home/${result.maria.name}`);
    expect(JSON.stringify(result.started?.env)).not.toContain(aliceHome);
  });

  it("leaves out a provider the joiner has not connected, and does not ask again for it", async () => {
    const core = coreCalls();
    core.answer = (index, logins) =>
      index === 0 && logins.github === true ? notConnected("github") : null;
    await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        yield* start(steps, "user-maria");
        yield* start(steps, "user-maria");
      }),
    );
    expect(core.posts.map((post) => post.logins)).toEqual([
      { claude: true, github: true },
      { claude: true, github: null },
    ]);
  });

  it("refuses a join whose harness login is not connected, or needs reconnecting, with nothing written and nobody else's login used", async () => {
    for (const [failure, words] of [
      [notConnected("claude"), loginRefusal("claude", false)],
      [needsReconnect("claude"), loginRefusal("claude", true)],
    ] as const) {
      const core = coreCalls();
      core.answer = () => failure;
      const refused = await withPersonExecutor(core, ({ steps }) =>
        start(steps, "user-maria").pipe(Effect.flip),
      );
      expect(refused.message).toBe(words);
      expect(core.posts).toHaveLength(1);
      expect(core.calls.filter((call) => call.startsWith("post:user-alice"))).toEqual([]);
    }
    expect(loginRefusal("claude", false)).toBe("Connect Claude to start a session here.");
  });

  it("asks again once the home is made when its POST raced the useradd that makes it", async () => {
    const core = coreCalls();
    core.answer = (index) =>
      index === 0
        ? new SealantPlatformError({
            code: "home-unusable",
            status: 409,
            message: "home is not a directory yet",
            cause: null,
          })
        : null;
    await withPersonExecutor(core, ({ steps }) => start(steps, "user-maria"));
    expect(core.posts).toHaveLength(2);
  });

  it("releases a person's logins once nothing of theirs runs, retried, with their token; never the launcher's", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(core, ({ steps, repo, revoked, execs }) =>
      Effect.gen(function* () {
        yield* start(steps, "user-maria");
        const maria = yield* repo.ensureIdentity("user-maria");
        const releasable = steps.holdsReleasable(workspace.id);
        yield* steps.releaseIdle({
          workspaceId: workspace.id,
          workspace: Effect.succeed(workspace),
          live: Effect.succeed(new Set(["user-alice"])),
        });
        const afterRelease = steps.holdsReleasable(workspace.id);
        // Maria starts again: made again (a new token), and her logins written again.
        const homeExecs = execs.length;
        yield* start(steps, "user-maria");
        return { maria, releasable, afterRelease, revoked, rehomed: execs.length - homeExecs };
      }),
    );
    expect(result.releasable).toBe(true);
    expect(result.afterRelease).toBe(false);
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([
      `delete:/home/${result.maria.name}`,
    ]);
    expect(result.revoked).toEqual(["launch-1:user-maria"]);
    expect(result.rehomed).toBe(1);
    expect(core.posts.filter((post) => post.onBehalfOf === "user-maria")).toHaveLength(2);
  });

  it("keeps a person's logins through the grace after a start, and checks again once it has passed", async () => {
    const core = coreCalls();
    const scheduled = await withPersonExecutor(
      core,
      ({ steps, forks }) =>
        Effect.gen(function* () {
          yield* start(steps, "user-maria");
          yield* steps.releaseIdle({
            workspaceId: workspace.id,
            workspace: Effect.succeed(workspace),
            live: Effect.succeed(new Set<string>()),
          });
          return forks;
        }),
      Duration.minutes(1),
    );
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    // One fork is the worktree repair of Maria's join; the other the later check.
    expect(scheduled.length).toBe(2);
  });

  it("writes a person's logins again once after an authentication failure, not again within a minute", async () => {
    const core = coreCalls();
    await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        for (let i = 0; i < 3; i++) {
          yield* steps.relogin({
            workspace,
            launchId: "launch-1",
            accountId: "user-alice",
            harness: "claude",
          });
        }
      }),
    );
    expect(core.posts.map((post) => [post.onBehalfOf, post.logins])).toEqual([
      ["user-alice", { claude: true, github: true }],
    ]);
  });

  it("at startup, knows the homes Core keeps and releases the one whose person runs nothing", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(core, ({ steps, repo }) =>
      Effect.gen(function* () {
        const alice = yield* repo.ensureIdentity("user-alice");
        const maria = yield* repo.ensureIdentity("user-maria");
        core.homes = [
          { home: `/home/${alice.name}`, onBehalfOf: "su-alice", providers: ["claude"] },
          { home: `/home/${maria.name}`, onBehalfOf: "su-maria", providers: ["claude", "github"] },
          { home: "/home/mgone2345", onBehalfOf: "su-bob", providers: ["codex"] },
        ];
        steps.forgetExecutor(workspace.id);
        yield* steps.reconcileLogins({
          workspace,
          launchId: "launch-1",
          launcher: "user-alice",
          live: new Set(["user-maria"]),
        });
        const callsAfterReconcile = core.calls.length;
        // Maria's next process: her home holds what it needs, so no POST.
        yield* start(steps, "user-maria");
        return { callsAfterReconcile };
      }),
    );
    expect(core.calls.slice(0, result.callsAfterReconcile)).toEqual([
      "list",
      "delete:/home/mgone2345",
    ]);
    expect(core.posts).toHaveLength(0);
  });
});
