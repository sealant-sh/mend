import { AgentConversationRepo, ProjectsRepo, SessionsRepo, SettingsRepo } from "@mend/db";
import {
  defaultSettings,
  MendSettings,
  OrganizationId,
  ProjectId,
  SessionId,
  WorktreeId,
} from "@mend/domain";
import { Project, Session, withLandingGuard } from "@mend/domain/workbench";
import { NameSessionJob, SessionNamer, type SessionNamingInput } from "@mend/inference";
import { type JobSpec, JobRunner } from "@mend/jobs";
import { SessionEngine } from "@mend/sessions";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { nameOnMessage, nameSession } from "./session-naming.ts";

const PROJECT = ProjectId.make("project-dots");
const SESSION = SessionId.make("session-second");

const project = new Project({
  ...makeProject({
    id: PROJECT,
    organizationId: OrganizationId.make("org-acme"),
    visibility: "shared",
    createdByUserId: "alice",
    storePath: "/store/project-dots/repo.git",
  }),
  name: "dots",
  autoName: "on",
});

/** The second session in a worktree: started bare, not named yet. */
const unnamed = (harness: string, settledAt: Date | null = null) =>
  new Session({
    ...makeSession(SESSION, PROJECT, WorktreeId.make("worktree-dots"), "alice"),
    harness,
    label: null,
    settledAt,
  });

/**
 * A naming pass's world: the session, what Mend recorded of the messages it was sent, and its
 * transcript, which is empty here as it was on the owner's server (SLNT-1211).
 */
const world = (options: {
  readonly session: Session;
  readonly recorded: ReadonlyArray<string>;
}) => {
  const named: Array<SessionNamingInput> = [];
  const labels: Array<string> = [];
  const layer = Layer.mergeAll(
    Layer.mock(SessionsRepo, {
      byId: () => Effect.succeed(options.session),
      setLabelIfUnset: (_id, label) => Effect.sync(() => labels.push(label)).pipe(Effect.as(true)),
    }),
    Layer.mock(ProjectsRepo, { byId: () => Effect.succeed(project) }),
    Layer.mock(SettingsRepo, {
      forPerson: () => Effect.succeed(new MendSettings(defaultSettings)),
    }),
    Layer.mock(AgentConversationRepo, {
      firstMessages: (sessionIds) =>
        Effect.succeed(
          options.recorded
            .slice(0, 1)
            .flatMap((input) =>
              sessionIds.includes(SESSION) ? [{ sessionId: SESSION, input }] : [],
            ),
        ),
    }),
    Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      transcript: () => Effect.succeed({ sourceHarness: options.session.harness, events: [] }),
    }),
    Layer.mock(SessionNamer, {
      name: (input) => Effect.sync(() => named.push(input)).pipe(Effect.as("hyprland joke")),
    }),
  );
  return { named, labels, layer };
};

describe("naming a session from its first message", () => {
  it("names a session started bare from the first message Mend recorded, though its transcript has none", async () => {
    const naming = world({
      session: unnamed("claude"),
      // What the composer sent, with the guard Mend added to it, then a second message.
      recorded: [withLandingGuard("tell me a joke"), "another one"],
    });
    await Effect.runPromise(
      nameSession(new NameSessionJob({ sessionId: SESSION })).pipe(Effect.provide(naming.layer)),
    );
    expect(naming.named).toEqual([
      { harness: "claude", projectName: "dots", firstUserTurn: "tell me a joke" },
    ]);
    expect(naming.labels).toEqual(["hyprland joke"]);
  });

  it("names a harness whose transcript Mend can't read from the message Mend recorded", async () => {
    const naming = world({ session: unnamed("opencode"), recorded: ["fix the login loop"] });
    await Effect.runPromise(
      nameSession(new NameSessionJob({ sessionId: SESSION })).pipe(Effect.provide(naming.layer)),
    );
    expect(naming.named.map((input) => input.firstUserTurn)).toEqual(["fix the login loop"]);
  });

  it("names from the prompt the job carries before anything Mend recorded", async () => {
    const naming = world({ session: unnamed("claude"), recorded: ["something later"] });
    await Effect.runPromise(
      nameSession(
        new NameSessionJob({ sessionId: SESSION, firstUserTurn: "the launch prompt" }),
      ).pipe(Effect.provide(naming.layer)),
    );
    expect(naming.named.map((input) => input.firstUserTurn)).toEqual(["the launch prompt"]);
  });

  it("waits on the transcript (the job retries) for a session nobody sent a message through Mend", async () => {
    const naming = world({ session: unnamed("claude"), recorded: [] });
    const exit = await Effect.runPromiseExit(
      nameSession(new NameSessionJob({ sessionId: SESSION })).pipe(Effect.provide(naming.layer)),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(naming.named).toEqual([]);
  });

  it("leaves a settled session that was never sent anything unnamed, without retrying", async () => {
    const naming = world({ session: unnamed("claude", new Date()), recorded: [] });
    await Effect.runPromise(
      nameSession(new NameSessionJob({ sessionId: SESSION })).pipe(Effect.provide(naming.layer)),
    );
    expect(naming.named).toEqual([]);
    expect(naming.labels).toEqual([]);
  });
});

/** What `nameOnMessage` queues for `session`. */
const queued = (session: { readonly id: SessionId; readonly label: string | null }) => {
  const jobs: Array<JobSpec> = [];
  return Effect.runPromise(
    nameOnMessage(session).pipe(
      Effect.provide(
        Layer.mock(JobRunner, {
          enqueue: (job) =>
            Effect.sync(() => jobs.push(job)).pipe(Effect.as({ _tag: "Queued", id: "job" })),
        }),
      ),
    ),
  ).then(() => jobs);
};

describe("a message to an unnamed session", () => {
  it("queues its namer at once, under a key the launch's waiting job doesn't hold", async () => {
    const jobs = await queued({ id: SESSION, label: null });
    expect(jobs).toEqual([
      expect.objectContaining({
        name: "name-session",
        payload: { sessionId: SESSION },
        idempotencyKey: `name-session:${SESSION}:message`,
      }),
    ]);
    expect(jobs[0]?.startAfterSeconds).toBeUndefined();
  });

  it("queues nothing for a session that has a name", async () => {
    expect(await queued({ id: SESSION, label: "repository overview" })).toEqual([]);
  });

  it("never fails the send when the namer can't be queued", async () => {
    await expect(
      Effect.runPromise(
        nameOnMessage({ id: SESSION, label: null }).pipe(
          Effect.provide(Layer.mock(JobRunner, { enqueue: () => Effect.die(new Error("down")) })),
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
