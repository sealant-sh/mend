import {
  HarnessLayoutsRepo,
  type HarnessLayoutsMemoryState,
  OrganizationsRepo,
  harnessLayoutsRepoMemory,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { OrganizationId, WorktreeId, defaultWorkspaceImage } from "@mend/domain";
import {
  type HomeLogins,
  type LoginProvider,
  type LoginSkip,
  PersonLayoutPlatform,
  SealantPlatformError,
} from "@mend/sealant";
import { claudeCode, type Run, type Workspace } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  type PersonHome,
  UNKNOWN_LAUNCH_REFUSAL,
  loginNeedOf,
  loginRefusal,
  makeHarnessLayoutSteps,
  refusedAccountOf,
} from "./harness-layout-steps.ts";
import { DOTFILES_BLOCK_REASON } from "./harness-layout.ts";
import { DOTFILES_NOT_TO_ROOT } from "./person-deliveries.ts";

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
  dotfiles: { apply: never },
  credentials: { put: never, release: never, list: async () => [] },
};

/** Every credentials call the platform was asked for, and how Core answers a POST. */
interface CoreCalls {
  /** Every call and step, in order: `post:`, `delete:`, `list`, `mint:`, `revoke:`, `exec:`. */
  readonly calls: Array<string>;
  readonly posts: Array<{
    readonly onBehalfOf: string;
    readonly home: string;
    readonly owner: { readonly uid: number; readonly gid: number } | undefined;
    readonly logins: HomeLogins;
    readonly partial: boolean;
  }>;
  /**
   * Core's answer to the nth POST (0-based): a failure, the providers a partial POST leaves out
   * (only those it named), or nothing for a write.
   */
  answer: (index: number, logins: HomeLogins) => CoreAnswer;
  homes: ReadonlyArray<{
    home: string;
    onBehalfOf: string;
    providers: ReadonlyArray<LoginProvider>;
  }>;
  /** Held open, a DELETE waits on it after saying so in `calls`. */
  deleteGate: Deferred.Deferred<void> | null;
  /** Held open, a POST waits on it after saying so in `calls`. */
  postGate: Deferred.Deferred<void> | null;
  imageReports: number;
  /** How often the control plane was asked what it can do. */
  controlPlaneReads: number;
}

type CoreAnswer = SealantPlatformError | ReadonlyArray<LoginSkip> | null;

const coreCalls = (): CoreCalls => ({
  calls: [],
  posts: [],
  answer: () => null,
  homes: [],
  deleteGate: null,
  postGate: null,
  imageReports: 0,
  controlPlaneReads: 0,
});

const platformOf = (
  core: CoreCalls,
  can: { readonly dotfilesUser?: boolean; readonly controlPlaneObstacle?: string | null } = {},
) =>
  Layer.succeed(PersonLayoutPlatform, {
    processUser: true,
    dotfilesUser: can.dotfilesUser ?? true,
    controlPlaneObstacle: Effect.sync(() => {
      core.controlPlaneReads++;
      return can.controlPlaneObstacle ?? null;
    }),
    withOwnerMap: (options) => options,
    imageReport: () =>
      Effect.sync(() => {
        core.imageReports++;
        return { digest: "sha256:img", runtime: "docker", person: true, missing: [] };
      }),
    postCredentials: (_workspace, input) =>
      Effect.suspend(() => {
        const index = core.posts.length;
        core.posts.push({
          onBehalfOf: input.onBehalfOf,
          home: input.home,
          owner: input.owner,
          logins: input.logins,
          partial: input.partial === true,
        });
        core.calls.push(`post:${input.onBehalfOf}:${input.home}`);
        const answer = core.answer(index, input.logins);
        const gate = core.postGate;
        return (gate === null ? Effect.void : Deferred.await(gate)).pipe(
          Effect.andThen(
            answer instanceof SealantPlatformError
              ? Effect.fail(answer)
              : Effect.succeed({
                  // Core leaves out only providers the POST named for an account.
                  skipped: (answer ?? []).filter((skip) => input.logins[skip.provider] === true),
                }),
          ),
        );
      }),
    deleteCredentials: (_workspace, input) =>
      Effect.gen(function* () {
        core.calls.push(`delete:${input.home}`);
        if (core.deleteGate !== null) yield* Deferred.await(core.deleteGate);
      }),
    sealantUserOf: (accountId) => Effect.succeed(`su-${accountId}`),
    listCredentials: () =>
      Effect.sync(() => {
        core.calls.push("list");
        return core.homes;
      }),
    applyDotfiles: () => Effect.succeed({ bootstrap: null }),
  });

const platformLayer = platformOf(coreCalls());

const organizationsLayer = Layer.mock(OrganizationsRepo, { members: () => Effect.succeed([]) });

