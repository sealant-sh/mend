import { LaunchRequest, NotFound } from "@mend/api-contracts";
import {
  AgentConversationRepo,
  HarnessModelsRepo,
  ProjectsRepo,
  SessionsRepo,
  SessionNotFoundError,
  SettingsRepo,
} from "@mend/db";
import {
  AgentTurnId,
  defaultSettings,
  MendSettings,
  OrganizationId,
  ProjectId,
  SessionId,
  SealantRunId,
  SealantWorkspaceId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  HARNESS_MODEL_SEED,
  HarnessModel,
  harnessModelCatalog,
  LANDING_GUARD,
  Project,
  Session,
  type AutomationChoice,
  type SessionOrigin,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SessionEngine, SessionLaunchSetupError } from "@mend/sessions";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets, type BudgetLimits } from "./budgets.ts";
import { SessionStart, SessionStartLive, type StartSessionInput } from "./session-start.ts";

const ACME = OrganizationId.make("org-acme");
const PROJECT = ProjectId.make("project-acme");
const HIDDEN = ProjectId.make("project-hidden");
const SESSION = SessionId.make("session-new");

const project = new Project({
  ...makeProject({
    id: PROJECT,
    organizationId: ACME,
    visibility: "shared",
    createdByUserId: "alice",
    storePath: "/store/project-acme/repo.git",
  }),
  autoName: "on",
});

const provisioned = (
  ownerUserId: string | null,
  origin: SessionOrigin = "mend",
  autoLand: boolean | null = null,
  started: { readonly model: string | null; readonly effort: "high" | null } = {
    model: null,
    effort: null,
  },
) =>
  new Session({
    ...makeSession(SESSION, PROJECT, WorktreeId.make("worktree-new"), ownerUserId),
    harness: "claude",
    label: null,
    origin,
    autoLand,
    model: started.model,
    effort: started.effort,
  });

const earlierTurn = new AgentTurn({
  id: AgentTurnId.make("turn-earlier"),
  sessionId: SESSION,
  processId: SessionProcessId.make("process-earlier"),
  ordinal: 0,
  author: "alice",
  input: "fix the flaky test",
  status: "completed",
  providerTurnId: null,
  error: null,
  usage: null,
  createdAt: new Date("2026-09-24T10:00:00.000Z"),
  startedAt: null,
  endedAt: null,
});

/** The seeded catalog for a harness, as the server's table holds it. */
const catalogFor = (harness: string) =>
  harnessModelCatalog(
    harness,
    (HARNESS_MODEL_SEED[harness] ?? []).map(
      (row) =>
        new HarnessModel({
          id: row.id,
          label: row.label,
          isDefault: row.isDefault,
          efforts: row.efforts ?? null,
        }),
    ),
  );

const request = (launch: ConstructorParameters<typeof LaunchRequest>[0]): StartSessionInput => ({
  projectId: PROJECT,
  session: { harness: "claude", label: null, name: null, base: null, origin: "slack" },
  launch: new LaunchRequest(launch),
});

/**
 * A start whose every effect is appended, in order, as `service.method:subject`. Only `alice`
 * sees the project; `live` is how many unsettled sessions she already owns.
 */
