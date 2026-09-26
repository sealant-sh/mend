import { LaunchRequest, NotFound } from "@mend/api-contracts";
import { AgentConversationRepo, ProjectsRepo, SessionsRepo, SettingsRepo } from "@mend/db";
import {
  AgentTurnId,
  defaultSettings,
  MendSettings,
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  LANDING_GUARD,
  Project,
  Session,
  type AutomationChoice,
  type SessionOrigin,
} from "@mend/domain/workbench";
import { JobRunner } from "@mend/jobs";
import { SessionEngine } from "@mend/sessions";
import { Deferred, Effect, Fiber, Layer } from "effect";
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
) =>
  new Session({
    ...makeSession(SESSION, PROJECT, WorktreeId.make("worktree-new"), ownerUserId),
    harness: "claude",
    label: null,
    origin,
    autoLand,
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
  } = {},
) => {
  const effects: Array<string> = [];
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
        }),
        Layer.succeed(Budgets, makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...options.limits })),
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
        }),
        Layer.mock(SessionEngine, {
          provision: (input) =>
            note(
              `engine.provision:${input.projectId}:${input.ownerUserId}:${input.origin}${input.autoLand === null || input.autoLand === undefined ? "" : `:land=${input.autoLand}`}`,
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
            note(`engine.launchProtocol:${sessionId}:${author}:${start.prompt}`).pipe(
              Effect.andThen(
                options.launchGate === undefined ? Effect.void : Deferred.await(options.launchGate),
              ),
              Effect.as(provisioned(author)),
            ),
          launch: (sessionId, argv) =>
            note(`engine.launch:${sessionId}:${argv.join(" ")}`).pipe(
              Effect.as(provisioned("alice")),
            ),
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
            note(`jobs.enqueue:${job.name}:${job.startAfterSeconds}`).pipe(Effect.as("job")),
        }),
      ),
    ),
  );
  return { effects, layer };
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
      // A composed start knows its first prompt: the namer is queued before the launch.
      "jobs.enqueue:name-session:0",
      `engine.launchProtocol:${SESSION}:alice: fix the flaky test `,
    ]);
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
    const world = startWorld({ limits: { accountLaunchesInFlight: 1 }, launchGate: gate });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const start = yield* SessionStart;
        const first = yield* Effect.forkChild(
          start.startAs("alice", request({ mode: "protocol", prompt: "first" })),
        );
        // Wait until the first launch holds its slot.
        while (!world.effects.some((entry) => entry.includes(":first"))) {
          yield* Effect.yieldNow;
        }
        const second = yield* start
          .startAs("alice", request({ mode: "protocol", prompt: "second" }))
          .pipe(Effect.result);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(first);
        return second;
      }).pipe(Effect.provide(world.layer)),
    );

    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountLaunchesInFlight",
    });
    expect(world.effects.filter((entry) => entry.startsWith("engine.launchProtocol"))).toEqual([
      `engine.launchProtocol:${SESSION}:alice:first`,
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
  const guarded = `engine.launchProtocol:${SESSION}:alice:fix the flaky test\n\n${LANDING_GUARD}`;
  const plain = `engine.launchProtocol:${SESSION}:alice:fix the flaky test`;

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
    expect(LANDING_GUARD).toContain("Never push and never open a pull request.");
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