/** The steps over the in-memory repo, counting every launch layout read from the store. */
const stepsWith = (
  flag: "person" | "shared",
  state: HarnessLayoutsMemoryState,
  options: {
    readonly platform?: Layer.Layer<PersonLayoutPlatform>;
    /** Every exec's script (or argv, for a non-shell exec) and the user it ran as. */
    readonly execs?: Array<{ readonly script: string; readonly user: string | null }>;
    /** Where mints, revocations and execs are logged in order, beside Core's calls. */
    readonly log?: Array<string>;
    readonly revoked?: Array<{ readonly accountId: string; readonly issuedBefore: number }>;
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
        exec: (_workspace, argv, execOptions) => {
          const execs = options.execs;
          return execs === undefined
            ? Effect.die("not in test")
            : Effect.sync(() => {
                const script = argv[0] === "sh" ? (argv[2] ?? "") : argv.join(" ");
                execs.push({ script, user: execOptions?.user?.name ?? null });
                options.log?.push(`exec:${execOptions?.user?.name ?? "root"}`);
                return { exitCode: 0, stdout: "", stderr: "", run: execRun };
              });
        },
      },
      harnessHome: "/workspace/harness-home",
      fork: (effect) => Effect.sync(() => options.forks?.push(effect)),
      identityTicket: (input) =>
        Effect.sync(() => {
          options.log?.push(`mint:${input.person.accountId}@${Date.now()}`);
          return "t".repeat(43);
        }),
      discardTicket: () => {},
      revokePersonToken: (_launchId, accountId, issuedBefore) =>
        Effect.sync(() => {
          options.log?.push(`revoke:${accountId}`);
          options.revoked?.push({ accountId, issuedBefore: issuedBefore.getTime() });
        }),
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

/** What a partial POST answers for a provider Core left out (sealant#337). */
const skipped = (
  provider: LoginProvider,
  reason: LoginSkip["reason"],
): ReadonlyArray<LoginSkip> => [{ provider, reason, message: `${provider}: ${reason}` }];
const notConnected = (provider: LoginProvider) => skipped(provider, "connected-account-missing");
const needsReconnect = (provider: LoginProvider) => skipped(provider, "connected-account-invalid");

describe("a control plane that cannot run the person layout (review of mend#569, P3-4)", () => {
  const obstacle =
    "the Sealant control plane does not run processes as a user (it does not report processUser)";
  it("decides a fresh worktree shared with its reason, before create and before asking about the image", async () => {
    const core = coreCalls();
    const layout = await Effect.runPromise(
      Effect.gen(function* () {
        const { steps } = yield* stepsWith("person", makeHarnessLayoutsMemoryState(), {
          platform: platformOf(core, { controlPlaneObstacle: obstacle }),
        });
        return yield* steps.decide(decideInput("launch-old-core"));
      }),
    );
    expect(layout).toMatchObject({ layout: "shared", source: "capability" });
    expect(layout.layout === "shared" ? layout.reason : null).toContain(obstacle);
    expect(core.imageReports).toBe(0);
    expect(core.controlPlaneReads).toBe(1);
  });

  it("refuses a worktree already person, naming it, and asks nothing with the flag off", async () => {
    const core = coreCalls();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        const { steps } = yield* stepsWith("shared", state, {
          platform: platformOf(core, { controlPlaneObstacle: obstacle }),
        });
        const refused = yield* steps.decide(decideInput("launch-sticky")).pipe(Effect.flip);
        const off = yield* stepsWith("shared", makeHarnessLayoutsMemoryState(), {
          platform: platformOf(core, { controlPlaneObstacle: obstacle }),
        });
        const reads = core.controlPlaneReads;
        yield* off.steps.decide({
          ...decideInput("launch-off"),
          worktreeId: WorktreeId.make("wt-9"),
        });
        return { message: refused.message, reads, after: core.controlPlaneReads };
      }),
    );
    expect(result.message).toContain(obstacle);
    expect(result.after).toBe(result.reads);
  });
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

/** `refusedAccountOf` over an error with these fields. */
const refusedOf = (fields: { code: string; status: number; provider?: string; message: string }) =>
  refusedAccountOf(new SealantPlatformError({ ...fields, cause: null }));