const startWorld = (
  options: {
    readonly limits?: Partial<BudgetLimits>;
    readonly live?: number;
    readonly launchGate?: Deferred.Deferred<void>;
    /** Where the provisioned session says it came from, and its own landing override. */
    readonly origin?: SessionOrigin;
    readonly sessionAutoLand?: boolean | null;
    /** The project's "Land when a turn completes", and the Settings default. */
    readonly projectAutoLand?: AutomationChoice;
    readonly settingsAutoLand?: boolean;
    /** How many turns the session has had already. */
    readonly turns?: number;
    /** Alice is the instance operator. */
    readonly operator?: boolean;
    /** The row observable while launch is pending, including a deleted row. */
    readonly initial?: Session | null;
    readonly executorCreate?: string | null;
    readonly launchFailure?: SessionLaunchSetupError;
    readonly launchEntered?: Deferred.Deferred<void>;
    readonly launchFinished?: Deferred.Deferred<void>;
  } = {},
) => {
  const effects: Array<string> = [];
  const settlements: Array<Parameters<SessionsRepo["Service"]["settle"]>> = [];
  const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];
  let current =
    options.initial === undefined
      ? new Session({ ...provisioned("alice"), status: "starting", summary: "booting" })
      : options.initial;
  const budgets = makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...options.limits });
  const note = (entry: string) => Effect.sync(() => void effects.push(entry));
  const layer = SessionStartLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectAccess, {
          projectAs: (userId, id) =>
            note(`access.projectAs:${userId}:${id}`).pipe(
              Effect.andThen(
                userId === "alice" && id === PROJECT
                  ? Effect.succeed(project)
                  : Effect.fail(new NotFound({ id })),
              ),
            ),
          isOperator: (userId) =>
            note(`access.isOperator:${userId}`).pipe(
              Effect.as(options.operator === true && userId === "alice"),
            ),
        }),
        Layer.succeed(Budgets, budgets),
        Layer.mock(SessionsRepo, {
          listUnsettledForOwner: (userId) =>
            note(`sessions.listUnsettledForOwner:${userId}`).pipe(
              Effect.as(
                Array.from({ length: options.live ?? 0 }, (_, index) =>
                  makeSession(
                    SessionId.make(`session-live-${index}`),
                    PROJECT,
                    WorktreeId.make("worktree-live"),
                    userId,
                  ),
                ),
              ),
            ),
          countUnsettledForOrganization: (organizationId) =>
            note(`sessions.countUnsettledForOrganization:${organizationId}`).pipe(
              Effect.as(options.live ?? 0),
            ),
          setLaunchOptions: (id, resolved) =>
            note(`sessions.setLaunchOptions:${id}:${resolved.model}:${resolved.effort}`),
          // The session as it stands while its launch goes on.
          byId: (id) =>
            note(`sessions.byId:${id}`).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  current === null
                    ? Effect.fail(new SessionNotFoundError({ sessionId: id }))
                    : Effect.succeed(current),
                ),
              ),
            ),
          executorCreateOf: () => Effect.succeed(options.executorCreate ?? null),
          settle: (id, outcome, summary) =>
            Effect.sync(() => {
              settlements.push([id, outcome, summary]);
              if (current !== null)
                current = new Session({
                  ...current,
                  status: outcome,
                  summary,
                  settledAt: new Date("2026-09-24T10:00:00.000Z"),
                });
            }),
        }),
        Layer.mock(SessionEngine, {
          launchUnderWay: () => false,
          detach: (effect) =>
            effect.pipe(
              Effect.onExit(() =>
                options.launchFinished === undefined
                  ? Effect.void
                  : Deferred.succeed(options.launchFinished, undefined),
              ),
              Effect.forkDetach,
              Effect.tap((fiber) =>
                Effect.sync(() => {
                  fibers.push(fiber);
                }),
              ),
            ),
          provision: (input) =>
            note(
              `engine.provision:${input.projectId}:${input.ownerUserId}:${input.origin}${input.autoLand === null || input.autoLand === undefined ? "" : `:land=${input.autoLand}`}${input.harnessLayout === undefined ? "" : `:layout=${input.harnessLayout}`}`,
            ).pipe(
              Effect.as(
                provisioned(
                  input.ownerUserId,
                  options.origin ?? "mend",
                  options.sessionAutoLand ?? null,
                ),
              ),
            ),
          launchProtocol: (sessionId, start, author) =>
            note(
              `engine.launchProtocol:${sessionId}:${author}:${start.model ?? "-"}:${start.effort ?? "-"}:${start.prompt}`,
            ).pipe(
              Effect.andThen(
                options.launchEntered === undefined
                  ? Effect.void
                  : Deferred.succeed(options.launchEntered, undefined),
              ),
              Effect.andThen(
                options.launchGate === undefined ? Effect.void : Deferred.await(options.launchGate),
              ),
              Effect.andThen(
                options.launchFailure === undefined
                  ? Effect.succeed(provisioned(author))
                  : Effect.fail(options.launchFailure),
              ),
            ),
          launch: (sessionId, argv) =>
            note(`engine.launch:${sessionId}:${argv.join(" ")}`).pipe(
              Effect.as(provisioned("alice")),
            ),
        }),
        Layer.mock(HarnessModelsRepo, {
          forHarness: (harness) =>
            note(`harnessModels.forHarness:${harness}`).pipe(Effect.as(catalogFor(harness))),
        }),
        Layer.mock(ProjectsRepo, {
          byId: () =>
            Effect.succeed(
              new Project({ ...project, autoLand: options.projectAutoLand ?? "inherit" }),
            ),
        }),
        Layer.mock(SettingsRepo, {
          forOrganization: () =>
            Effect.succeed(
              new MendSettings({
                ...defaultSettings,
                autoLand: options.settingsAutoLand ?? defaultSettings.autoLand,
              }),
            ),
        }),
        Layer.mock(AgentConversationRepo, {
          listTurns: (sessionId) =>
            note(`conversations.listTurns:${sessionId}`).pipe(
              Effect.as(Array.from({ length: options.turns ?? 0 }, () => earlierTurn)),
            ),
        }),
        Layer.mock(JobRunner, {
          enqueue: (job) =>
            note(`jobs.enqueue:${job.name}:${job.startAfterSeconds}`).pipe(
              Effect.as({ _tag: "Queued", id: "job" }),
            ),
        }),
      ),
    ),
  );
  return {
    effects,
    layer,
    budgets,
    settlements,
    fibers,
    current: () => current,
    cleanup: Effect.forEach(fibers, Fiber.interrupt, { discard: true }),
  };
};

