import { LaunchRequest, NotFound } from "@mend/api-contracts";
import { ProjectsRepo, SessionsRepo, SettingsRepo } from "@mend/db";
import { defaultSettings, OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import { Project, Session } from "@mend/domain/workbench";
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

const provisioned = (ownerUserId: string | null) =>
  new Session({
    ...makeSession(SESSION, PROJECT, WorktreeId.make("worktree-new"), ownerUserId),
    harness: "claude",
    label: null,
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
            note(`engine.provision:${input.projectId}:${input.ownerUserId}:${input.origin}`).pipe(
              Effect.as(provisioned(input.ownerUserId)),
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
        Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
        Layer.mock(SettingsRepo, { get: () => Effect.succeed(defaultSettings) }),
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