describe("logins per person (docs/adr/0016, decision 5)", () => {
  interface Executor {
    readonly steps: ReturnType<typeof makeHarnessLayoutSteps>;
    readonly repo: HarnessLayoutsRepo["Service"];
    readonly execs: Array<{ readonly script: string; readonly user: string | null }>;
    readonly log: Array<string>;
    readonly revoked: Array<{ readonly accountId: string; readonly issuedBefore: number }>;
    readonly forks: Array<Effect.Effect<void>>;
    readonly state: HarnessLayoutsMemoryState;
  }

  /**
   * Alice's person launch, prepared (unless `prepared` is false: a Mend that restarted, whose
   * memory of the executor is empty); then whatever `then` does with its steps.
   */
  const withPersonExecutor = <A, E>(
    core: CoreCalls,
    then: (executor: Executor) => Effect.Effect<A, E>,
    options: { readonly grace?: Duration.Duration; readonly prepared?: boolean } = {},
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const execs: Array<{ readonly script: string; readonly user: string | null }> = [];
        const log: Array<string> = [];
        const revoked: Array<{ readonly accountId: string; readonly issuedBefore: number }> = [];
        const forks: Array<Effect.Effect<void>> = [];
        const state = makeHarnessLayoutsMemoryState();
        const first = yield* stepsWith("person", state, {
          platform: platformOf(core),
          execs,
          log,
          revoked,
          forks,
          grace: options.grace ?? Duration.zero,
        });
        const layout = yield* first.steps.decide(decideInput("launch-1"));
        const alice = yield* first.repo.ensureIdentity("user-alice");
        yield* first.steps.settlePrepare({
          layout,
          ...settleInput(
            "launch-1",
            `mend-layout probed\nmend-layout made ${alice.name}\nmend-layout ready\n`,
          ),
        });
        // A restart: a new engine over the same store, remembering nothing of the executor.
        const steps =
          options.prepared === false
            ? (yield* stepsWith("person", state, {
                platform: platformOf(core),
                execs,
                log,
                revoked,
                forks,
                grace: options.grace ?? Duration.zero,
              })).steps
            : first.steps;
        return yield* then({ steps, repo: first.repo, execs, log, revoked, forks, state });
      }),
    );

  const start = (
    steps: ReturnType<typeof makeHarnessLayoutSteps>,
    accountId: string,
    harness = "claude",
    live: ReadonlyArray<string> = [],
  ) =>
    steps.processAs({
      workspace,
      launchId: "launch-1",
      accountId,
      sessionId: "sess-1",
      worktreeId: "wt-1",
      harness,
      live: Effect.succeed(new Set(live)),
    });

  const release = (
    steps: ReturnType<typeof makeHarnessLayoutSteps>,
    live: ReadonlyArray<string>,
    handle: Effect.Effect<Workspace> = Effect.succeed(workspace),
  ) =>
    steps.releaseIdle({
      workspaceId: workspace.id,
      workspace: handle,
      live: Effect.succeed(new Set(live)),
      launcher: Effect.succeed("user-alice"),
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
        partial: true,
      },
    ]);
    // Nothing anyone ran for Maria reads, names or writes Alice's home.
    const aliceHome = `/home/${result.alice.name}`;
    for (const exec of result.execs) expect(exec.script).not.toContain(aliceHome);
    expect(core.calls.some((call) => call.includes(aliceHome))).toBe(false);
    expect(result.started?.user.home).toBe(`/home/${result.maria.name}`);
    expect(JSON.stringify(result.started?.env)).not.toContain(aliceHome);
  });

  it("tells a joiner's home ready once their user exists, before their logins are written; a later start at once", async () => {
    const core = coreCalls();
    const order: Array<string> = [];
    const result = await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        const ready = (label: string) =>
          Effect.gen(function* () {
            const homeReady = yield* Deferred.make<PersonHome | null>();
            yield* Effect.forkChild(
              Deferred.await(homeReady).pipe(
                Effect.tap((home) =>
                  Effect.sync(() =>
                    order.push(
                      `${label}:${home === null ? "none" : home.made ? "made" : "there"}@${core.calls.length}`,
                    ),
                  ),
                ),
              ),
            );
            yield* steps.processAs({
              workspace,
              launchId: "launch-1",
              accountId: "user-maria",
              sessionId: "sess-1",
              worktreeId: "wt-1",
              harness: "claude",
              live: Effect.succeed(new Set<string>()),
              homeReady,
            });
            yield* Effect.yieldNow;
            return yield* Deferred.await(homeReady);
          });
        const first = yield* ready("first");
        const second = yield* ready("second");
        return { first, second };
      }),
    );
    expect(result.first?.made).toBe(true);
    expect(result.first?.user.name).toBe(result.first?.identity.name);
    expect(result.second?.made).toBe(false);
    // Each start tells it, the first once its home exec made her (beside her one Core call).
    expect(order.map((line) => line.split("@")[0])).toEqual(["first:made", "second:there"]);
  });

  it("decides a fresh worktree shared while the launcher's dotfiles cannot be applied as them, and asks only then", async () => {
    const asked: Array<string> = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const withDotfiles = (has: boolean) => ({
          ...decideInput(`launch-${String(has)}`),
          launcherHasDotfiles: Effect.sync(() => {
            asked.push(String(has));
            return has;
          }),
        });
        const noVerb = platformOf(coreCalls(), { dotfilesUser: false });
        const { steps } = yield* stepsWith("person", makeHarnessLayoutsMemoryState(), {
          platform: noVerb,
        });
        const blocked = yield* steps.decide(withDotfiles(true));
        const free = yield* steps.decide({
          ...withDotfiles(false),
          worktreeId: WorktreeId.make("wt-2"),
        });
        const off = yield* stepsWith("shared", makeHarnessLayoutsMemoryState(), {
          platform: noVerb,
        });
        const flagOff = yield* off.steps.decide({
          ...withDotfiles(true),
          worktreeId: WorktreeId.make("wt-3"),
        });
        // Core 0.39.0-next.703 applies them as the launcher (sealant#334): person, nothing asked.
        const verb = yield* stepsWith("person", makeHarnessLayoutsMemoryState());
        const applied = yield* verb.steps.decide({
          ...withDotfiles(true),
          worktreeId: WorktreeId.make("wt-4"),
        });
        return { blocked, free, flagOff, applied };
      }),
    );
    expect(result.blocked).toMatchObject({ layout: "shared", reason: DOTFILES_BLOCK_REASON });
    expect(result.free.layout).toBe("person");
    expect(result.flagOff.layout).toBe("shared");
    expect(result.applied.layout).toBe("person");
    // Read only where it decides something: never with the flag off, nor with the verb.
    expect(asked).toEqual(["true", "false"]);
  });

  it("leaves out a provider the joiner has not connected in the same one call, and does not ask again for it (sealant#337)", async () => {
    const core = coreCalls();
    core.answer = () => notConnected("github");
    await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        yield* start(steps, "user-maria");
        yield* start(steps, "user-maria");
      }),
    );
    // One partial call: Core wrote Claude and left GitHub out; no second `github: null` call.
    expect(core.posts.map((post) => [post.logins, post.partial])).toEqual([
      [{ claude: true, github: true }, true],
    ]);
  });

  it("a pi or opencode join names its ChatGPT login for Core to write, in the same one call (sealant#336)", async () => {
    for (const harness of ["pi", "opencode"] as const) {
      const core = coreCalls();
      // Maria's Codex account is not a ChatGPT login: Core leaves pi's or opencode's out.
      core.answer = () => skipped(harness, "connected-account-unsupported");
      const result = await withPersonExecutor(core, ({ steps, execs }) =>
        Effect.gen(function* () {
          const started = yield* start(steps, "user-maria", harness);
          yield* start(steps, "user-maria", harness);
          return { started, execs };
        }),
      );
      expect(core.posts.map((post) => post.logins)).toEqual([
        { claude: true, codex: true, github: true, [harness]: true },
      ]);
      // An open workbench: nothing it leaves out refuses it, and the line says what was left out.
      expect(result.started?.loginsLeftOut).toEqual([
        `${harness}'s ChatGPT login not written · the Codex account is not a ChatGPT login`,
      ]);
      // Mend writes no ChatGPT copy of its own into her home.
      expect(result.execs.some((exec) => exec.script.includes("openai"))).toBe(false);
    }
    expect(loginNeedOf("shell").optional).toEqual(["claude", "codex", "github"]);
  });

  it("the launcher's pi start asks Core for pi's login only: the create wrote the rest", async () => {
    const core = coreCalls();
    await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        yield* start(steps, "user-alice", "pi");
        yield* start(steps, "user-alice", "pi");
      }),
    );
    expect(core.posts.map((post) => [post.onBehalfOf, post.logins])).toEqual([
      ["user-alice", { codex: true, pi: true }],
    ]);
  });

  it("refuses a join whose harness login is not connected or needs reconnecting, by Core's reason, and revokes the token minted for it", async () => {
    for (const [failure, words] of [
      [notConnected("claude"), "Connect Claude to start a session here."],
      [
        needsReconnect("claude"),
        "Your Claude login needs reconnecting. Reconnect Claude to start a session here.",
      ],
      [
        skipped("claude", "login-file-unusable"),
        "Your Claude login could not be written into your home in this workspace: its file there is not a plain file of yours. Start a new worktree, or remove the file.",
      ],
    ] as const) {
      const core = coreCalls();
      core.answer = () => failure;
      const result = await withPersonExecutor(core, ({ steps, log, execs }) =>
        Effect.gen(function* () {
          const refused = yield* start(steps, "user-maria").pipe(Effect.flip);
          const releasable = steps.holdsReleasable(workspace.id);
          // Once connected, her next start makes her again: a new token, her logins written.
          core.answer = () => null;
          const homes = execs.length;
          yield* start(steps, "user-maria");
          return { refused, log: [...log], releasable, again: execs.length - homes };
        }),
      );
      expect(result.refused.message).toBe(words);
      expect(words).toBe(loginRefusal("claude", failure[0]?.reason ?? "connected-account-missing"));
      // Her user and home were made beside the POST; the token minted for her is revoked.
      expect(result.log.filter((line) => line.startsWith("revoke:"))).toEqual([
        "revoke:user-maria",
      ]);
      // The one partial call wrote her GitHub login: recorded, so the release after a refused
      // start reaches it.
      expect(result.releasable).toBe(true);
      expect(result.again).toBe(1);
      expect(core.posts.every((post) => post.partial)).toBe(true);
      expect(core.calls.filter((call) => call.startsWith("post:user-alice"))).toEqual([]);
    }
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

  it("releases a person's logins once nothing of theirs runs: Core's files, ChatGPT logins included, and their token", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(core, ({ steps, repo, revoked, execs, forks }) =>
      Effect.gen(function* () {
        yield* start(steps, "user-maria");
        const maria = yield* repo.ensureIdentity("user-maria");
        const releasable = steps.holdsReleasable(workspace.id);
        yield* release(steps, ["user-alice"]);
        for (const fork of forks.splice(0)) yield* fork;
        const afterRelease = steps.holdsReleasable(workspace.id);
        const homeExecs = execs.length;
        yield* start(steps, "user-maria");
        return {
          maria,
          releasable,
          afterRelease,
          revoked,
          execs,
          rehomed: execs.length - homeExecs,
        };
      }),
    );
    expect(result.releasable).toBe(true);
    expect(result.afterRelease).toBe(false);
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([
      `delete:/home/${result.maria.name}`,
    ]);
    // Core's release removes pi's and opencode's ChatGPT logins with the rest (sealant#336):
    // Mend runs nothing of its own in her home for it.
    expect(result.execs.some((exec) => exec.script.startsWith("node -e"))).toBe(false);
    expect(result.revoked.map((entry) => entry.accountId)).toEqual(["user-maria"]);
    // Her next start makes her again (a new token) and writes her logins again.
    expect(result.rehomed).toBe(1);
    expect(core.posts.filter((post) => post.onBehalfOf === "user-maria")).toHaveLength(2);
  });

  it("race: a start while a release waits for the workspace handle keeps its logins and token (review of mend#564, P2-1 B)", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(
      core,
      ({ steps, log }) =>
        Effect.gen(function* () {
          yield* start(steps, "user-maria");
          const handleGate = yield* Deferred.make<void>();
          const releasing = yield* release(
            steps,
            [],
            Deferred.await(handleGate).pipe(Effect.as(workspace)),
          ).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          // Maria starts again while the release waits for its handle.
          const started = yield* start(steps, "user-maria");
          yield* Deferred.succeed(handleGate, undefined);
          yield* Fiber.join(releasing);
          return { started: started?.user.name ?? null, log };
        }),
      { grace: Duration.minutes(1) },
    );
    expect(result.started).not.toBeNull();
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    expect(result.log.filter((line) => line.startsWith("revoke:"))).toEqual([]);
  });

  it("race: a start while a release's DELETE is in flight waits for it, then gets a new token the release never revokes (review of mend#564, P2-1 A)", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(core, ({ steps, log, revoked }) =>
      Effect.gen(function* () {
        yield* start(steps, "user-maria");
        core.deleteGate = yield* Deferred.make<void>();
        const gate = core.deleteGate;
        const releasing = yield* release(steps, []).pipe(Effect.forkChild);
        // Wait until the DELETE is in flight.
        while (!core.calls.some((call) => call.startsWith("delete:"))) yield* Effect.yieldNow;
        const starting = yield* start(steps, "user-maria").pipe(Effect.forkChild);
        yield* Effect.sleep(Duration.millis(5));
        const postsWhileDeleting = core.posts.length;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(releasing);
        yield* Fiber.join(starting);
        return { log, revoked, postsWhileDeleting };
      }),
    );
    // The start waited: nothing of it ran while the DELETE was in flight.
    expect(result.postsWhileDeleting).toBe(1);
    const order = result.log.map((line) => line.replace(/@\d+$/, ""));
    const revokedAt = order.indexOf("revoke:user-maria");
    const mintedAgain = order.lastIndexOf("mint:user-maria");
    expect(revokedAt).toBeGreaterThan(-1);
    expect(mintedAgain).toBeGreaterThan(revokedAt);
    // The release revokes only what was minted before it began.
    const minted = Number(result.log.findLast((line) => line.startsWith("mint:"))?.split("@")[1]);
    expect(result.revoked[0]?.issuedBefore ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(minted);
    expect(core.posts.filter((post) => post.onBehalfOf === "user-maria")).toHaveLength(2);
  });

  it("keeps a person's logins through the grace after a start, and checks again once it has passed", async () => {
    const core = coreCalls();
    const scheduled = await withPersonExecutor(
      core,
      ({ steps, forks }) =>
        Effect.gen(function* () {
          yield* start(steps, "user-maria");
          yield* release(steps, []);
          return forks;
        }),
      { grace: Duration.minutes(1) },
    );
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    // One fork is the worktree repair of Maria's join; the other the later check.
    expect(scheduled.length).toBe(2);
  });

  it("after a restart, the launcher's create-time home stays pinned even when their process starts first (review of mend#564, P2-2)", async () => {
    const core = coreCalls();
    await withPersonExecutor(
      core,
      ({ steps }) =>
        Effect.gen(function* () {
          // Remembering nothing, Mend writes Alice's logins into her home again: still hers.
          yield* start(steps, "user-alice");
          yield* release(steps, []);
        }),
      { prepared: false },
    );
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
  });

  it("writes a person's logins again once after an authentication failure, not again within a minute, and never into an idle person's home", async () => {
    const core = coreCalls();
    const releasable = await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        yield* steps.relogin({
          workspace,
          launchId: "launch-1",
          accountId: "user-maria",
          harness: "claude",
          live: Effect.succeed(new Set(["user-alice"])),
        });
        for (let i = 0; i < 3; i++) {
          yield* steps.relogin({
            workspace,
            launchId: "launch-1",
            accountId: "user-alice",
            harness: "claude",
            live: Effect.succeed(new Set(["user-alice"])),
          });
        }
        return steps.holdsReleasable(workspace.id);
      }),
    );
    expect(core.posts.map((post) => [post.onBehalfOf, post.logins])).toEqual([
      ["user-alice", { claude: true, github: true }],
    ]);
    expect(releasable).toBe(false);
  });

  it("records a re-POST, so a release reaches it", async () => {
    const core = coreCalls();
    const releasable = await withPersonExecutor(core, ({ steps }) =>
      Effect.gen(function* () {
        yield* steps.relogin({
          workspace,
          launchId: "launch-1",
          accountId: "user-maria",
          harness: "claude",
          live: Effect.succeed(new Set(["user-maria"])),
        });
        return steps.holdsReleasable(workspace.id);
      }),
    );
    expect(releasable).toBe(true);
  });

  it("at startup, lists Core's homes first and releases only the one whose person runs nothing, not one held for a start since", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(
      core,
      ({ steps, repo }) =>
        Effect.gen(function* () {
          const alice = yield* repo.ensureIdentity("user-alice");
          const maria = yield* repo.ensureIdentity("user-maria");
          const bob = yield* repo.ensureIdentity("user-bob");
          core.homes = [
            { home: `/home/${alice.name}`, onBehalfOf: "su-user-alice", providers: ["claude"] },
            {
              home: `/home/${maria.name}`,
              onBehalfOf: "su-user-maria",
              providers: ["claude", "github"],
            },
            { home: `/home/${bob.name}`, onBehalfOf: "su-user-bob", providers: ["codex"] },
          ];
          // Bob's first process since the restart: Mend holds his home now.
          yield* start(steps, "user-bob", "codex");
          const order: Array<string> = [];
          yield* steps.reconcileLogins({
            workspace,
            launchId: "launch-1",
            launcher: "user-alice",
            // Read after the list; a snapshot that predates Bob's row.
            live: Effect.sync(() => {
              order.push(`live after ${core.calls.at(-1) ?? ""}`);
              return new Set(["user-maria"]);
            }),
          });
          const callsAfterReconcile = core.calls.length;
          yield* start(steps, "user-maria");
          yield* release(steps, ["user-maria", "user-bob"]);
          return { callsAfterReconcile, order, maria, bob };
        }),
      { prepared: false },
    );
    expect(result.order).toEqual(["live after list"]);
    // Nothing released: Alice's is pinned, Maria is live, Bob's is held for his start.
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    // Maria's next process: her home holds what it needs, so no POST for her.
    expect(core.posts.filter((post) => post.onBehalfOf === "user-maria")).toHaveLength(0);
  });

  it("at startup, releases a home Core holds for anyone but its person, never adopting it (review of mend#564, P3-2)", async () => {
    const core = coreCalls();
    const marias = await withPersonExecutor(
      core,
      ({ steps, repo }) =>
        Effect.gen(function* () {
          const maria = yield* repo.ensureIdentity("user-maria");
          core.homes = [
            { home: `/home/${maria.name}`, onBehalfOf: "su-user-alice", providers: ["claude"] },
          ];
          yield* steps.reconcileLogins({
            workspace,
            launchId: "launch-1",
            launcher: "user-alice",
            live: Effect.succeed(new Set(["user-maria"])),
          });
          yield* start(steps, "user-maria");
          return maria;
        }),
      { prepared: false },
    );
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([
      `delete:/home/${marias.name}`,
    ]);
    // Her own logins are written for her start.
    expect(core.posts.map((post) => post.onBehalfOf)).toEqual(["user-maria"]);
  });

  it("refuses a process whose launch Mend cannot name in a person worktree, never running it as root", async () => {
    const result = await withPersonExecutor(coreCalls(), ({ steps, state }) =>
      Effect.gen(function* () {
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        return yield* steps
          .processAs({
            workspace,
            launchId: null,
            accountId: "user-alice",
            sessionId: "sess-1",
            worktreeId: "wt-1",
            harness: "shell",
            live: Effect.succeed(new Set<string>()),
          })
          .pipe(Effect.flip);
      }),
    );
    expect(result.message).toBe(UNKNOWN_LAUNCH_REFUSAL);
  });

  it("after a restart, a refused start of a person who still runs something here revokes and rewrites nothing of theirs (review 2 of mend#564, P2)", async () => {
    for (const reconciled of [true, false]) {
      const core = coreCalls();
      const result = await withPersonExecutor(
        core,
        ({ steps, repo, log, execs }) =>
          Effect.gen(function* () {
            const maria = yield* repo.ensureIdentity("user-maria");
            // Core still holds Maria's Claude login: her Claude agent runs, with its token.
            core.homes = [
              {
                home: `/home/${maria.name}`,
                onBehalfOf: "su-user-maria",
                providers: ["claude", "github"],
              },
            ];
            if (reconciled) {
              yield* steps.reconcileLogins({
                workspace,
                launchId: "launch-1",
                launcher: "user-alice",
                live: Effect.succeed(new Set(["user-maria"])),
              });
            }
            // She starts a Codex session with no Codex connected.
            core.answer = () => notConnected("codex");
            const refused = yield* start(steps, "user-maria", "codex", ["user-maria"]).pipe(
              Effect.flip,
            );
            return { refused: refused.message, log: [...log], homeExecs: execs.length };
          }),
        { prepared: false },
      );
      expect(result.refused).toBe("Connect Codex to start a session here.");
      // Her running processes' token stays good.
      expect(result.log.filter((line) => line.startsWith("revoke:"))).toEqual([]);
      // Adopted at startup, she is known to be made: no home exec rewrites her token file.
      if (reconciled) expect(result.homeExecs).toBe(0);
    }
  });

  it("at startup, leaves a home a refused start recorded, and the release after that start looks again after the grace", async () => {
    const core = coreCalls();
    const checks = await withPersonExecutor(
      core,
      ({ steps, repo, forks }) =>
        Effect.gen(function* () {
          const maria = yield* repo.ensureIdentity("user-maria");
          core.homes = [
            { home: `/home/${maria.name}`, onBehalfOf: "su-user-maria", providers: ["github"] },
          ];
          // A refused start of hers: the partial call wrote her GitHub login, recorded.
          core.answer = () => notConnected("claude");
          yield* start(steps, "user-maria").pipe(Effect.ignore);
          const before = forks.length;
          yield* steps.reconcileLogins({
            workspace,
            launchId: "launch-1",
            launcher: "user-alice",
            live: Effect.succeed(new Set<string>()),
          });
          const byReconcile = forks.length - before;
          // The engine releases after a refused start: inside the grace, it looks again later.
          yield* release(steps, []);
          return { byReconcile, byRelease: forks.length - before - byReconcile };
        }),
      { grace: Duration.minutes(1), prepared: false },
    );
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toEqual([]);
    expect(checks).toEqual({ byReconcile: 0, byRelease: 1 });
  });

  it("at startup, a home of someone idle is released whole: Core's files and their token, and nothing run in it", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(
      core,
      ({ steps, repo, log, execs }) =>
        Effect.gen(function* () {
          const maria = yield* repo.ensureIdentity("user-maria");
          core.homes = [
            { home: `/home/${maria.name}`, onBehalfOf: "su-user-maria", providers: ["claude"] },
          ];
          yield* steps.reconcileLogins({
            workspace,
            launchId: "launch-1",
            launcher: "user-alice",
            live: Effect.succeed(new Set<string>()),
          });
          return { maria, log, execs };
        }),
      { prepared: false },
    );
    expect(core.calls).toEqual(["list", `delete:/home/${result.maria.name}`]);
    expect(result.execs).toEqual([]);
    expect(result.log.filter((line) => line.startsWith("revoke:"))).toEqual(["revoke:user-maria"]);
  });

  it("at startup, a home holding someone else's login is released, and its live person keeps their own token", async () => {
    const core = coreCalls();
    const tokens = await withPersonExecutor(
      core,
      ({ steps, repo, log }) =>
        Effect.gen(function* () {
          const maria = yield* repo.ensureIdentity("user-maria");
          core.homes = [
            { home: `/home/${maria.name}`, onBehalfOf: "su-user-alice", providers: ["claude"] },
          ];
          yield* steps.reconcileLogins({
            workspace,
            launchId: "launch-1",
            launcher: "user-alice",
            live: Effect.succeed(new Set(["user-maria"])),
          });
          return log;
        }),
      { prepared: false },
    );
    expect(core.calls.filter((call) => call.startsWith("delete:"))).toHaveLength(1);
    expect(tokens.filter((line) => line.startsWith("revoke:"))).toEqual([]);
  });

  it("a start interrupted mid-write records the home for a release, and revokes the token minted for it", async () => {
    const core = coreCalls();
    const result = await withPersonExecutor(core, ({ steps, log }) =>
      Effect.gen(function* () {
        core.postGate = yield* Deferred.make<void>();
        const writing = yield* start(steps, "user-maria").pipe(Effect.forkChild);
        while (!core.calls.some((call) => call.startsWith("post:user-maria"))) {
          yield* Effect.yieldNow;
        }
        yield* Fiber.interrupt(writing);
        return { releasable: steps.holdsReleasable(workspace.id), log };
      }),
    );
    expect(result.releasable).toBe(true);
    expect(result.log.filter((line) => line.startsWith("revoke:"))).toEqual(["revoke:user-maria"]);
  });

  it("a person prediction prepare finds wrong writes the launcher's logins to /root and says their dotfiles have no way there (sealant#334)", async () => {
    const core = coreCalls();
    let applied = 0;
    const platform = Layer.effect(
      PersonLayoutPlatform,
      Effect.map(PersonLayoutPlatform, (inner) => ({
        ...inner,
        applyDotfiles: (on: Workspace, input: Parameters<typeof inner.applyDotfiles>[1]) => {
          applied++;
          return inner.applyDotfiles(on, input);
        },
      })),
    ).pipe(Layer.provide(platformOf(core)));
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const { steps, repo } = yield* stepsWith("person", makeHarnessLayoutsMemoryState(), {
          platform,
        });
        const layout = yield* steps.decide(decideInput("launch-wrong"));
        const alice = yield* repo.ensureIdentity("user-alice");
        const settled = yield* steps.settlePrepare({
          layout,
          ...settleInput("launch-wrong", "mend-layout probed\nmend-layout missing no sudo\n"),
          fallback: {
            credentials: { claude: true, github: true },
            dotfiles: [{ data: "eA==", manager: "copy", bootstrap: true }],
          },
        });
        return { settled, alice, layout: yield* steps.layoutOfLaunch("launch-wrong") };
      }),
    );
    expect(outcome.settled).toEqual({
      layout: "shared",
      fallback:
        "this image cannot run per-person users (no sudo), so this workspace takes one person",
      dotfilesNotApplied: DOTFILES_NOT_TO_ROOT,
    });
    expect(outcome.layout).toBe("shared");
    // The create-time home released, the logins at /root (a partial put), no apply as root.
    expect(core.calls).toEqual([`delete:/home/${outcome.alice.name}`, "post:user-alice:/root"]);
    expect(core.posts.map((post) => [post.logins, post.partial])).toEqual([
      [{ claude: true, github: true }, true],
    ]);
    expect(applied).toBe(0);
  });

  it("writes the /root fallback's logins in one partial put, refusing only for what the harness needs (review of mend#569, P3-6)", async () => {
    const settle = (harness: string | null, answer: ReadonlyArray<LoginSkip>) => {
      const core = coreCalls();
      core.answer = () => answer;
      return Effect.runPromise(
        Effect.gen(function* () {
          const { steps } = yield* stepsWith("person", makeHarnessLayoutsMemoryState(), {
            platform: platformOf(core),
          });
          const layout = yield* steps.decide(decideInput("launch-wrong"));
          const base = settleInput(
            "launch-wrong",
            "mend-layout probed\nmend-layout missing no sudo\n",
          );
          return yield* steps
            .settlePrepare({ layout, ...base, fallback: { ...base.fallback, harness } })
            .pipe(Effect.result);
        }),
      );
    };
    // GitHub disconnected since the create: left out, and the Claude launch goes on.
    const optional = await settle("claude", notConnected("github"));
    expect(optional._tag).toBe("Success");
    // The harness's own provider left out: refused, in Mend's words, by Core's reason.
    const required = await settle("claude", needsReconnect("claude"));
    expect(required._tag === "Failure" ? required.failure.message : null).toBe(
      loginRefusal("claude", "connected-account-invalid"),
    );
    // A harness Mend cannot name: every provider the create named is needed.
    const unknown = await settle(null, notConnected("github"));
    expect(unknown._tag === "Failure" ? unknown.failure.message : null).toBe(
      loginRefusal("github", "connected-account-missing"),
    );
  });

  it("reads a refused account from Core's stable reason and provider, never from its words (sealant#335)", () => {
    expect(
      refusedOf({
        code: "connected-account-missing",
        status: 404,
        provider: "github",
        message: "?",
      }),
    ).toEqual({ provider: "github", reason: "connected-account-missing" });
    expect(
      refusedOf({
        code: "connected-account-unsupported",
        status: 409,
        provider: "codex",
        message: "",
      }),
    ).toEqual({ provider: "codex", reason: "connected-account-unsupported" });
    // Core's old words with no stable code are not a refusal any more, nor a code with no provider.
    expect(
      refusedOf({
        code: "WorkspaceNotFoundError",
        status: 404,
        message: 'No claude connected account matches "default".',
      }),
    ).toBeNull();
    expect(refusedOf({ code: "connected-account-invalid", status: 409, message: "" })).toBeNull();
    expect(
      refusedOf({ code: "home-held", status: 409, provider: "claude", message: "" }),
    ).toBeNull();
  });

  it("maps a person launch refused for its owner map to Mend's words, and records the image's answer (sealant#333)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const { steps } = yield* stepsWith("person", state);
        const layout = yield* steps.decide(decideInput("launch-fresh"));
        const unsupported = new SealantPlatformError({
          code: "owner-map-unsupported",
          status: null,
          message:
            "The workspace was not launched: its capture source names an owner map, and its image's sealantd does not report restore.owner_map.",
          cause: null,
        });
        const fresh = yield* steps.refusedOwnerMap({
          layout,
          launchId: "launch-fresh",
          error: unsupported,
        });
        const freshLayout = yield* steps.layoutOfLaunch("launch-fresh");
        const afterFresh = [...state.capabilities.values()].map((record) => record.missing);
        // A worktree already person: decision 14's words, and it stays person.
        state.worktrees.set(WorktreeId.make("wt-1"), { layout: "person", requested: null });
        const sticky = yield* steps
          .decide(decideInput("launch-sticky"))
          .pipe(Effect.catch(() => Effect.succeed(layout)));
        const kubernetes = yield* steps.refusedOwnerMap({
          layout: sticky.layout === "person" ? { ...sticky, onMissing: "refuse" } : layout,
          launchId: "launch-sticky",
          error: new SealantPlatformError({
            code: "unsupported-runtime-requirement",
            status: 422,
            message:
              "An owner map (a per-person executor) is not available on Kubernetes: workspace Pods run with allowPrivilegeEscalation: false, so the kubelet sets no-new-privileges and no person's sudo could work.",
            cause: null,
          }),
        });
        const other = yield* steps.refusedOwnerMap({
          layout,
          launchId: "launch-other",
          error: new SealantPlatformError({
            code: "control_plane_unavailable",
            status: 503,
            message: "the control plane did not answer",
            cause: null,
          }),
        });
        return {
          fresh: fresh?.message ?? null,
          freshLayout,
          kubernetes: kubernetes?.message ?? null,
          other,
          capabilities: afterFresh,
          worktree: state.worktrees.get(WorktreeId.make("wt-1"))?.layout ?? null,
        };
      }),
    );
    expect(result.fresh).toBe(
      "This workspace cannot run per-person users (its sealantd does not restore files per person), so nothing was started. The next launch here runs as one person.",
    );
    expect(result.freshLayout).toBe("shared");
    expect(result.kubernetes).toBe(
      "This worktree's sessions are saved per person, and its image cannot run per-person users (Kubernetes workspaces cannot run per-person users: no one's sudo works there). Pick an image that can, or start a new worktree.",
    );
    expect(result.other).toBeNull();
    expect(result.capabilities).toEqual([["its sealantd does not restore files per person"]]);
    expect(result.worktree).toBe("person");
  });
});