const startAs = (world: ReturnType<typeof startWorld>, userId: string, input: StartSessionInput) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const start = yield* SessionStart;
      return yield* start.startAs(userId, input);
    }).pipe(Effect.provide(world.layer), Effect.result),
  );

describe("SessionStart.startAs", () => {
  it("authorizes, checks the budget, provisions for the user, names, then launches with the prompt", async () => {
    const world = startWorld();
    const result = await startAs(
      world,
      "alice",
      request({ mode: "protocol", prompt: " fix the flaky test " }),
    );

    expect(result._tag).toBe("Success");
    expect(world.effects).toEqual([
      `access.projectAs:alice:${PROJECT}`,
      "sessions.listUnsettledForOwner:alice",
      `sessions.countUnsettledForOrganization:${ACME}`,
      `engine.provision:${PROJECT}:alice:slack`,
      // The catalog is read for the model; Claude's names no default, so none is sent and Claude
      // Code's own decides. The engine records the launch once it is admitted.
      "harnessModels.forHarness:claude",
      // A composed start knows its first prompt: the namer is queued before the launch.
      "jobs.enqueue:name-session:0",
      `engine.launchProtocol:${SESSION}:alice:-:-: fix the flaky test `,
    ]);
    expect(world.effects.some((entry) => entry.startsWith("sessions.setLaunchOptions"))).toBe(
      false,
    );
  });

  it("passes the model a launch names, with its effort clamped to what that model takes", async () => {
    const world = startWorld();
    const result = await startAs(
      world,
      "alice",
      request({ mode: "protocol", prompt: "hello", model: "sonnet", effort: "ultra" }),
    );

    expect(result._tag).toBe("Success");
    expect(launched(world)).toEqual([`engine.launchProtocol:${SESSION}:alice:sonnet:max:hello`]);
  });

  it("relaunches a session on the model it was started with when the request names none", async () => {
    // A Slack follow-up on a settled session sends only the prompt (slack-runner.ts).
    const world = startWorld();
    const session = provisioned("alice", "mend", null, { model: "sonnet", effort: "high" });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        return yield* start.launchAs(
          "alice",
          session,
          new LaunchRequest({ mode: "protocol", prompt: "and the other test" }),
        );
      }).pipe(Effect.provide(world.layer), Effect.result),
    );

    expect(result._tag).toBe("Success");
    expect(launched(world)).toEqual([
      `engine.launchProtocol:${SESSION}:alice:sonnet:high:and the other test`,
    ]);
  });

  it("names no Claude model nobody chose in a PTY launch's argv, and records the launch once admitted", async () => {
    // Claude Code's own default decides, as for a `claude` run by hand (2026-10-12).
    const world = startWorld();
    const result = await startAs(world, "alice", request({ effort: "high" }));

    expect(result._tag).toBe("Success");
    const recorded = world.effects.indexOf(`sessions.setLaunchOptions:${SESSION}:null:high`);
    const launchedAt = world.effects.indexOf(`engine.launch:${SESSION}:claude --effort high`);
    expect(recorded).toBeGreaterThan(-1);
    expect(launchedAt).toBe(recorded + 1);
  });

  it("sends opencode no model nobody chose, so the person's own opencode config decides", async () => {
    // The catalog lists opencode's models, none the default: `--model` from Mend would beat a
    // model named in the project's or the user's opencode config.
    const launch = async (launchRequest: LaunchRequest) => {
      const world = startWorld();
      const session = new Session({ ...provisioned("alice"), harness: "opencode" });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const start = yield* SessionStart;
          return yield* start.launchAs("alice", session, launchRequest);
        }).pipe(Effect.provide(world.layer), Effect.result),
      );
      expect(result._tag).toBe("Success");
      return world.effects;
    };
    const bare = await launch(new LaunchRequest({ prompt: "fix the test" }));
    expect(bare).toContain(`engine.launch:${SESSION}:opencode --prompt fix the test`);
    expect(bare).toContain(`sessions.setLaunchOptions:${SESSION}:null:null`);
    const chosen = await launch(new LaunchRequest({ model: "openai/gpt-6-astra" }));
    expect(chosen).toContain(`engine.launch:${SESSION}:opencode --model openai/gpt-6-astra`);
  });

  it("records nothing when the account's launch slots refuse the launch", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const entered = Effect.runSync(Deferred.make<void>());
    const world = startWorld({
      limits: { accountLaunchesInFlight: 1 },
      launchGate: gate,
      launchEntered: entered,
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        const first = yield* Effect.forkChild(
          start.startAs("alice", request({ mode: "protocol", prompt: "first" })),
        );
        yield* Deferred.await(entered);
        yield* start.startAs("alice", request({ effort: "high" })).pipe(Effect.result);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
      }).pipe(
        Effect.provide(world.layer),
        Effect.ensuring(world.cleanup),
        Effect.timeout("3 seconds"),
      ),
    );
    expect(world.effects.some((entry) => entry.startsWith("sessions.setLaunchOptions"))).toBe(
      false,
    );
  });

  it("resolves nothing for a verbatim argv, and records that: the command names its own model", async () => {
    const world = startWorld();
    const result = await startAs(world, "alice", request({ argv: ["claude", "--model", "opus"] }));

    expect(result._tag).toBe("Success");
    expect(world.effects.some((entry) => entry.startsWith("harnessModels."))).toBe(false);
    expect(world.effects).toContain(`sessions.setLaunchOptions:${SESSION}:null:null`);
    expect(world.effects).toContain(`engine.launch:${SESSION}:claude --model opus`);
  });

  it("answers NotFound for a project the user cannot see, and does nothing else", async () => {
    const world = startWorld();
    const result = await startAs(world, "bob", request({ mode: "protocol", prompt: "hello" }));

    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "NotFound",
      id: PROJECT,
    });
    expect(world.effects).toEqual([`access.projectAs:bob:${PROJECT}`]);

    const hidden = await startAs(world, "alice", {
      ...request({ mode: "protocol" }),
      projectId: HIDDEN,
    });
    expect(hidden._tag === "Failure" ? hidden.failure : null).toMatchObject({ id: HIDDEN });
  });

  it("refuses at the account's session ceiling before a worktree exists", async () => {
    const world = startWorld({ limits: { accountLiveSessions: 1 }, live: 1 });
    const result = await startAs(world, "alice", request({ mode: "protocol", prompt: "hello" }));

    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountLiveSessions",
    });
    expect(world.effects).toEqual([
      `access.projectAs:alice:${PROJECT}`,
      "sessions.listUnsettledForOwner:alice",
    ]);
  });

  it("refuses a launch while the account's launch slots are held, after provisioning", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const entered = Effect.runSync(Deferred.make<void>());
    const world = startWorld({
      limits: { accountLaunchesInFlight: 1 },
      launchGate: gate,
      launchEntered: entered,
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        const first = yield* Effect.forkChild(
          start.startAs("alice", request({ mode: "protocol", prompt: "first" })),
        );
        // Wait until the first launch holds its slot.
        yield* Deferred.await(entered);
        const second = yield* start
          .startAs("alice", request({ mode: "protocol", prompt: "second" }))
          .pipe(Effect.result);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        return second;
      }).pipe(
        Effect.provide(world.layer),
        Effect.ensuring(world.cleanup),
        Effect.timeout("3 seconds"),
      ),
    );

    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountLaunchesInFlight",
    });
    expect(world.effects.filter((entry) => entry.startsWith("engine.launchProtocol"))).toEqual([
      `engine.launchProtocol:${SESSION}:alice:-:-:first`,
    ]);
  });

  it("answers a launch that outlasts the answer window with the session as it stands, and the launch goes on holding its slot", async () => {
    // Alpha 2026-09-30: a launch held its request for the whole ~8 min image build and the CLI
    // gave up at ~5 min with a false `cannot reach the Mend server`.
    const gate = Effect.runSync(Deferred.make<void>());
    const entered = Effect.runSync(Deferred.make<void>());
    const world = startWorld({
      limits: { accountLaunchesInFlight: 1 },
      launchGate: gate,
      launchEntered: entered,
    });
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        const session = provisioned("alice");
        const answering = yield* Effect.forkChild(
          start.launchAs(
            "alice",
            session,
            new LaunchRequest({ mode: "protocol", prompt: "first" }),
            { within: Duration.millis(20) },
          ),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(20);
        const first = yield* Fiber.join(answering);
        // The first launch still holds the account's one slot after its caller was answered.
        const second = yield* start
          .launchAs("alice", session, new LaunchRequest({ mode: "protocol", prompt: "second" }), {
            within: Duration.millis(20),
          })
          .pipe(Effect.result);
        yield* Deferred.succeed(gate, undefined);
        // Once the first launch has ended, its slot is free again.
        const running = world.fibers[0];
        if (running === undefined)
          return yield* Effect.die("launch fixture did not record its owned fiber");
        yield* Fiber.join(running);
        const third = yield* start
          .launchAs("alice", session, new LaunchRequest({ mode: "protocol", prompt: "third" }), {
            within: Duration.seconds(5),
          })
          .pipe(Effect.result);
        return { first, second, third };
      }).pipe(
        Effect.provide(world.layer),
        Effect.ensuring(world.cleanup),
        Effect.provide(TestClock.layer()),
        Effect.timeout("3 seconds"),
      ),
    );

    expect(answers.first.status).toBe("starting");
    expect(answers.first.summary).toBe("booting");
    expect(answers.second._tag === "Failure" ? answers.second.failure : null).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountLaunchesInFlight",
    });
    expect(answers.third._tag).toBe("Success");
    expect(launched(world)).toEqual([
      `engine.launchProtocol:${SESSION}:alice:-:-:first`,
      `engine.launchProtocol:${SESSION}:alice:-:-:third`,
    ]);
  });

  it("queues the delayed namer after a bare PTY launch", async () => {
    const world = startWorld();
    const result = await startAs(world, "alice", request({}));

    expect(result._tag).toBe("Success");
    expect(world.effects.slice(-2)).toEqual([
      `engine.launch:${SESSION}:claude`,
      "jobs.enqueue:name-session:45",
    ]);
  });

  it("refuses argv on a protocol launch before launching anything", async () => {
    const world = startWorld();
    const result = await startAs(world, "alice", request({ mode: "protocol", argv: ["claude"] }));

    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "StoreFailure",
    });
    expect(world.effects.some((entry) => entry.startsWith("engine.launch"))).toBe(false);
  });
});

