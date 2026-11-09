import {
  type McpServersRepo,
  type McpSignInObserved,
  UserGitAuthorRepo,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { PreviewId, PreviewLabel, SessionId } from "@mend/domain";
import {
  isAgentProcessKind,
  AgentHookReport,
  type GitAuthMode,
  type Preview,
  Project,
  ResolvedGitAuthor,
  Session,
  SessionProcess,
  currentAgentProcess,
} from "@mend/domain/workbench";
import { LinuxIdentity } from "@mend/domain/workbench";
import type { HarnessLayout } from "@mend/domain/workbench";
import { type PersonSessionOptions, SealantClient } from "@mend/sealant";
import {
  SessionEngine,
  WORKSPACE_MEND_TOML_SCRIPT,
  WorkspaceGitHooks,
  WorkspaceGitHooksLive,
} from "@mend/sessions";
import { AgentBridge } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Clock, Duration, Effect, Exit, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { CONTAINER_TOKEN_REFUSED } from "../src/channel-identity.ts";
import { MEND_AGENT_PROCESS_ENV } from "../src/mend-mcp/caller.ts";
import { type HarvestedSignIns, SIGN_INS_ONLY_IN_OWN_HOME } from "../src/mend-mcp/sign-ins.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { failureText } from "./engine/capture-fixture.ts";
import { signalled, watched, parkingClock } from "./engine/clock-fixture.ts";
import {
  mcpServersLayerOf,
  now,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  type World,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import {
  LAYOUT_READY,
  MARIA,
  answerLayout,
  isPrepare,
  perAccountKeys,
  personPlatform,
  workspacesPerOwner,
} from "./engine/person-fixture.ts";

/** Every account's own signer is connected; whose was asked for is recorded. */
const perAccountBridge = (asked: Array<string>): Layer.Layer<AgentBridge> =>
  Layer.succeed(AgentBridge, {
    attach: () => Effect.die("not in test"),
    status: (userId) =>
      Effect.sync(() => {
        asked.push(`status:${userId}`);
        return { connected: true, clientName: "laptop", since: null };
      }),
    socketPath: (userId) => `/bridge/${userId}.sock`,
    begin: (userId) =>
      Effect.sync(() => {
        asked.push(`begin:${userId}`);
        return () => {};
      }),
  });

/** `mend land` requests, with who asked. */
const recordingLandings = (asked: Array<string>): Layer.Layer<WorkspaceGitHooks> =>
  Layer.effect(
    WorkspaceGitHooks,
    Effect.map(WorkspaceGitHooks, (inner) => ({
      ...inner,
      landRequested: (sessionId: SessionId, requestedBy?: string | null) =>
        Effect.sync(() => {
          asked.push(`${sessionId}:${requestedBy ?? "workspace"}`);
          return { landed: false, lines: ["not landed · recorded"] };
        }),
    })),
  ).pipe(Layer.provide(WorkspaceGitHooksLive));

/** The identity pickups an exec carries (`identityPickupScript`): ticket, name, home, uid each. */
const identityArgsOf = (
  script: string,
): ReadonlyArray<{ readonly ticket: string; readonly name: string; readonly home: string }> => {
  // A prepare's people list (`name:uid:account id:member:ticket` each, `personPrepareScript`).
  const listed = /^mend_people='([^']*)'; mend_homes='([^']*)'/m.exec(script);
  if (listed !== null) {
    return (listed[1] ?? "")
      .split(" ")
      .filter((word) => word !== "")
      .flatMap((word) => {
        const [name = "", , , , ticket = "-"] = word.split(":");
        return ticket === "-" ? [] : [{ ticket, name, home: `${listed[2] ?? ""}/${name}` }];
      });
  }
  const tail = [...script.matchAll(/ -- ((?:'[A-Za-z0-9_./-]+' ?){4,})/g)].at(-1)?.[1] ?? "";
  const words = [...tail.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
  const people: Array<{ ticket: string; name: string; home: string }> = [];
  for (let i = 0; i + 3 < words.length; i += 4) {
    people.push({ ticket: words[i] ?? "", name: words[i + 1] ?? "", home: words[i + 2] ?? "" });
  }
  return people;
};

/** What each identity pickup answered, by home; and why one was refused, by name. */
interface IdentityPickups {
  readonly written: Map<string, ReadonlyArray<{ readonly path: string; readonly base64: string }>>;
  readonly refused: Map<string, string>;
  /** What a second presentation of the same ticket, through the same channel, answered. */
  readonly again: Map<string, ReadonlyArray<{ readonly path: string; readonly base64: string }>>;
  /** Redemptions node tried once more after a passing failure, by name. */
  readonly retried: Array<string>;
  /** Each person's ticket, as the exec carried it. */
  readonly tickets: Map<string, string>;
}

/**
 * The executor's side of an identity pickup: for an exec that carries identity tickets, redeem
 * each person's that the exec made (prepare: the people its report says it made; a person's home:
 * that person) over the channel its container env names, the workspace's own token, as node does
 * there. `presentAs` may present a person's ticket through another person's token instead.
 */
const identityExec =
  (options: {
    readonly pickups: IdentityPickups;
    readonly holder: () => SessionId | null;
    readonly launchId: () => string;
    readonly presentAs?: (name: string) => string | null;
    /** Present every ticket a second time after its answer, as a retry whose answer was lost. */
    readonly twice?: boolean;
    /** Present every ticket a second time while its first answer is still being made. */
    readonly overlap?: boolean;
  }) =>
  (argv: ReadonlyArray<string>) => {
    const script = argv[2] ?? "";
    if (argv[0] !== "sh" || !script.includes("/pickup")) {
      return undefined;
    }
    const people = identityArgsOf(script);
    if (people.length === 0) return undefined;
    const prepare = isPrepare(argv);
    const madeHere = prepare ? [linuxLoginNameOf("user-fixture")] : people.map((p) => p.name);
    return Effect.gen(function* () {
      const holder = options.holder();
      const api = holder === null ? undefined : servedSocketApis.get(holder);
      let failed = false;
      for (const person of people.filter((p) => madeHere.includes(p.name))) {
        const accountId = options.presentAs?.(person.name) ?? null;
        const grant =
          api?.channelFor === undefined
            ? null
            : yield* api.channelFor({ launchId: options.launchId(), accountId });
        if (grant === null || !grant.ok || grant.api.pickup === undefined) {
          failed = true;
          options.pickups.refused.set(person.name, "no pickup on this channel");
          continue;
        }
        const pickup = grant.api.pickup;
        options.pickups.tickets.set(person.name, person.ticket);
        if (options.overlap === true) {
          // A first request that timed out, and its retry, 10 ms later, while the first is made.
          const [first, second] = yield* Effect.all(
            [
              pickup(person.ticket).pipe(Effect.result),
              Effect.sleep("10 millis").pipe(Effect.andThen(pickup(person.ticket)), Effect.result),
            ],
            { concurrency: 2 },
          );
          if (first._tag === "Success")
            options.pickups.written.set(person.home, first.success.files);
          else options.pickups.refused.set(person.name, first.failure.message);
          if (second._tag === "Success")
            options.pickups.again.set(person.home, second.success.files);
          else options.pickups.refused.set(`${person.name} again`, second.failure.message);
          continue;
        }
        let answer = yield* pickup(person.ticket).pipe(Effect.result);
        // As node does: a passing failure is tried once more, a refused ticket is not.
        if (answer._tag === "Failure" && !answer.failure.message.startsWith("this pickup ticket")) {
          options.pickups.retried.push(person.name);
          answer = yield* pickup(person.ticket).pipe(Effect.result);
        }
        if (answer._tag === "Failure") {
          failed = true;
          options.pickups.refused.set(person.name, answer.failure.message);
        } else {
          options.pickups.written.set(person.home, answer.success.files);
          if (options.twice === true) {
            const again = yield* pickup(person.ticket).pipe(Effect.result);
            if (again._tag === "Success")
              options.pickups.again.set(person.home, again.success.files);
            else options.pickups.refused.set(`${person.name} again`, again.failure.message);
          }
        }
      }
      return {
        exitCode: !prepare && failed ? 1 : 0,
        stdout: prepare ? (failed ? "mend-layout probed\n" : LAYOUT_READY) : "",
        stderr: failed ? "mend: identity: refused\n" : "",
      };
    });
  };

const decoded = (
  files: ReadonlyArray<{ readonly path: string; readonly base64: string }> | undefined,
) =>
  new Map(
    (files ?? []).map((file) => [file.path, Buffer.from(file.base64, "base64").toString("utf8")]),
  );

interface LiveJoin {
  readonly world: World;
  readonly holder: Session;
  readonly joined: Session;
  readonly launchId: string;
  readonly origin: string;
  readonly execs: ReadonlyArray<ReadonlyArray<string>>;
  readonly opened: ReadonlyArray<PersonSessionOptions>;
  readonly tokenEvents: ReadonlyArray<string>;
  readonly pickups: IdentityPickups;
  /** Why the join failed, or null. */
  readonly joinFailure: string | null;
}

/**
 * A holder's cold launch and a join by Maria into its executor, both live: then `inspect` runs
 * with the engine, the sessions and the launch.
 */
interface LivePersonJoinOptions<A> {
  readonly flag: HarnessLayout;
  readonly gitAuthMode?: GitAuthMode;
  readonly keysAsked?: Array<string>;
  readonly bridgeAsked?: Array<string>;
  readonly landings?: Array<string>;
  readonly launchLayoutReads?: Array<string>;
  /** Present a person's identity ticket through another person's token (by login name). */
  readonly presentAs?: (name: string) => string | null;
  /** Maria has an identity already (from another worktree), so prepare names her too. */
  readonly mariaKnown?: boolean;
  /** Present every identity ticket a second time, through the same channel. */
  readonly presentTwice?: boolean;
  /** Present every identity ticket again while its first answer is still being made. */
  readonly presentOverlapping?: boolean;
  readonly gitAuthorLayer?: Layer.Layer<UserGitAuthorRepo>;
  readonly mcpServersLayer?: Layer.Layer<McpServersRepo>;
  /**
   * The stand-in platform has one workspace for every create, so a scenario that launches a second
   * executor cannot keep each workspace its creator's; it runs on one platform user instead. Every
   * other scenario runs where only a workspace's creator reaches it (`workspacesPerOwner`).
   */
  readonly onePlatformUser?: boolean;
  /** Every log line the engine writes, when a scenario reads them. */
  readonly logs?: Array<string>;
  /** A command in the executor a scenario answers itself; undefined falls through. */
  readonly exec?: (
    argv: ReadonlyArray<string>,
  ) => { readonly exitCode: number; readonly stdout: string; readonly stderr: string } | undefined;
  /** The user each exec ran as, in the order of `execs` (null: root). */
  readonly execUsers?: Array<string | null>;
  /**
   * Runs beside the holder's launch and Maria's join, with the pickups as they land: a
   * clock-driven scenario. Its failure ends both.
   */
  readonly drive?: (pickups: IdentityPickups) => Effect.Effect<void>;
  readonly inspect: (
    engine: SessionEngine["Service"],
    join: LiveJoin,
  ) => Effect.Effect<A, unknown, SessionEngine>;
}

const livePersonJoinEffect = <A>(options: LivePersonJoinOptions<A>): Effect.Effect<A> =>
  Effect.gen(function* () {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const opened: Array<PersonSessionOptions> = [];
    const tokenEvents: Array<string> = [];
    const person = options.flag === "person";
    const pickups: IdentityPickups = {
      written: new Map(),
      refused: new Map(),
      again: new Map(),
      retried: [],
      tickets: new Map(),
    };
    const state = makeHarnessLayoutsMemoryState();
    if (options.mariaKnown === true) {
      state.identities.set(
        MARIA,
        new LinuxIdentity({ accountId: MARIA, name: linuxLoginNameOf(MARIA), uid: 40_001 }),
      );
    }
    const launchIdOf = () =>
      tokenEvents.find((event) => event.startsWith("issue:"))?.slice("issue:".length) ?? "";
    const holderOf = () => {
      const id = created[0]?.env?.["MEND_SESSION_ID"];
      return id === undefined ? null : SessionId.make(id);
    };
    let result: { readonly value: A } | null = null;
    yield* withPreparedEngineEffect(
      (world, tmp) => setup(tmp, world),
      (world, _tmp, project) =>
        Effect.gen(function* () {
          if (options.gitAuthMode !== undefined) {
            world.projects.set(
              project.id,
              new Project({ ...project, gitAuthMode: options.gitAuthMode }),
            );
          }
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const launches = Effect.gen(function* () {
            yield* engine.launch(holder.id, ["claude"]);
            const joinedRow = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            const joinExit = yield* engine.launch(joinedRow.id, ["claude"]).pipe(Effect.exit);
            return { joinedRow, joinExit };
          });
          const drive = options.drive;
          const { joinedRow, joinExit } =
            drive === undefined
              ? yield* launches
              : (yield* Effect.all([launches, drive(pickups)], { concurrency: "unbounded" }))[0];
          const launchId = launchIdOf();
          const holderNow = world.sessions.get(holder.id) ?? holder;
          const joinedNow = world.sessions.get(joinedRow.id) ?? joinedRow;
          result = {
            value: yield* options.inspect(engine, {
              world,
              holder: holderNow,
              joined: joinedNow,
              launchId,
              origin: new URL(project.originUrl ?? "").hostname,
              execs: execCalls,
              opened,
              tokenEvents,
              pickups,
              joinFailure: Exit.isSuccess(joinExit) ? null : failureText(joinExit),
            }),
          };
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        tokenEvents,
        ...(options.logs === undefined ? {} : { logs: options.logs }),
        ...(options.keysAsked === undefined
          ? {}
          : { mendKeysLayer: perAccountKeys(options.keysAsked) }),
        ...(options.bridgeAsked === undefined
          ? {}
          : { agentBridgeLayer: perAccountBridge(options.bridgeAsked) }),
        ...(options.landings === undefined
          ? {}
          : { gitHooksLayer: recordingLandings(options.landings) }),
        ...(options.gitAuthorLayer === undefined ? {} : { gitAuthorLayer: options.gitAuthorLayer }),
        ...(options.mcpServersLayer === undefined
          ? {}
          : { mcpServersLayer: options.mcpServersLayer }),
        sealantLayer: perOwnerUnless(
          options.onePlatformUser,
          sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            opened,
            undefined,
            execCalls,
            undefined,
            person
              ? {
                  exec: (argv) => options.exec?.(argv) ?? answerLayout(LAYOUT_READY)(argv),
                  ...(options.execUsers === undefined ? {} : { execUsers: options.execUsers }),
                  execEffect: identityExec({
                    pickups,
                    holder: holderOf,
                    launchId: launchIdOf,
                    ...(options.presentAs === undefined ? {} : { presentAs: options.presentAs }),
                    ...(options.presentTwice === true ? { twice: true } : {}),
                    ...(options.presentOverlapping === true ? { overlap: true } : {}),
                  }),
                }
              : {},
          ),
        ),
        harnessLayout: {
          flag: options.flag,
          state,
          ...(person ? { platform: personPlatform([], { person: true }) } : {}),
          ...(options.launchLayoutReads === undefined
            ? {}
            : { launchLayoutReads: options.launchLayoutReads }),
        },
      },
    );
    if (result === null) throw new Error("the scenario did not run");
    return (result as { readonly value: A }).value;
  });

const livePersonJoin = <A>(options: LivePersonJoinOptions<A>): Promise<A> =>
  Effect.runPromise(livePersonJoinEffect(options));

// The repository's rule (proven against Postgres): a process started before the reset loses.
const signInsKept = (
  kept: Array<{ accountId: string; observed: McpSignInObserved }>,
  resetAt: Date,
) =>
  mcpServersLayerOf(undefined, (accountId, observed) =>
    Effect.sync(() => {
      kept.push({ accountId, observed });
      return observed.processStartedAt < resetAt ? "reset" : "kept";
    }),
  );
const agentProcessOf = (world: World, session: Session) => {
  const row = [...world.processes.values()].find(
    (process) => process.sessionId === session.id && isAgentProcessKind(process.kind),
  );
  if (row === undefined) throw new Error("the session has no agent process");
  return row;
};

/** Shared control on for `session` (docs/adr/0003): anyone in its organization may steer. */
const shareControl = (world: World, session: Session): Session => {
  const shared = new Session({ ...session, sharedControlEnabledAt: now() });
  world.sessions.set(session.id, shared);
  return shared;
};

const grantOf = (
  session: Session,
  scope: { readonly launchId: string; readonly accountId: string | null },
) =>
  Effect.gen(function* () {
    const api = servedSocketApis.get(session.id);
    if (api?.channelFor === undefined) throw new Error("the session serves no channel grant");
    return yield* api.channelFor(scope);
  });

const STOP_HOOK = new AgentHookReport({
  harness: "claude",
  event: "Stop",
  notificationType: null,
  tool: null,
  providerSessionId: null,
});

/** A push to the project's own origin, as git asks the shim for it. */
const push = (origin: string) => ({
  host: origin,
  port: null,
  command: "git-receive-pack 'fixture.git'",
});

describe("git and Mend identity per process (docs/adr/0016, decision 4)", () => {
  const LAUNCHER = linuxLoginNameOf("user-fixture");
  const JOINER = linuxLoginNameOf(MARIA);

  it("gives each person their own token and git author through a pickup, minted when redeemed, never in argv", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (_engine, join) =>
        Effect.sync(() => {
          const prepare = join.execs.find((argv) => (argv[2] ?? "").includes("mend-layout"));
          const issued = join.tokenEvents.filter((event) => event.startsWith("issuePerson:"));
          const tokenOf = (account: string) =>
            issued
              .find((event) => event.startsWith(`issuePerson:${join.launchId}:${account}:`))
              ?.split(":")
              .at(-1);
          const launcherToken = tokenOf("user-fixture");
          const joinerToken = tokenOf(MARIA);
          // One token per (launch, person), each minted when its pickup was redeemed.
          expect(issued).toHaveLength(2);
          expect(launcherToken).toBeDefined();
          expect(joinerToken).toBeDefined();
          expect(launcherToken).not.toBe(joinerToken);
          // Each arrived in its own person's home, with their git author beside it.
          const launcherFiles = decoded(join.pickups.written.get(`/home/${LAUNCHER}`));
          const joinerFiles = decoded(join.pickups.written.get(`/home/${JOINER}`));
          expect(launcherFiles.get(`/home/${LAUNCHER}/.mend/session-token`)).toBe(launcherToken);
          expect(joinerFiles.get(`/home/${JOINER}/.mend/session-token`)).toBe(joinerToken);
          // The author, in Mend's own file, which their git config includes at its top.
          expect(launcherFiles.get(`/home/${LAUNCHER}/.mend/git-author`)).toBe(
            '[user]\n\tname = "Account user-fixture"\n\temail = "user-fixture@accounts.example"\n',
          );
          expect(joinerFiles.get(`/home/${JOINER}/.mend/git-author`)).toContain(
            `email = "${MARIA}@accounts.example"`,
          );
          // Neither token nor author ever rides an exec's arguments; only tickets do.
          for (const argv of join.execs) {
            for (const arg of argv) {
              expect(arg).not.toContain(launcherToken ?? "-");
              expect(arg).not.toContain(joinerToken ?? "-");
              expect(arg).not.toContain("accounts.example");
            }
          }
          expect(join.execs.some((argv) => (argv[2] ?? "").includes("--system user.name"))).toBe(
            false,
          );
          // GitHub over HTTPS answers from each user's own login.
          expect(prepare?.[2]).toContain(
            "git config --system credential.https://github.com.helper '/run/mend/bin/mend-git-credential'",
          );
          // Each process names its session and its person's token file.
          const env = (name: string) =>
            join.opened.filter((options) => options.user?.name === name).map((o) => o.env);
          expect(env(LAUNCHER)).toContainEqual(
            expect.objectContaining({
              MEND_SESSION_ID: join.holder.id,
              MEND_SESSION_TOKEN_FILE: `/home/${LAUNCHER}/.mend/session-token`,
            }),
          );
          expect(env(JOINER)).toContainEqual(
            expect.objectContaining({
              MEND_SESSION_ID: join.joined.id,
              MEND_SESSION_TOKEN_FILE: `/home/${JOINER}/.mend/session-token`,
            }),
          );
        }),
    });
  });

  it.each(["person", "shared"] as const)(
    "tells each agent process the id of its own row where it opens, in a %s executor",
    async (flag) => {
      await livePersonJoin({
        flag,
        inspect: (_engine, join) =>
          Effect.sync(() => {
            expect(join.joinFailure).toBeNull();
            const agentOf = (session: Session) =>
              currentAgentProcess(
                [...join.world.processes.values()].filter((row) => row.sessionId === session.id),
              )?.id;
            const named = join.opened.flatMap((options) => {
              const id = options.env?.[MEND_AGENT_PROCESS_ENV];
              return id === undefined ? [] : [id];
            });
            expect(named).toEqual([agentOf(join.holder), agentOf(join.joined)]);
          }),
      });
    },
  );

  it("mints no token for a member prepare does not make; they get theirs at their first process", async () => {
    await livePersonJoin({
      flag: "person",
      mariaKnown: true,
      inspect: (_engine, join) =>
        Effect.sync(() => {
          const prepare = join.execs.find((argv) => (argv[2] ?? "").includes("mend-layout"));
          // Prepare carried Maria's ticket, in case her saved directory came back; it did not,
          // so her ticket was never presented, and the only token she has is her join's.
          expect(identityArgsOf(prepare?.[2] ?? "").map((p) => p.name)).toEqual([LAUNCHER, JOINER]);
          const issued = join.tokenEvents.filter((event) => event.startsWith("issuePerson:"));
          expect(issued.filter((event) => event.includes(`:${MARIA}:`))).toHaveLength(1);
          expect(issued).toHaveLength(2);
        }),
    });
  });

  it("answers a lost identity again to the same channel: the same token, never a second, no theft", async () => {
    await livePersonJoin({
      flag: "person",
      presentTwice: true,
      inspect: (_engine, join) =>
        Effect.sync(() => {
          for (const home of [`/home/${LAUNCHER}`, `/home/${JOINER}`]) {
            expect(decoded(join.pickups.again.get(home))).toEqual(
              decoded(join.pickups.written.get(home)),
            );
          }
          expect(join.pickups.refused.size).toBe(0);
          expect(join.tokenEvents.filter((event) => event.startsWith("issuePerson:"))).toHaveLength(
            2,
          );
        }),
    });
  });

  it.effect(
    "lets a retry that arrives while the first answer is made wait for it: one token, no refusal",
    () =>
      Effect.gen(function* () {
        // The author's read takes 100 ms for Maria: her first request is still being answered when
        // its retry arrives.
        const slow = Layer.succeed(UserGitAuthorRepo, {
          resolve: (userId) =>
            Effect.sleep(userId === MARIA ? "100 millis" : "0 millis").pipe(
              Effect.as(
                new ResolvedGitAuthor({
                  name: `Account ${userId}`,
                  email: `${userId}@accounts.example`,
                  source: "account",
                }),
              ),
            ),
          set: () => Effect.void,
          clear: () => Effect.void,
        });
        const parking = yield* parkingClock;
        /** The engine wrote a log line. */
        const logged = yield* Queue.make<void>();
        const logs = watched<string>(logged);
        yield* livePersonJoinEffect({
          flag: "person",
          gitAuthorLayer: slow,
          presentOverlapping: true,
          logs,
          drive: (pickups) =>
            Effect.gen(function* () {
              // The launcher's own ticket is presented twice as well: the retry's 10 ms, once its
              // first answer (a 0 ms read) is made.
              yield* parking.untilParked(Duration.millis(10));
              yield* TestClock.adjust(Duration.millis(10));
              // Maria's read is under way (its 100 ms parked) and her retry waits out its 10 ms.
              yield* parking.untilParked(Duration.millis(100), Duration.millis(10));
              yield* TestClock.adjust(Duration.millis(10));
              yield* signalled(logged)(
                () =>
                  logs.some((line) => line.includes("pickup asked again while its answer is made")),
                "the retry's arrival while the answer is made",
              );
              // One millisecond short of the read, nothing is answered yet; at it, both are.
              yield* TestClock.adjust(Duration.millis(89));
              expect(pickups.written.has(`/home/${JOINER}`)).toBe(false);
              yield* TestClock.adjust(Duration.millis(1));
            }),
          inspect: (_engine, join) =>
            Effect.sync(() => {
              expect(join.pickups.refused.size).toBe(0);
              expect(decoded(join.pickups.again.get(`/home/${JOINER}`))).toEqual(
                decoded(join.pickups.written.get(`/home/${JOINER}`)),
              );
              expect(
                join.tokenEvents.filter((event) =>
                  event.startsWith(`issuePerson:${join.launchId}:${MARIA}:`),
                ),
              ).toHaveLength(1);
            }),
        }).pipe(Effect.provideService(Clock.Clock, parking.clock));
      }),
  );

  it("forgets an identity answer once its exec has ended: the ticket answers no one after", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const ticket = join.pickups.tickets.get(JOINER) ?? "";
          const grant = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
          if (!grant.ok || grant.api.pickup === undefined) throw new Error("no pickup");
          const late = yield* grant.api.pickup(ticket).pipe(Effect.result);
          expect(late._tag).toBe("Failure");
        }),
    });
  });

  it("puts an identity ticket back when the store fails mid-answer, so the retry redeems it", async () => {
    // The author's read fails once for Maria, as a dropped database connection would.
    let failures = 0;
    const flaky = Layer.succeed(UserGitAuthorRepo, {
      resolve: (userId) =>
        userId === MARIA && failures++ === 0
          ? Effect.die(new Error("Connection terminated unexpectedly"))
          : Effect.succeed(
              new ResolvedGitAuthor({
                name: `Account ${userId}`,
                email: `${userId}@accounts.example`,
                source: "account",
              }),
            ),
      set: () => Effect.void,
      clear: () => Effect.void,
    });
    await livePersonJoin({
      flag: "person",
      gitAuthorLayer: flaky,
      inspect: (_engine, join) =>
        Effect.sync(() => {
          expect(join.pickups.retried).toEqual([JOINER]);
          expect(join.pickups.refused.size).toBe(0);
          expect(join.joinFailure).toBeNull();
          // One token for her: none was minted by the attempt that failed.
          expect(
            join.tokenEvents.filter((event) =>
              event.startsWith(`issuePerson:${join.launchId}:${MARIA}:`),
            ),
          ).toHaveLength(1);
          expect(
            decoded(join.pickups.written.get(`/home/${JOINER}`)).get(
              `/home/${JOINER}/.mend/session-token`,
            ),
          ).toBeDefined();
        }),
    });
  });

  it("refuses a person's identity ticket presented through another person's token", async () => {
    await livePersonJoin({
      flag: "person",
      // Maria's ticket, presented with the launcher's token.
      presentAs: (name) => (name === JOINER ? "user-fixture" : null),
      inspect: (_engine, join) =>
        Effect.sync(() => {
          expect(join.pickups.refused.get(JOINER)).toBe("this pickup ticket is another person's");
          expect(join.pickups.written.has(`/home/${JOINER}`)).toBe(false);
          // Nothing was minted for Maria, and her join stopped rather than run without her token.
          expect(join.tokenEvents.some((event) => event.includes(`:${MARIA}:`))).toBe(false);
          expect(join.joinFailure).toContain("could not be made");
        }),
    });
  });

  it("with the flag off mints no person token, names no token file and keeps the system author", async () => {
    await livePersonJoin({
      flag: "shared",
      inspect: (_engine, join) =>
        Effect.sync(() => {
          expect(join.tokenEvents.some((event) => event.startsWith("issuePerson:"))).toBe(false);
          expect(
            join.opened.some((options) => options.env?.["MEND_SESSION_TOKEN_FILE"] !== undefined),
          ).toBe(false);
          expect(join.execs.some((argv) => (argv[2] ?? "").includes("--system user.name"))).toBe(
            true,
          );
          expect(join.execs.some((argv) => (argv[2] ?? "").includes("mend-git-credential"))).toBe(
            false,
          );
        }),
    });
  });

  it("a joiner's push signs as the joiner, with their own Mend key", async () => {
    const keysAsked: Array<string> = [];
    await livePersonJoin({
      flag: "person",
      gitAuthMode: "mend-key",
      keysAsked,
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const grant = yield* grantOf(join.joined, { launchId: join.launchId, accountId: MARIA });
          if (!grant.ok) throw new Error(grant.message);
          keysAsked.length = 0;
          const plan = yield* grant.api.gitTransport(push(join.origin));
          expect(keysAsked).toEqual([MARIA]);
          expect(plan.argv).toContain(`/keys/${MARIA}`);
          expect(plan.argv).not.toContain("/keys/user-fixture");
          // Steering Alice's session from her own process (shared control on), Maria still signs
          // as Maria: the token says who pushes, not the session.
          const steered = yield* grantOf(shareControl(join.world, join.holder), {
            launchId: join.launchId,
            accountId: MARIA,
          });
          if (!steered.ok) throw new Error(steered.message);
          keysAsked.length = 0;
          expect((yield* steered.api.gitTransport(push(join.origin))).argv).toContain(
            `/keys/${MARIA}`,
          );
          expect(keysAsked).toEqual([MARIA]);
          // The launcher's own push in the same executor still signs as the launcher.
          const own = yield* grantOf(join.holder, {
            launchId: join.launchId,
            accountId: "user-fixture",
          });
          if (!own.ok) throw new Error(own.message);
          expect((yield* own.api.gitTransport(push(join.origin))).argv).toContain(
            "/keys/user-fixture",
          );
        }),
    });
  });

  it("the agent's own Stop, run and restart through its person's token never decide the preview", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (engine, join) =>
        Effect.gen(function* () {
          const owner = join.holder.ownerUserId;
          if (owner === null) throw new Error("the holder has no owner");
          const grant = yield* grantOf(join.holder, { launchId: join.launchId, accountId: owner });
          if (!grant.ok) throw new Error(grant.message);
          yield* grant.api.runService(["pnpm", "dev"], 3000, "web", "tcp", "http");
          const service = [...join.world.services.values()].find(
            (candidate) => candidate.sessionId === join.holder.id && candidate.name === "web",
          );
          if (service === undefined) throw new Error("the agent's run made no Service");
          const preview: Preview = {
            id: PreviewId.make("preview-web"),
            projectId: join.holder.projectId,
            worktreeId: join.holder.worktreeId,
            serviceName: "web",
            label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
            state: "kept",
            scope: "worktree",
          };
          join.world.previews.set(preview.id, preview);
          const control = () => join.world.previewControls.get(preview.id);

          yield* grant.api.stopService(service.id);
          expect(control(), "the agent's Stop under its person's token").toBeUndefined();

          yield* engine.stopService(service.id, { kind: "person", userId: owner });
          const stopped = control();
          expect(stopped, "the person's Stop").toMatchObject({ _tag: "Stopped" });
          yield* grant.api.runService(["pnpm", "dev"], 3000, "web", "tcp", "http");
          yield* grant.api.restartService(service.id);
          expect(control(), "the agent's run and restart leave the person's Stop").toEqual(stopped);
        }),
    });
  });

  it("a joiner's push signs as the joiner over their own bridge", async () => {
    const bridgeAsked: Array<string> = [];
    await livePersonJoin({
      flag: "person",
      gitAuthMode: "bridge",
      bridgeAsked,
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const grant = yield* grantOf(shareControl(join.world, join.holder), {
            launchId: join.launchId,
            accountId: MARIA,
          });
          if (!grant.ok) throw new Error(grant.message);
          bridgeAsked.length = 0;
          const plan = yield* grant.api.gitTransport(push(join.origin));
          expect(plan.env).toEqual({ SSH_AUTH_SOCK: `/bridge/${MARIA}.sock` });
          expect(bridgeAsked).toEqual([`status:${MARIA}`, `begin:${MARIA}`]);
        }),
    });
  });

  it("refuses the workspace's own token for git and the helper in a person executor, and keeps its capture routes", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const grant = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
          if (!grant.ok) throw new Error(grant.message);
          expect(grant.api.capture).toBeDefined();
          // Its launch's pickups stay: every workspace write and identity arrives through one.
          expect(grant.api.pickup).toBeDefined();
          const refused = yield* grant.api.gitTransport(push(join.origin)).pipe(Effect.exit);
          expect(failureText(refused)).toContain(CONTAINER_TOKEN_REFUSED);
          expect(failureText(yield* grant.api.land().pipe(Effect.exit))).toContain(
            CONTAINER_TOKEN_REFUSED,
          );
          expect(failureText(yield* grant.api.listServices().pipe(Effect.exit))).toContain(
            CONTAINER_TOKEN_REFUSED,
          );
          expect(failureText(yield* grant.api.agentHook(STOP_HOOK).pipe(Effect.exit))).toContain(
            CONTAINER_TOKEN_REFUSED,
          );
        }),
    });
  });

  it("answers Mend's MCP server as the person a person executor's token names, and never the workspace's own token there", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const own = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
          if (!own.ok) throw new Error(own.message);
          const refused = yield* own.api.mcpCaller(null).pipe(Effect.exit);
          expect(failureText(refused)).toContain(CONTAINER_TOKEN_REFUSED);
          const maria = yield* grantOf(shareControl(join.world, join.holder), {
            launchId: join.launchId,
            accountId: MARIA,
          });
          if (!maria.ok) throw new Error(maria.message);
          expect(yield* maria.api.mcpCaller(null)).toEqual({
            sessionId: join.holder.id,
            accountId: MARIA,
            agentProcess: null,
          });
        }),
    });
  });

  describe("keeping the MCP sign-ins a process saw (docs/adr/0024)", () => {
    const FIGMA = {
      serverName: "figma",
      serverUrl: "https://mcp.figma.com/mcp",
      accessToken: "access-SECRET",
      expiresAt: 2_000,
    };
    const harvested: HarvestedSignIns = {
      entries: [
        {
          key: "figma|0123456789abcdef",
          serverName: FIGMA.serverName,
          serverUrl: FIGMA.serverUrl,
          expiresAt: new Date(FIGMA.expiresAt),
          document: JSON.stringify(FIGMA),
        },
      ],
      readAt: null,
    };
    it("credits the person the process runs as, sealed, and loses to a Forget made after the process started", async () => {
      const kept: Array<{ accountId: string; observed: McpSignInObserved }> = [];
      await livePersonJoin({
        flag: "person",
        mcpServersLayer: signInsKept(kept, new Date(8_640_000_000_000_000)),
        inspect: (_engine, join) =>
          Effect.gen(function* () {
            const agent = agentProcessOf(join.world, join.holder);
            const maria = yield* grantOf(shareControl(join.world, join.holder), {
              launchId: join.launchId,
              accountId: MARIA,
            });
            if (!maria.ok) throw new Error(maria.message);
            expect(yield* maria.api.keepMcpSignIns(agent.id, harvested)).toEqual({
              _tag: "Kept",
              outcomes: [{ key: "figma|0123456789abcdef", kept: "reset" }],
            });
            expect(kept).toEqual([
              {
                accountId: MARIA,
                observed: expect.objectContaining({
                  key: "figma|0123456789abcdef",
                  processStartedAt: agent.createdAt,
                }),
              },
            ]);
            expect(kept[0]?.observed.sealed).toBe(`sealed:${JSON.stringify(FIGMA)}`);
            const readAt = new Date(agent.createdAt.getTime() - 60_000);
            yield* maria.api.keepMcpSignIns(agent.id, { ...harvested, readAt });
            expect(kept[1]?.observed.processStartedAt).toEqual(readAt);
            const own = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
            if (!own.ok) throw new Error(own.message);
            expect(
              failureText(yield* own.api.keepMcpSignIns(agent.id, harvested).pipe(Effect.exit)),
            ).toContain(CONTAINER_TOKEN_REFUSED);
          }),
      });
    });

    it("keeps nothing from a shared home's once-shared conversation, nor from a process it cannot name", async () => {
      const kept: Array<{ accountId: string; observed: McpSignInObserved }> = [];
      await livePersonJoin({
        flag: "shared",
        mcpServersLayer: signInsKept(kept, new Date(0)),
        inspect: (_engine, join) =>
          Effect.gen(function* () {
            const own = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
            if (!own.ok) throw new Error(own.message);
            const agent = agentProcessOf(join.world, join.holder);
            expect(yield* own.api.keepMcpSignIns(null, harvested)).toMatchObject({
              _tag: "Refused",
            });
            expect(yield* own.api.keepMcpSignIns(agent.id, harvested)).toEqual({
              _tag: "Refused",
              why: SIGN_INS_ONLY_IN_OWN_HOME,
            });
            const terminal = new SessionProcess({ ...agent, kind: "agent-pty" });
            join.world.processes.set(agent.id, terminal);
            expect(yield* own.api.keepMcpSignIns(agent.id, harvested)).toEqual({
              _tag: "Refused",
              why: SIGN_INS_ONLY_IN_OWN_HOME,
            });
            expect(kept).toEqual([]);
          }),
      });
    });
  });

  it("answers Mend's MCP server as the session's owner for a shared executor's own token", async () => {
    await livePersonJoin({
      flag: "shared",
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const own = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
          if (!own.ok) throw new Error(own.message);
          expect(yield* own.api.mcpCaller(null)).toEqual({
            sessionId: join.holder.id,
            accountId: join.holder.ownerUserId,
            agentProcess: null,
          });
          expect(join.holder.ownerUserId).toBe("user-fixture");
        }),
    });
  });

  it("a shared executor's push with the workspace's token still works, as its owner", async () => {
    const keysAsked: Array<string> = [];
    await livePersonJoin({
      flag: "shared",
      gitAuthMode: "mend-key",
      keysAsked,
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const grant = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
          if (!grant.ok) throw new Error(grant.message);
          expect(grant.api.capture).toBeDefined();
          keysAsked.length = 0;
          const plan = yield* grant.api.gitTransport(push(join.origin));
          expect(plan.argv).toContain("/keys/user-fixture");
          expect(keysAsked).toEqual(["user-fixture"]);
          // No person token is ever good in a shared executor.
          const person = yield* grantOf(join.holder, {
            launchId: join.launchId,
            accountId: "user-fixture",
          });
          expect(person.ok).toBe(false);
        }),
    });
  });

  it("with the flag off, a launch, a join and every push or fetch read no layout from the store", async () => {
    const reads: Array<string> = [];
    await livePersonJoin({
      flag: "shared",
      launchLayoutReads: reads,
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const before = reads.length;
          for (let i = 0; i < 5; i++) {
            const grant = yield* grantOf(join.holder, { launchId: join.launchId, accountId: null });
            if (!grant.ok) throw new Error(grant.message);
            yield* grant.api.gitTransport(push(join.origin)).pipe(Effect.exit);
          }
          // Five git ops, and no read; nor did the launch, the join or any process start read
          // one: nothing was recorded when Mend started, and the flag is off.
          expect(reads.length - before).toBe(0);
          expect(reads).toEqual([]);
        }),
    });
  });

  it("a person's token works only for sessions live in its launch that they may act on", async () => {
    await livePersonJoin({
      flag: "person",
      // Maria's own session in another worktree is a second executor.
      onePlatformUser: true,
      inspect: (engine, join) =>
        Effect.gen(function* () {
          // Maria may not act on Alice's session while shared control is off.
          const notHers = yield* grantOf(join.holder, {
            launchId: join.launchId,
            accountId: MARIA,
          });
          expect(notHers).toMatchObject({ ok: false, status: 403 });
          // Her own session in another worktree runs in another executor: this launch's token
          // reaches nothing there.
          const own = yield* engine.provision({
            projectId: join.holder.projectId,
            harness: "claude",
            label: null,
            name: "maria-own",
            ownerUserId: MARIA,
            start: { kind: "base", base: null },
          });
          yield* engine.launch(own.id, ["claude"]);
          const elsewhere = yield* grantOf(own, { launchId: join.launchId, accountId: MARIA });
          expect(elsewhere).toMatchObject({ ok: false, status: 409 });
          // A token of a launch Mend never made person is not accepted at all.
          const unknown = yield* grantOf(join.joined, {
            launchId: "launch-elsewhere",
            accountId: MARIA,
          });
          expect(unknown).toMatchObject({ ok: false, status: 401 });
          // And a person's token never reaches the capture routes.
          const hers = yield* grantOf(join.joined, { launchId: join.launchId, accountId: MARIA });
          expect(hers.ok && hers.api.capture === undefined).toBe(true);
          // Removed from the organization mid-launch, her token reaches nothing from then on
          // (review of mend#553, P3-4), not only once the launch ends.
          join.world.members.delete(MARIA);
          const removed = yield* grantOf(join.joined, {
            launchId: join.launchId,
            accountId: MARIA,
          });
          expect(removed).toMatchObject({ ok: false, status: 403 });
        }),
    });
  });

  it("before a joiner's process opens, their token redeems their own deliveries in that executor, and nothing else", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          // As the join's row reads before its process opens: no executor named yet.
          join.world.sessions.set(
            join.joined.id,
            new Session({ ...join.joined, sealantWorkspaceId: null }),
          );
          const before = yield* grantOf(join.joined, { launchId: join.launchId, accountId: MARIA });
          if (!before.ok) throw new Error(before.message);
          expect(before.api.pickup).toBeDefined();
          expect(before.api.capture).toBeUndefined();
          const landed = yield* before.api.land().pipe(Effect.exit);
          expect(Exit.isFailure(landed)).toBe(true);
          const pushed = yield* before.api.gitTransport(push(join.origin)).pipe(Effect.exit);
          expect(Exit.isFailure(pushed)).toBe(true);
          const reported = yield* before.api.agentHook(STOP_HOOK).pipe(Effect.exit);
          expect(Exit.isFailure(reported)).toBe(true);
          // Another launch's token, or another person's, reaches nothing there.
          const elsewhere = yield* grantOf(join.joined, {
            launchId: "launch-elsewhere",
            accountId: MARIA,
          });
          expect(elsewhere.ok).toBe(false);
          const alice = yield* grantOf(join.joined, {
            launchId: join.launchId,
            accountId: "user-fixture",
          });
          expect(alice.ok).toBe(false);
        }),
    });
  });

  it("a joiner's mend land asks as the joiner, and the workspace's land as before", async () => {
    const landings: Array<string> = [];
    await livePersonJoin({
      flag: "person",
      landings,
      inspect: (_engine, join) =>
        Effect.gen(function* () {
          const grant = yield* grantOf(join.joined, { launchId: join.launchId, accountId: MARIA });
          if (!grant.ok) throw new Error(grant.message);
          yield* grant.api.land();
          expect(landings).toEqual([`${join.joined.id}:${MARIA}`]);
        }),
    });
  });

  it("a person's [setup] runs as them with their Service's identity, and reads its inputs as them", async () => {
    const users: Array<string | null> = [];
    await livePersonJoin({
      flag: "person",
      execUsers: users,
      exec: (argv) =>
        argv[2] === WORKSPACE_MEND_TOML_SCRIPT
          ? {
              exitCode: 0,
              stdout:
                'mend.toml\n[setup]\nrun = ["pnpm install"]\ninputs = ["pnpm-lock.yaml"]\n' +
                '[service.web]\ncommand = "pnpm dev"\nport = 3000\n',
              stderr: "",
            }
          : argv.includes("mend-setup-inputs")
            ? { exitCode: 0, stdout: "--mend-setup-inputs--\nabsent\n", stderr: "" }
            : undefined,
      inspect: (engine, join) =>
        Effect.gen(function* () {
          const started = join.opened.length;
          yield* engine.runServiceRecipe(join.joined.id, "web", { kind: "person", userId: MARIA });
          const service = join.opened.at(started);
          const stepAt = join.execs.findIndex((argv) => argv.includes("mend-setup"));
          const inputsAt = join.execs.findIndex((argv) => argv.includes("mend-setup-inputs"));
          expect(service?.user?.name).toBe(JOINER);
          expect(users[inputsAt], "its inputs read as the joiner").toBe(JOINER);
          expect(users[stepAt], "its step run as the joiner").toBe(JOINER);
          const identity = Object.entries(service?.env ?? {})
            .filter(([name]) => name !== "PORT")
            .map(([name, value]) => `${name}=${value}`);
          expect(identity).toContain(`MEND_SESSION_ID=${join.joined.id}`);
          expect(join.execs[stepAt]).toEqual(expect.arrayContaining(identity));
        }),
    });
  });

  it("Mend's restart of a recipe after a turn changed it runs the file as it reads now, as its last starter", async () => {
    let toml = '[service.web]\ncommand = "pnpm dev"\nport = 3000\nenv = { MODE = "first" }\n';
    await livePersonJoin({
      flag: "person",
      exec: (argv) =>
        argv[2] === WORKSPACE_MEND_TOML_SCRIPT
          ? { exitCode: 0, stdout: "mend.toml\n" + toml, stderr: "" }
          : undefined,
      inspect: (engine, join) =>
        Effect.gen(function* () {
          const owner = join.holder.ownerUserId ?? "";
          yield* engine.runServiceRecipe(join.holder.id, "web", { kind: "person", userId: owner });
          yield* engine.stopServices(join.holder.id, { kind: "workspace" });
          toml = toml.replace("pnpm dev", "pnpm dev --edited").replace("first", "edited");

          const started = join.opened.length;
          const view = yield* engine.runServiceRecipe(join.holder.id, "web", {
            kind: "system",
            runsAs: MARIA,
          });
          expect(view.attempts.at(-1)?.argv).toEqual(["sh", "-c", "pnpm dev --edited"]);
          expect(join.opened.at(started)).toMatchObject({
            user: { name: JOINER },
            env: { MODE: "edited", PORT: "3000" },
          });
          expect(join.world.serviceStarters.get(view.service.id), "started_by").toBe(MARIA);
        }),
    });
  });

  it("a shell and a Service run as the person who opened them, and a restart as its starter", async () => {
    await livePersonJoin({
      flag: "person",
      inspect: (engine, join) =>
        Effect.gen(function* () {
          const before = join.opened.length;
          const row = yield* engine.openShell(join.holder.id, MARIA);
          const shell = join.opened.at(before);
          expect(shell?.user?.name).toBe(JOINER);
          // The row says whom it runs as, as an agent's does (box, next.786: it read null).
          expect(row.runsAs).toBe(MARIA);
          expect(shell?.env).toMatchObject({
            MEND_SESSION_ID: join.holder.id,
            MEND_SESSION_TOKEN_FILE: `/home/${JOINER}/.mend/session-token`,
          });
          const started = join.opened.length;
          const service = yield* engine.runService(
            join.holder.id,
            ["pnpm", "dev"],
            3000,
            "web",
            "tcp",
            null,
            { kind: "person", userId: MARIA },
          );
          expect(join.opened.at(started)?.user?.name).toBe(JOINER);
          const restarted = join.opened.length;
          yield* engine.restartService(service.service.id, { kind: "system", runsAs: null });
          expect(join.opened.at(restarted)?.user?.name).toBe(JOINER);
          // Without a starter named, the session's owner, as before.
          const owners = yield* engine.openShell(join.holder.id);
          expect(join.opened.at(-1)?.user?.name).toBe(LAUNCHER);
          expect(owners.runsAs).toBe(join.holder.ownerUserId);
        }),
    });
  });
});

/** `workspacesPerOwner` over `inner`, unless the scenario runs on one platform user. */
const perOwnerUnless = (
  onePlatformUser: boolean | undefined,
  inner: Layer.Layer<SealantClient>,
): Layer.Layer<SealantClient> => (onePlatformUser === true ? inner : workspacesPerOwner(inner, []));