const launched = (world: ReturnType<typeof startWorld>) =>
  world.effects.filter((entry) => entry.startsWith("engine.launchProtocol"));

describe("the prompt guard (docs/adr/0007, Questions do not open pull requests)", () => {
  const guarded = `engine.launchProtocol:${SESSION}:alice:-:-:fix the flaky test\n\n${LANDING_GUARD}`;
  const plain = `engine.launchProtocol:${SESSION}:alice:-:-:fix the flaky test`;

  it("tells a Slack request's agent that Mend publishes, after the request", async () => {
    const world = startWorld({ origin: "slack" });
    const result = await startAs(
      world,
      "alice",
      request({ mode: "protocol", prompt: "fix the flaky test" }),
    );

    expect(result._tag).toBe("Success");
    expect(launched(world)).toEqual([guarded]);
    expect(LANDING_GUARD).toContain("If the request is a question, answer it and change no files.");
    expect(LANDING_GUARD).toContain("Never push and never open a pull request yourself.");
    expect(LANDING_GUARD).toContain("run `mend land`");
    expect(LANDING_GUARD).toContain("Committing is fine.");
  });

  it("tells a web session's agent only while it lands by itself", async () => {
    const off = startWorld();
    await startAs(off, "alice", request({ mode: "protocol", prompt: "fix the flaky test" }));
    expect(launched(off)).toEqual([plain]);
    // Nothing is read about turns when the guard cannot apply.
    expect(off.effects.some((entry) => entry.startsWith("conversations."))).toBe(false);

    const projectOn = startWorld({ projectAutoLand: "on" });
    await startAs(projectOn, "alice", request({ mode: "protocol", prompt: "fix the flaky test" }));
    expect(launched(projectOn)).toEqual([guarded]);

    const settings = startWorld({ settingsAutoLand: true });
    await startAs(settings, "alice", request({ mode: "protocol", prompt: "fix the flaky test" }));
    expect(launched(settings)).toEqual([guarded]);

    const override = startWorld({ settingsAutoLand: true, sessionAutoLand: false });
    await startAs(override, "alice", request({ mode: "protocol", prompt: "fix the flaky test" }));
    expect(launched(override)).toEqual([plain]);

    const projectOff = startWorld({ projectAutoLand: "off", sessionAutoLand: true });
    await startAs(projectOff, "alice", request({ mode: "protocol", prompt: "fix the flaky test" }));
    expect(launched(projectOff)).toEqual([plain]);
  });

  it("guards only the opening turn: a resumed conversation heard it already", async () => {
    const world = startWorld({ origin: "slack", turns: 1 });
    await startAs(world, "alice", request({ mode: "protocol", prompt: "fix the flaky test" }));
    expect(launched(world)).toEqual([plain]);
  });

  it("passes the session's own override to provisioning", async () => {
    const world = startWorld();
    await startAs(world, "alice", {
      ...request({ mode: "protocol", prompt: "fix the flaky test" }),
      session: {
        harness: "claude",
        label: null,
        name: null,
        base: null,
        origin: "mend",
        autoLand: true,
      },
    });
    expect(world.effects).toContain(`engine.provision:${PROJECT}:alice:mend:land=true`);
  });
});

describe("SessionStart.createAs harnessLayout (docs/adr/0016, decision 14)", () => {
  const createAs = (world: ReturnType<typeof startWorld>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        return yield* start.createAs("alice", PROJECT, {
          harness: "claude",
          label: null,
          name: null,
          base: null,
          origin: "mend",
          harnessLayout: "person",
        });
      }).pipe(Effect.provide(world.layer), Effect.result),
    );

  it("is refused for anyone but the instance operator, before anything is made", async () => {
    const world = startWorld();
    const result = await createAs(world);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("HarnessLayoutRefused");
    expect(world.effects.some((effect) => effect.startsWith("engine.provision"))).toBe(false);
  });

  it("reaches the engine for the operator, which applies it to a worktree it makes", async () => {
    const world = startWorld({ operator: true });
    const result = await createAs(world);
    expect(result._tag).toBe("Success");
    expect(world.effects).toContain(`engine.provision:${PROJECT}:alice:mend:layout=person`);
  });
});

const unlaunched = () =>
  new Session({
    ...provisioned("alice"),
    status: "starting",
    summary: "waiting for launch",
    sealantWorkspaceId: null,
    sealantRunId: null,
    sealantSessionId: null,
    startedAt: null,
    settledAt: null,
  });
const setupFailure = () =>
  new SessionLaunchSetupError({
    sessionId: SESSION,
    command: "owned fixture setup",
    message: "fixture setup refused",
  });
const launchInput = () => new LaunchRequest({ mode: "protocol", prompt: "" });
const expectLaunchFailure = (result: Awaited<ReturnType<typeof startAs>>) => {
  expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
    _tag: "StoreFailure",
    message: "fixture setup refused",
  });
};

describe("API-owned pre-workspace launch failure settlement", () => {
  it("settles an unanswered launch failure and releases the real account slot", async () => {
    const row = unlaunched();
    const world = startWorld({
      initial: row,
      limits: { accountLaunchesInFlight: 1 },
      launchFailure: setupFailure(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        const result = yield* start.launchAs("alice", row, launchInput()).pipe(Effect.result);
        expectLaunchFailure(result);
        expect(world.settlements).toEqual([
          [SESSION, "failed", "launch failed: fixture setup refused"],
        ]);
        expect(world.current()).toEqual(
          new Session({
            ...row,
            status: "failed",
            summary: "launch failed: fixture setup refused",
            settledAt: new Date("2026-09-24T10:00:00.000Z"),
          }),
        );
        expect(yield* world.budgets.withLaunchSlot("alice", Effect.succeed("reused"))).toBe(
          "reused",
        );
      }).pipe(Effect.provide(world.layer), Effect.ensuring(world.cleanup)),
    );
  });

  it("settles a late failure after the bounded answer and then releases its still-held slot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const row = unlaunched();
        const world = startWorld({
          initial: row,
          limits: { accountLaunchesInFlight: 1 },
          launchEntered: entered,
          launchGate: release,
          launchFinished: finished,
          launchFailure: setupFailure(),
        });
        return yield* Effect.gen(function* () {
          const start = yield* SessionStart;
          const caller = yield* start
            .launchAs("alice", row, launchInput(), { within: Duration.seconds(10) })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* TestClock.adjust("10 seconds");
          expect(yield* Fiber.join(caller)).toEqual(row);
          expect(world.settlements).toEqual([]);
          expect(world.current()).toEqual(row);
          expect(
            yield* world.budgets.withLaunchSlot("alice", Effect.succeed("unexpected free slot")),
          ).toBeNull();
          yield* Deferred.succeed(release, undefined);
          // The engine's returned detached fiber completes after settlement and the slot finalizer.
          yield* Deferred.await(finished);
          const detached = world.fibers[0];
          if (detached === undefined) throw new Error("Missing detached launch fiber");
          const late = yield* Fiber.join(detached).pipe(Effect.result);
          expect(late._tag === "Failure" ? late.failure : null).toMatchObject({
            _tag: "StoreFailure",
            message: "fixture setup refused",
          });
          expect(world.settlements).toEqual([
            [SESSION, "failed", "launch failed: fixture setup refused"],
          ]);
          expect(world.current()).toEqual(
            new Session({
              ...row,
              status: "failed",
              summary: "launch failed: fixture setup refused",
              settledAt: new Date("2026-09-24T10:00:00.000Z"),
            }),
          );
          expect(yield* world.budgets.withLaunchSlot("alice", Effect.succeed("reused"))).toBe(
            "reused",
          );
        }).pipe(Effect.provide(world.layer), Effect.ensuring(world.cleanup));
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    );
  });

  it.each([
    {
      name: "accepted workspace",
      row: new Session({
        ...unlaunched(),
        sealantWorkspaceId: SealantWorkspaceId.make("workspace-existing"),
      }),
      intent: null,
    },
    {
      name: "accepted run",
      row: new Session({ ...unlaunched(), sealantRunId: SealantRunId.make("run-existing") }),
      intent: null,
    },
    { name: "executor create intent", row: unlaunched(), intent: "create-in-flight" },
    {
      name: "prior settlement",
      row: new Session({
        ...unlaunched(),
        settledAt: new Date("2026-09-23T10:00:00.000Z"),
        summary: "earlier result",
      }),
      intent: null,
    },
    {
      name: "running status",
      row: new Session({ ...unlaunched(), status: "running", summary: "engine is running" }),
      intent: null,
    },
    { name: "deleted row", row: null, intent: null },
  ])("does not overwrite $name on setup failure", async ({ row, intent }) => {
    const world = startWorld({
      initial: row,
      executorCreate: intent,
      limits: { accountLaunchesInFlight: 1 },
      launchFailure: setupFailure(),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        expectLaunchFailure(
          yield* start.launchAs("alice", row ?? unlaunched(), launchInput()).pipe(Effect.result),
        );
        expect(world.current()).toEqual(row);
        expect(world.settlements).toEqual([]);
        expect(yield* world.budgets.withLaunchSlot("alice", Effect.succeed("reused"))).toBe(
          "reused",
        );
      }).pipe(Effect.provide(world.layer), Effect.ensuring(world.cleanup)),
    );
  });
});
