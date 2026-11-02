import {
  UserDotfilesRepo,
  type HarnessLayoutsMemoryState,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
  piProfileDigest,
  agentMemoryDigest,
} from "@mend/db";
import { SessionId } from "@mend/domain";
import {
  type SessionDotfiles,
  PiProfile,
  Session,
  SessionReferenceMount,
  SessionExtraMount,
} from "@mend/domain/workbench";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  type HomeLogins,
  PersonLayoutPlatform,
  type PersonSessionOptions,
  SealantPlatformError,
} from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { DotfilesStore } from "@mend/store";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, Workspace } from "@sealant/sdk";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { PI_PERSON_SEED } from "../src/harness-seeds.ts";
import {
  BOOTSTRAP_WAIT_BOUND_MS,
  DOTFILES_APPLY_BOUND_MS,
  DOTFILES_LANDED_LATE_WORDS,
  DOTFILES_NOT_PER_PERSON,
  DOTFILES_STILL_APPLYING,
  DOTFILES_STILL_APPLYING_WORDS,
  FIRST_PROCESS_DONE,
  dotfilesRefusalWords,
} from "../src/person-deliveries.ts";
import { ResourceStatusReads } from "../src/resources/status-reads.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { commandOf } from "./engine-person-runtime-fixtures.ts";
import { SNAPSHOT, dotfilesStoreLayer } from "./engine/capture-fixture.ts";
import { signalWrites, signalled } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  launchSkill,
  piProfilesLayerOf,
  sealantLaunchLayer,
  secretFilesLayerOf,
  servedSocketApis,
  setup,
  skillsForLaunchLayer,
  type World,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import { LAYOUT_READY, MARIA, answerLayout, personPlatform } from "./engine/person-fixture.ts";
import { recordedBeforeStart } from "./engine/person-layout-fixture.ts";

/** One person's own memory, as the store holds it (Delivery 15's tests). */
const memoryOf = (userId: string) => {
  const file = {
    path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
    encoding: "utf8",
    contents: `- what ${userId} learned\n`,
  } as const;
  return [{ ...file, digest: agentMemoryDigest(file), updatedBySession: null }];
};

const piFiles = (userId: string) =>
  [
    {
      path: `extensions/${userId}/index.ts`,
      encoding: "utf8",
      contents: `export default () => "${userId}";\n`,
    },
  ] as const;

interface DeliveryRun {
  readonly execs: ReadonlyArray<ReadonlyArray<string>>;
  readonly users: ReadonlyArray<string | null>;
  readonly opened: ReadonlyArray<PersonSessionOptions>;
  readonly created: ReadonlyArray<CreateOptions>;
  readonly calls: ReadonlyArray<string>;
  /** How many execs ran before the join started. */
  readonly cold: number;
  /** Every argv a session was opened with, in order. */
  readonly spawned: ReadonlyArray<ReadonlyArray<string>>;
  readonly noteUsersAtOpen: ReadonlyArray<ReadonlyArray<string | null>>;
}

/** The token file a person's exec names (a one-off write's own), or null. */
const tokenFileNamed = (argv: ReadonlyArray<string>) =>
  argv[3] === "mend-as-person" && (argv[6] ?? "").startsWith("MEND_SESSION_TOKEN_FILE=")
    ? (argv[6] ?? "").slice("MEND_SESSION_TOKEN_FILE=".length)
    : null;

const named = (argv: ReadonlyArray<string>, name: string) => commandOf(argv)[3] === name;

const asWho = (run: DeliveryRun, test: (argv: ReadonlyArray<string>) => boolean) =>
  run.execs.flatMap((argv, index) => (test(argv) ? [run.users[index] ?? null] : []));

const sessionNamed = (argv: ReadonlyArray<string>) =>
  argv[3] === "mend-as-person" ? (argv[5] ?? "").slice("MEND_SESSION_ID=".length) : null;

/** Every opencode scrub a run made: as whom, and of which database. */
const scrubsOf = (run: DeliveryRun) =>
  run.execs.flatMap((argv, index) => {
    const command = commandOf(argv);
    return command[0] === "node" && (command[2] ?? "").includes("mend-scrub")
      ? [{ user: run.users[index] ?? null, database: command[3] ?? "" }]
      : [];
  });

/** A record's text as `personRecordsExec` prints it. */
const printedRecord = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** Whether an exec is an opencode scrub (`OPENCODE_SCRUB_PROGRAM`). */
const isScrub = (argv: ReadonlyArray<string>) => {
  const command = commandOf(argv);
  return command[0] === "node" && (command[2] ?? "").includes("mend-scrub");
};

/**
 * Runs `effect` on a clock that reports every sleep of `millis` armed on it: a start's wait for
 * its person's `install.sh` is its bound (`BOOTSTRAP_WAIT_BOUND_MS`) armed, which nothing else is.
 */
const reportingSleeps =
  (millis: number, sleeps: Queue.Queue<void>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Clock.clockWith((clock) =>
      effect.pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanos: clock.currentTimeNanos,
          sleep: (duration: Parameters<Clock.Clock["sleep"]>[0]) =>
            Effect.suspend(() => {
              if (Duration.toMillis(duration) === millis) Queue.offerUnsafe(sleeps, undefined);
              return clock.sleep(duration);
            }),
        }),
      ),
    );

describe("deliveries per person (docs/adr/0016, Delivery 15)", () => {
  const LAUNCHER = linuxLoginNameOf("user-fixture");
  const JOINER = linuxLoginNameOf(MARIA);
  const P_LAUNCHER = "/workspace/harness-home/people/user-fixture";
  const P_JOINER = `/workspace/harness-home/people/${MARIA}`;
  const people = {
    skillsLayer: skillsForLaunchLayer((ownerUserId) =>
      Effect.succeed({
        user: [
          launchSkill(`own-${ownerUserId ?? "none"}`, `${ownerUserId}'s skill`, {
            scope: "user",
            userId: ownerUserId ?? "missing",
          }),
        ],
        project: [],
      }),
    ),
    secretFilesLayer: secretFilesLayerOf((userId) =>
      Effect.succeed([
        {
          path: `.aws/${userId}`,
          sealedContents: `sealed:${Buffer.from(`${userId}'s key`, "utf8").toString("base64")}`,
        },
      ]),
    ),
    agentMemoryLayer: agentMemoryLayerOf({
      forLaunch: (userId) => Effect.succeed(memoryOf(userId)),
    }),
    piProfilesLayer: piProfilesLayerOf((userId) =>
      Effect.succeed({
        profile: new PiProfile({
          fileCount: 1,
          bytes: piFiles(userId)[0].contents.length,
          extensions: [userId],
          packages: [],
          digest: piProfileDigest(piFiles(userId)),
          revision: 1,
          updatedAt: new Date(0),
        }),
        files: piFiles(userId),
      }),
    ),
  };

  /**
   * Alice launches a session in a person executor and, unless `join` is null, Maria starts one in
   * the same worktree: every exec with the user it ran as.
   */
  interface LaunchAndJoinOptions {
    readonly holderHarness?: string;
    readonly join?: string | null;
    readonly flag?: HarnessLayout;
    readonly platform?: (calls: Array<string>) => Layer.Layer<PersonLayoutPlatform>;
    readonly layers?: Partial<Parameters<typeof withPreparedEngineEffect>[2]>;
    readonly prepareStdout?: string;
    /**
     * What runs once the join's launch returned, before `inspect`: nothing unless a test says. A
     * join's launch leaves only a worktree repair exec forked behind it, which no case reads; a
     * case that waits for something off the launch's path says what, with a signal from it.
     */
    readonly settle?: Effect.Effect<void>;
    /** Runs over the world before the engine is built, after Maria is made a member. */
    readonly prepareWorld?: (world: World) => void;
    /** Answers an exec before the layout's own answer (undefined falls through). */
    readonly exec?: (
      argv: ReadonlyArray<string>,
    ) => { exitCode: number; stdout: string; stderr: string } | undefined;
    /** Answers an exec as an effect, before `exec` (undefined falls through). */
    readonly execEffect?: (
      argv: ReadonlyArray<string>,
    ) =>
      | Effect.Effect<{ exitCode: number; stdout: string; stderr: string }, SealantPlatformError>
      | undefined;
    readonly inspect?: (
      engine: SessionEngine["Service"],
      world: World,
      ids: { readonly holder: SessionId; readonly joined: SessionId | null },
      run: DeliveryRun,
    ) => Effect.Effect<void, unknown>;
    readonly before?: (worktreeId: string) => void;
    readonly state?: HarnessLayoutsMemoryState;
    /** How long a start waits for a person's dotfiles apply; 120 s unless a test says. */
    readonly dotfilesApplyBound?: Duration.Duration;
    /** How long a person's logins stay after their start before the idle check releases them. */
    readonly loginReleaseGrace?: Duration.Duration;
    /** The join itself, when the test drives it (a waited install.sh). */
    readonly joinWith?: (
      engine: SessionEngine["Service"],
      world: World,
      joined: SessionId,
      run: DeliveryRun,
    ) => Effect.Effect<void, unknown>;
    readonly launchWith?: (
      engine: SessionEngine["Service"],
      world: World,
      holder: SessionId,
      run: DeliveryRun,
    ) => Effect.Effect<void, unknown>;
  }
  const launchAndJoinEffect = (options: LaunchAndJoinOptions): Effect.Effect<DeliveryRun> =>
    Effect.gen(function* () {
      const execs: Array<ReadonlyArray<string>> = [];
      const users: Array<string | null> = [];
      const opened: Array<PersonSessionOptions> = [];
      const created: Array<CreateOptions> = [];
      const calls: Array<string> = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      const noteUsersAtOpen: Array<ReadonlyArray<string | null>> = [];
      const run: { cold: number } = { cold: 0 };
      const view = (): DeliveryRun => ({
        execs,
        users,
        opened,
        created,
        calls,
        cold: run.cold,
        spawned,
        noteUsersAtOpen,
      });
      const holderHarness = options.holderHarness ?? "claude";
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: holderHarness,
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            options.before?.(holder.worktreeId);
            if (options.launchWith === undefined) {
              yield* engine.launch(holder.id, [holderHarness]);
            } else {
              yield* options.launchWith(engine, world, holder.id, view());
            }
            run.cold = execs.length;
            let joined: SessionId | null = null;
            if (options.join !== null) {
              const joinHarness = options.join ?? "claude";
              const session = yield* engine.provisionSessionIn(holder.worktreeId, {
                harness: joinHarness,
                label: null,
                ownerUserId: MARIA,
              });
              joined = session.id;
              if (options.joinWith === undefined) {
                yield* engine.launch(session.id, [joinHarness]);
              } else {
                yield* options.joinWith(engine, world, session.id, view());
              }
              yield* options.settle ?? Effect.void;
            }
            yield* (
              options.inspect?.(engine, world, { holder: holder.id, joined }, view()) ?? Effect.void
            );
          }),
        {
          captured: makeMemoryCaptureStore(),
          prepareWorld: (world) => {
            world.members.set(MARIA, "member");
            options.prepareWorld?.(world);
          },
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
            execs,
            undefined,
            {
              execUsers: users,
              beforeOpen: () =>
                noteUsersAtOpen.push(asWho(view(), (argv) => named(argv, "mend-note"))),
              ...(options.execEffect === undefined ? {} : { execEffect: options.execEffect }),
              exec: (argv) =>
                options.exec?.(argv) ?? answerLayout(options.prepareStdout ?? LAYOUT_READY)(argv),
            },
          ),
          harnessLayout: {
            flag: options.flag ?? "person",
            ...(options.state === undefined ? {} : { state: options.state }),
            platform: (options.platform ?? ((log) => personPlatform(log, { person: true })))(calls),
            ...(options.dotfilesApplyBound === undefined
              ? {}
              : { dotfilesApplyBound: options.dotfilesApplyBound }),
            ...(options.loginReleaseGrace === undefined
              ? {}
              : { loginReleaseGrace: options.loginReleaseGrace }),
          },
          ...options.layers,
        },
      );
      return view();
    });

  it.effect(
    "writes the current workspace note as each agent's user on cold and retained launches, never for shells",
    () =>
      Effect.gen(function* () {
        let level: "project" | "worktree" = "project";
        const run = yield* launchAndJoinEffect({
          holderHarness: "shell",
          join: "codex",
          layers: {
            resourceStatus: Layer.mock(ResourceStatusReads, {
              forWorktree: () =>
                Effect.sync(() => [
                  {
                    statusLine: `@db · running · ${level}`,
                    envNames: ["MEND_DB_URL"],
                    available: { name: "db", kind: "Postgres", level, urlName: "MEND_DB_URL" },
                    postgresName: "db",
                  },
                ]),
            }),
          },
          launchWith: (engine, world, holder) =>
            Effect.gen(function* () {
              yield* engine.launch(holder, ["bash"]);
              const session = world.sessions.get(holder);
              if (session === undefined) return yield* Effect.die("no holder");
              world.sessions.set(
                holder,
                new Session({
                  ...session,
                  referenceMounts: [
                    new SessionReferenceMount({
                      name: "effect",
                      mountPath: "/workspace/ref/effect",
                      sha: null,
                    }),
                  ],
                  extraMounts: [
                    new SessionExtraMount({
                      name: "data",
                      hostPath: "/folders/data",
                      mountPath: "/workspace/data",
                      readOnly: true,
                    }),
                  ],
                }),
              );
              level = "worktree";
            }),
        });
        expect(
          run.execs.slice(0, run.cold).filter((argv) => named(argv, "mend-note")),
        ).toHaveLength(0);
        const notes = run.execs.slice(run.cold).filter((argv) => named(argv, "mend-note"));
        expect(notes).toHaveLength(2);
        expect(asWho(run, (argv) => named(argv, "mend-note"))).toEqual([null, JOINER]);
        expect(run.noteUsersAtOpen).toEqual([[], [null, JOINER]]);
        expect(commandOf(notes[1] ?? [])[2]).toContain(`/home/${JOINER}`);
        for (const note of notes) {
          expect(commandOf(note)[4]).toContain("@db · Postgres · worktree · MEND_DB_URL");
          expect(commandOf(note)[4]).toContain("/workspace/ref/effect");
          expect(commandOf(note)[4]).toContain("/workspace/data (read-only)");
        }
        const cold = yield* launchAndJoinEffect({ join: null });
        expect(asWho(cold, (argv) => named(argv, "mend-note"))).toEqual([null, LAUNCHER]);
        expect(cold.noteUsersAtOpen).toEqual([[null, LAUNCHER]]);
        const personal = cold.execs.filter((argv) => named(argv, "mend-note")).at(-1);
        expect(commandOf(personal ?? [])[2]).toContain(`/home/${LAUNCHER}`);
        const shells = yield* launchAndJoinEffect({
          holderHarness: "shell",
          join: "shell",
          launchWith: (engine, _world, holder) =>
            engine.launch(holder, ["bash"]).pipe(Effect.asVoid),
          joinWith: (engine, _world, joined) => engine.launch(joined, ["bash"]).pipe(Effect.asVoid),
        });
        expect(shells.execs.filter((argv) => named(argv, "mend-note"))).toHaveLength(0);
      }),
    30_000,
  );

  it.effect("a failed note write logs and lets cold and retained person agents start", () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const run = yield* launchAndJoinEffect({
        layers: { logs },
        exec: (argv) =>
          named(argv, "mend-note")
            ? { exitCode: 1, stdout: "", stderr: "not writable" }
            : undefined,
      });
      expect(run.opened.filter((options) => options.user?.name === LAUNCHER)).toHaveLength(1);
      expect(run.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
      expect(asWho(run, (argv) => named(argv, "mend-note"))).toEqual([
        null,
        LAUNCHER,
        null,
        JOINER,
      ]);
      expect(
        logs.filter((line) => line.includes("the workspace note was not written")),
      ).toHaveLength(4);
    }),
  );

  it.effect(
    "the launcher's and a joiner's own skills, memory, secret files and shell profile, each as them into their own home",
    () =>
      Effect.gen(function* () {
        let ids: { readonly holder: SessionId; readonly joined: SessionId | null } | null = null;
        const run = yield* launchAndJoinEffect({
          layers: people,
          inspect: (_engine, _world, seen) =>
            Effect.sync(() => {
              ids = seen;
            }),
        });
        if (ids === null) throw new Error("no sessions");
        const { holder, joined } = ids;
        const cold = {
          ...run,
          execs: run.execs.slice(0, run.cold),
          users: run.users.slice(0, run.cold),
        };
        const join = { ...run, execs: run.execs.slice(run.cold), users: run.users.slice(run.cold) };
        // One read of what was delivered before, each as their person.
        expect(asWho(cold, (argv) => (commandOf(argv)[2] ?? "").includes("mend-record"))).toEqual([
          LAUNCHER,
        ]);
        expect(asWho(join, (argv) => (commandOf(argv)[2] ?? "").includes("mend-record"))).toEqual([
          JOINER,
        ]);
        for (const [part, user, home, saved, session] of [
          [cold, LAUNCHER, `/home/${LAUNCHER}`, P_LAUNCHER, holder],
          [join, JOINER, `/home/${JOINER}`, P_JOINER, joined],
        ] as const) {
          // Skills into their own home, kept aside in their own saved directory.
          const skills = part.execs.filter((argv) => named(argv, "mend-skills"));
          expect(skills).toHaveLength(1);
          expect(commandOf(skills[0] ?? [])[4]).toBe(home);
          expect(commandOf(skills[0] ?? [])[5]).toMatch(
            new RegExp(`^${saved}/\\.mend-saved/skills-kept/`),
          );
          expect(asWho(part, (argv) => named(argv, "mend-skills"))).toEqual([user]);
          // Memory into their own saved directory, recorded there, never `.mend` in the shared home.
          const memory = part.execs.filter((argv) => named(argv, "mend-agent-memory"));
          expect(memory.map((argv) => commandOf(argv).slice(4, 6))).toEqual([
            [saved, ".mend-saved/agent-memory-incoming"],
          ]);
          expect(commandOf(memory[0] ?? []).at(-1)).toBe(".mend-saved/agent-memory-delivered.json");
          expect(asWho(part, (argv) => named(argv, "mend-agent-memory"))).toEqual([user]);
          // Secret files as them, speaking for their own session.
          const secrets = part.execs.filter((argv) => named(argv, "mend-secret-files"));
          expect(secrets.length).toBeGreaterThan(0);
          expect(
            asWho(part, (argv) => named(argv, "mend-secret-files")).every((who) => who === user),
          ).toBe(true);
          expect(secrets.map(sessionNamed).every((id) => id === session)).toBe(true);
          // Every file write of theirs lands under their own home or saved directory.
          for (const argv of part.execs.filter((candidate) => named(candidate, "mend-write"))) {
            for (const target of commandOf(argv).slice(5)) {
              expect(
                target.slice(1).startsWith(`${home}/`) || target.slice(1).startsWith(`${saved}/`),
              ).toBe(true);
            }
          }
          // Mend's default shell profile, as them, where nothing is.
          expect(asWho(part, (argv) => named(argv, "mend-write-absent"))).toEqual([user]);
        }
        // Nothing run for Maria's join, as anyone, names Alice's home or saved directory.
        for (const argv of join.execs) {
          expect(argv.join(" ")).not.toContain(`/home/${LAUNCHER}`);
          expect(argv.join(" ")).not.toContain(P_LAUNCHER);
        }
        // Nothing goes into `/root` or the shared harness home: no relocation, no hand-over.
        expect(run.execs.some((argv) => (argv[2] ?? "").includes("memory moved"))).toBe(false);
        expect(
          run.execs.some(
            (argv) =>
              named(argv, "mend-skills") && commandOf(argv)[4] === "/workspace/harness-home",
          ),
        ).toBe(false);
        // No delivery runs as root.
        const deliveryNames = [
          "mend-skills",
          "mend-agent-memory",
          "mend-secret-files",
          "mend-pi-profile",
          "mend-write",
          "mend-write-absent",
        ];
        run.execs.forEach((argv, index) => {
          const delivery =
            deliveryNames.some((name) => named(argv, name)) ||
            (commandOf(argv)[2] ?? "").includes("mend-record");
          if (delivery) expect(run.users[index]).not.toBeNull();
        });
      }),
  );

  /**
   * mend#597 review, finding 2: a paste was written as root, through a link, into the shared
   * harness home. In a person executor it is written as its sender, into their own saved
   * directory and kept inside it; a shared executor still writes it as root, kept inside the
   * harness home.
   */
  describe("a pasted image", () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    const pastes = (run: DeliveryRun, from: number) =>
      run.execs.flatMap((argv, index) => {
        const command = commandOf(argv);
        // Past the ticket (`command[4]`), which may itself start with a `C`.
        const marker = command.findIndex((part, at) => at > 4 && part.startsWith("C"));
        return index >= from && command[3] === "mend-write" && marker > 4
          ? [
              {
                user: run.users[index] ?? null,
                within: command[marker],
                path: command[marker + 1],
                session: sessionNamed(argv),
              },
            ]
          : [];
      });

    it.effect("is written as whoever pasted it, into their own saved directory", () =>
      Effect.gen(function* () {
        let seen: {
          readonly holder: SessionId;
          readonly from: number;
          readonly own: string;
          readonly steered: string;
        } | null = null;
        const run = yield* launchAndJoinEffect({
          join: null,
          inspect: (engine, _world, ids, current) =>
            Effect.gen(function* () {
              const from = current.execs.length;
              const own = yield* engine.storePastedImage(ids.holder, PNG, "user-fixture");
              // Maria has run nothing here yet: she is made first, as her first process would be.
              const steered = yield* engine.storePastedImage(ids.holder, PNG, MARIA);
              seen = { holder: ids.holder, from, own: own.path, steered: steered.path };
            }),
        });
        if (seen === null) throw new Error("nothing pasted");
        const { holder, from, own, steered } = seen;
        expect(own).toMatch(new RegExp(`^${P_LAUNCHER}/paste/\\d{8}-\\d{6}-\\w{4}\\.png$`));
        expect(steered).toMatch(new RegExp(`^${P_JOINER}/paste/\\d{8}-\\d{6}-\\w{4}\\.png$`));
        expect(pastes(run, from)).toEqual([
          { user: LAUNCHER, within: `C700:600:${P_LAUNCHER}`, path: own, session: holder },
          { user: JOINER, within: `C700:600:${P_JOINER}`, path: steered, session: holder },
        ]);
        // Maria's user and home were made before her paste, by root, as prepare makes anyone.
        expect(
          run.execs
            .slice(from)
            .some(
              (argv) => (argv[2] ?? "").includes("mend_person") && argv.join(" ").includes(JOINER),
            ),
        ).toBe(true);
      }),
    );

    /**
     * mend#615 review, finding 3: a first paste ran a person's whole first start (their logins
     * written, their deliveries) though no process of theirs ever ran, and nothing released it. A
     * paste makes only their user and home, with a Mend token of the write's own, in a file of its
     * own that the write's exec names, and that token, exactly, is revoked when the write ends,
     * placed or refused (review 2, 615-r2-2 and 615-r2-3). The home exec here redeems its ticket
     * over the session's channel, as the executor's root does.
     */
    it.effect.each([
      { write: "placed", fails: false },
      { write: "refused", fails: true },
    ])(
      "makes only a first sender's user, home and a token of the write's own, and revokes exactly it, the write $write",
      ({ fails }) =>
        Effect.gen(function* () {
          const tokenEvents: Array<string> = [];
          let holder: SessionId | null = null;
          let seen: { readonly from: number; readonly outcome: string } | null = null;
          const run = yield* launchAndJoinEffect({
            join: null,
            layers: { tokenEvents },
            execEffect: (argv) => {
              const ticket = /write token[\s\S]*-- '([A-Za-z0-9_-]{43})'/.exec(argv[2] ?? "")?.[1];
              if (ticket === undefined || holder === null) return undefined;
              const pickup = servedSocketApis.get(holder)?.pickup;
              if (pickup === undefined) return undefined;
              return pickup(ticket).pipe(
                Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
                Effect.orDie,
              );
            },
            exec: (argv) =>
              fails &&
              named(argv, "mend-write") &&
              argv.some((part) => part.startsWith(`C700:600:${P_JOINER}`))
                ? { exitCode: 3, stdout: "", stderr: "mend-write: not written\n" }
                : undefined,
            inspect: (engine, world, ids, current) =>
              Effect.gen(function* () {
                holder = ids.holder;
                const from = current.execs.length;
                const processes = world.processes.size;
                const placed = yield* engine
                  .storePastedImage(ids.holder, PNG, MARIA)
                  .pipe(Effect.result);
                expect(world.processes.size).toBe(processes);
                seen = { from, outcome: placed._tag };
              }),
          });
          if (seen === null) throw new Error("nothing pasted");
          const { from, outcome } = seen;
          expect(outcome).toBe(fails ? "Failure" : "Success");
          const after: DeliveryRun = {
            ...run,
            execs: run.execs.slice(from),
            users: run.users.slice(from),
          };
          // No login of Maria's was written, and nothing was delivered to her: the one exec as her is
          // the write itself.
          expect(run.calls.some((call) => call.startsWith(`post:${MARIA}:`))).toBe(false);
          expect(asWho(after, () => true).filter((who) => who === JOINER)).toEqual([JOINER]);
          expect(asWho(after, (argv) => named(argv, "mend-write"))).toEqual([JOINER]);
          // Her user and home were made by root, once, with the write's token file; the write's exec
          // names that file.
          const homes = after.execs.filter(
            (argv) => (argv[2] ?? "").includes("mend_person") && argv.join(" ").includes(JOINER),
          );
          expect(homes).toHaveLength(1);
          const [write] = after.execs.filter((argv) => named(argv, "mend-write"));
          const file = tokenFileNamed(write ?? []);
          expect(file).toMatch(/^\/run\/mend\/write-tokens\/[0-9]{13}-[0-9a-f]{32}$/);
          expect(homes[0]?.[2]).toContain(`'${file?.slice("/run/mend/write-tokens/".length)}'`);
          // One token minted for Maria, and exactly that one revoked; nobody's else, and no bulk
          // revocation of hers.
          const minted = tokenEvents.flatMap((event) => {
            const match = new RegExp(`^issueWrite:.+:${MARIA}:([^:]+)$`).exec(event);
            return match?.[1] === undefined ? [] : [match[1]];
          });
          expect(minted).toHaveLength(1);
          expect(tokenEvents.filter((event) => event.startsWith("revokeToken:"))).toEqual([
            `revokeToken:${minted[0]}`,
          ]);
          expect(tokenEvents.some((event) => event.startsWith("revokePerson:"))).toBe(false);
        }),
    );

    it.effect(
      "leaves a sender's first start whole: their join after a paste is made and delivered to as a first one",
      () =>
        Effect.gen(function* () {
          let pasted = 0;
          const run = yield* launchAndJoinEffect({
            layers: people,
            joinWith: (engine, world, joined, current) =>
              Effect.gen(function* () {
                // Maria pastes into Alice's live session before she starts anything here.
                const holder = [...world.sessions.values()].find(
                  (session) => session.ownerUserId === "user-fixture",
                );
                if (holder === undefined) throw new Error("no holder");
                yield* engine.storePastedImage(holder.id, PNG, MARIA);
                pasted = current.execs.length;
                yield* engine.launch(joined, ["claude"]);
              }),
          });
          const joinPart: DeliveryRun = {
            ...run,
            execs: run.execs.slice(pasted),
            users: run.users.slice(pasted),
          };
          // Her join made her again (a new token) and ran her first-process deliveries as her.
          expect(
            joinPart.execs.some(
              (argv) => (argv[2] ?? "").includes("mend_person") && argv.join(" ").includes(JOINER),
            ),
          ).toBe(true);
          for (const delivery of ["mend-skills", "mend-secret-files", "mend-write-absent"]) {
            expect(asWho(joinPart, (argv) => named(argv, delivery))).toContain(JOINER);
          }
          expect(run.calls).toContain(`post:${MARIA}:/home/${JOINER}`);
        }),
    );

    it.effect("is written as root, inside the harness home, in a shared executor", () =>
      Effect.gen(function* () {
        let seen: { readonly from: number; readonly path: string } | null = null;
        const run = yield* launchAndJoinEffect({
          flag: "shared",
          join: null,
          inspect: (engine, _world, ids, current) =>
            Effect.gen(function* () {
              const from = current.execs.length;
              const placed = yield* engine.storePastedImage(ids.holder, PNG, MARIA);
              seen = { from, path: placed.path };
            }),
        });
        if (seen === null) throw new Error("nothing pasted");
        const { from, path: placed } = seen;
        expect(placed).toMatch(/^\/workspace\/harness-home\/paste\/\d{8}-\d{6}-\w{4}\.png$/);
        expect(pastes(run, from)).toEqual([
          { user: null, within: "C755:644:/workspace/harness-home", path: placed, session: null },
        ]);
      }),
    );
  });

  /**
   * An executor's people's saved directories as the delivery program leaves them: each delivery
   * exec records what it delivered, every path in place, and the records exec reads it back.
   */
  const savedMemory = () => {
    const delivered = new Map<string, { record: string; present: string }>();
    return (
      argv: ReadonlyArray<string>,
    ): { exitCode: number; stdout: string; stderr: string } | undefined => {
      const command = commandOf(argv);
      if (command[3] === "mend-agent-memory") {
        const listed: ReadonlyArray<{ readonly path: string; readonly digest: string }> =
          JSON.parse(command[7] ?? "[]");
        delivered.set(command[4] ?? "", {
          record: JSON.stringify(
            Object.fromEntries(listed.map((file) => [file.path, file.digest])),
            null,
            2,
          ),
          present: listed.map((file) => file.path).join("\n"),
        });
        return {
          exitCode: 0,
          stdout: listed.map((file) => `memory written ${file.path}\n`).join(""),
          stderr: "",
        };
      }
      const script = command[2] ?? "";
      if (!script.includes("mend-record")) return undefined;
      const saved = [...delivered.keys()].find((dir) => script.includes(`ms='${dir}'`));
      const found = saved === undefined ? undefined : delivered.get(saved);
      return {
        exitCode: 0,
        stdout:
          found === undefined
            ? ""
            : `mend-record memory-delivered ${printedRecord(found.record)}\nmend-record memory-present ${printedRecord(found.present)}\n`,
        stderr: "",
      };
    };
  };

  /** Alice's second session in her own live executor: the execs and writes of that join alone. */
  const joinSameAlice = (layers: Partial<Parameters<typeof withEngine>[1]>) =>
    Effect.gen(function* () {
      let from = 0;
      const run = yield* launchAndJoinEffect({
        join: null,
        layers,
        exec: savedMemory(),
        inspect: (engine, world, ids, seen) =>
          Effect.gen(function* () {
            const holder = world.sessions.get(ids.holder);
            if (holder === undefined) throw new Error("no holder");
            from = seen.execs.length;
            const second = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(second.id, ["claude"]);
          }),
      });
      const cold = { ...run, execs: run.execs.slice(0, from), users: run.users.slice(0, from) };
      const join = { ...run, execs: run.execs.slice(from), users: run.users.slice(from) };
      /** Every write of staged memory: under `P`'s incoming directory. */
      const staged = (part: DeliveryRun) =>
        part.execs.filter(
          (argv) =>
            named(argv, "mend-write") &&
            commandOf(argv).some((target) => target.includes("agent-memory-incoming")),
        );
      return { cold, join, staged };
    });

  it.effect("a same-person join with their memory unchanged stages and runs nothing for it", () =>
    Effect.gen(function* () {
      const { cold, join, staged } = yield* joinSameAlice(people);
      // The launch delivered it; the join read the one record it reads anyway, and stopped there.
      expect(asWho(cold, (argv) => named(argv, "mend-agent-memory"))).toEqual([LAUNCHER]);
      expect(staged(cold)).toHaveLength(1);
      expect(asWho(join, (argv) => (commandOf(argv)[2] ?? "").includes("mend-record"))).toEqual([
        LAUNCHER,
      ]);
      expect(join.execs.filter((argv) => named(argv, "mend-agent-memory"))).toEqual([]);
      expect(staged(join)).toEqual([]);
      // Its other deliveries still run: the secret files, as Alice.
      expect(asWho(join, (argv) => named(argv, "mend-secret-files"))).toContain(LAUNCHER);
    }),
  );

  it.effect(
    "a same-person join delivers their memory when the store changed it since their last start",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const { join, staged } = yield* joinSameAlice({
          ...people,
          agentMemoryLayer: agentMemoryLayerOf({
            forLaunch: (userId) =>
              Effect.sync(() => {
                reads += 1;
                if (reads === 1) return memoryOf(userId);
                const file = {
                  path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
                  encoding: "utf8",
                  contents: `- what ${userId} learned\n- and read back since\n`,
                } as const;
                return [{ ...file, digest: agentMemoryDigest(file), updatedBySession: null }];
              }),
          }),
        });
        const memory = join.execs.filter((argv) => named(argv, "mend-agent-memory"));
        expect(memory.map((argv) => commandOf(argv)[4])).toEqual([P_LAUNCHER]);
        expect(asWho(join, (argv) => named(argv, "mend-agent-memory"))).toEqual([LAUNCHER]);
        expect(staged(join)).toHaveLength(1);
      }),
  );

  it.effect(
    "another person's join delivers their own memory, into their own P, beside Alice's in place",
    () =>
      Effect.gen(function* () {
        const run = yield* launchAndJoinEffect({ layers: people, exec: savedMemory() });
        const join = run.execs.slice(run.cold);
        const memory = join.flatMap((argv, index) =>
          named(argv, "mend-agent-memory")
            ? [{ saved: commandOf(argv)[4], user: run.users[run.cold + index] ?? null }]
            : [],
        );
        expect(memory).toEqual([{ saved: P_JOINER, user: JOINER }]);
        const list =
          commandOf(join.find((argv) => named(argv, "mend-agent-memory")) ?? [])[7] ?? "";
        expect(JSON.parse(list)).toEqual([
          {
            path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
            digest: memoryOf(MARIA)[0]?.digest,
          },
        ]);
        for (const argv of join) expect(argv.join(" ")).not.toContain(P_LAUNCHER);
      }),
  );

  it.effect(
    "two people's pi profiles live in one executor: Maria's own is delivered beside Alice's live pi",
    () =>
      Effect.gen(function* () {
        const run = yield* launchAndJoinEffect({ holderHarness: "pi", join: "pi", layers: people });
        const pi = run.execs.flatMap((argv, index) =>
          named(argv, "mend-pi-profile")
            ? [{ home: commandOf(argv)[4], user: run.users[index] ?? null }]
            : [],
        );
        expect(pi).toEqual([
          { home: `/home/${LAUNCHER}`, user: LAUNCHER },
          { home: `/home/${JOINER}`, user: JOINER },
        ]);
        // Each profile's files are written as its person, into their own home only.
        const writes = run.execs.flatMap((argv, index) =>
          named(argv, "mend-write") &&
          commandOf(argv).some((part) => part.includes("/.pi/agent/mend/profile/"))
            ? [{ user: run.users[index] ?? null, targets: commandOf(argv).slice(5) }]
            : [],
        );
        expect(writes.map((write) => write.user)).toEqual([LAUNCHER, JOINER]);
        expect(writes[0]?.targets.every((target) => target.includes(`/home/${LAUNCHER}/`))).toBe(
          true,
        );
        expect(writes[1]?.targets.every((target) => target.includes(`/home/${JOINER}/`))).toBe(
          true,
        );
        expect(writes[1]?.targets.some((target) => target.includes(`extensions/${MARIA}/`))).toBe(
          true,
        );
      }),
  );

  it.effect(
    "pi in a person executor starts behind no ChatGPT copy of Mend's: Core writes pi's login, in each person's one call (sealant#336)",
    () =>
      Effect.gen(function* () {
        const posts: Array<{ readonly onBehalfOf: string; readonly logins: HomeLogins }> = [];
        const run = yield* launchAndJoinEffect({
          holderHarness: "pi",
          join: "pi",
          layers: people,
          platform: (calls) =>
            Layer.effect(
              PersonLayoutPlatform,
              Effect.map(PersonLayoutPlatform, (inner) => ({
                ...inner,
                postCredentials: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.postCredentials>[1],
                ) => {
                  posts.push({ onBehalfOf: input.onBehalfOf, logins: input.logins });
                  return inner.postCredentials(workspace, input);
                },
              })),
            ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
        });
        const piStarts = run.spawned.filter((argv) => argv.includes("pi"));
        expect(piStarts).toHaveLength(2);
        for (const argv of piStarts) expect(argv[2]).toBe(PI_PERSON_SEED);
        // The launcher's create wrote the rest; each person's pi asks Core once, pi's login named.
        expect(posts.map((post) => [post.onBehalfOf, post.logins.pi])).toEqual([
          ["user-fixture", true],
          [MARIA, true],
        ]);
      }),
  );

  it.effect(
    "two people's agents in one executor each get their own person's other agent login, into their own home only; a person's choice of their selected agent's login only narrows theirs",
    () =>
      Effect.gen(function* () {
        const runWith = (selectedOnly: ReadonlySet<string>) =>
          Effect.gen(function* () {
            const posts: Array<{
              readonly onBehalfOf: string;
              readonly home: string;
              readonly logins: HomeLogins;
            }> = [];
            const launched = yield* launchAndJoinEffect({
              holderHarness: "claude",
              join: "codex",
              layers: { selectedOnly },
              platform: (calls) =>
                Layer.effect(
                  PersonLayoutPlatform,
                  Effect.map(PersonLayoutPlatform, (inner) => ({
                    ...inner,
                    postCredentials: (
                      workspace: Workspace,
                      input: Parameters<typeof inner.postCredentials>[1],
                    ) => {
                      posts.push({
                        onBehalfOf: input.onBehalfOf,
                        home: input.home,
                        logins: input.logins,
                      });
                      return inner.postCredentials(workspace, input);
                    },
                  })),
                ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
            });
            return { posts, created: launched.created };
          });

        const everyone = yield* runWith(new Set());
        // Alice's create, made as her: her Claude, her own Codex and GitHub, into her home.
        expect(everyone.created.map((options) => options.credentials)).toEqual([
          { claude: true, codex: true, github: true },
        ]);
        // Maria's one call: her Codex, her own Claude and GitHub, into her home, as her. Nothing of
        // Alice's is written for her, and nothing of hers into Alice's home.
        expect(everyone.posts).toEqual([
          {
            onBehalfOf: MARIA,
            home: `/home/${JOINER}`,
            logins: { codex: true, claude: true, github: true },
          },
        ]);

        const narrowed = yield* runWith(new Set([MARIA]));
        expect(narrowed.created.map((options) => options.credentials)).toEqual([
          { claude: true, codex: true, github: true },
        ]);
        expect(narrowed.posts).toEqual([
          { onBehalfOf: MARIA, home: `/home/${JOINER}`, logins: { codex: true, github: true } },
        ]);
      }),
  );

  it.effect(
    "a joiner's dotfiles Core refuses are recorded not applied in Mend's words, and their agent starts (sealant#334)",
    () =>
      Effect.gen(function* () {
        let recorded: SessionDotfiles | null = null;
        const refusal = new SealantPlatformError({
          code: "home-mismatch",
          status: 409,
          message: "the home is not the user's passwd home",
          cause: null,
        });
        const run = yield* launchAndJoinEffect({
          platform: (calls) =>
            Layer.effect(
              PersonLayoutPlatform,
              Effect.map(PersonLayoutPlatform, (inner) => ({
                ...inner,
                applyDotfiles: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.applyDotfiles>[1],
                ) =>
                  input.user.name === JOINER
                    ? Effect.fail(refusal)
                    : inner.applyDotfiles(workspace, input),
              })),
            ).pipe(
              Layer.provide(personPlatform(calls, { person: true }, { bootstrapEnds: () => null })),
            ),
          layers: {
            dotfilesStoreLayer: dotfilesStoreLayer(() =>
              Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
            ),
          },
          inspect: (_engine, world, ids) =>
            Effect.sync(() => {
              recorded =
                ids.joined === null ? null : (world.sessions.get(ids.joined)?.dotfiles ?? null);
            }),
        });
        expect(run.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
        expect(recorded).toEqual({
          repository: null,
          snapshotSha: SNAPSHOT.sha,
          notApplied: [{ source: "snapshot", reason: dotfilesRefusalWords(refusal) }],
        });
        expect(dotfilesRefusalWords(refusal)).toBe(
          "the home Mend named is not your user's home in this workspace, so they were not applied",
        );
      }),
  );

  it.effect(
    "an opencode's in-app logins are scrubbed as its person before it starts and after it ends",
    () =>
      Effect.gen(function* () {
        const scrubs = yield* Queue.make<void>();
        const run = yield* launchAndJoinEffect({
          holderHarness: "opencode",
          join: null,
          // Her restored database is the one her opencode opens: scrubbed once, before it starts.
          prepareStdout: `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout opencode ${LAUNCHER}\nmend-layout ready\n`,
          execEffect: (argv) => {
            if (isScrub(argv)) Queue.offerUnsafe(scrubs, undefined);
            return undefined;
          },
          inspect: (engine, _world, ids, seen) =>
            Effect.gen(function* () {
              expect(scrubsOf(seen)).toEqual([
                { user: LAUNCHER, database: `/home/${LAUNCHER}/.local/share/opencode/opencode.db` },
              ]);
              yield* engine.stop(ids.holder);
              // The exit's scrub runs off the stop's path; its exec is the signal.
              yield* signalled(scrubs)(
                () => scrubsOf(seen).length === 2,
                "the scrub after the exit",
              );
            }),
        });
        // And once more after it ended, as her.
        expect(scrubsOf(run)).toHaveLength(2);
        expect(scrubsOf(run).every((scrub) => scrub.user === LAUNCHER)).toBe(true);
      }),
  );

  it.effect(
    "a restored opencode database is scrubbed as its person at prepare, off the launch path",
    () =>
      Effect.gen(function* () {
        const scrubs = yield* Queue.make<void>();
        const run = yield* launchAndJoinEffect({
          join: null,
          prepareStdout: `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout opencode ${LAUNCHER}\nmend-layout ready\n`,
          execEffect: (argv) => {
            if (isScrub(argv)) Queue.offerUnsafe(scrubs, undefined);
            return undefined;
          },
          // Forked off the launch; its exec is the signal.
          inspect: (_engine, _world, _ids, seen) =>
            signalled(scrubs)(() => scrubsOf(seen).length === 1, "the prepare-time scrub"),
        });
        expect(scrubsOf(run)).toEqual([
          { user: LAUNCHER, database: `/home/${LAUNCHER}/.local/share/opencode/opencode.db` },
        ]);
      }),
  );

  it.effect("a join that fails after its logins were written releases them and its token", () =>
    Effect.gen(function* () {
      let refused: string | null = null;
      /** Every release Core was asked for. */
      const releases = yield* Queue.make<void>();
      const run = yield* launchAndJoinEffect({
        join: "pi",
        layers: people,
        platform: (calls) =>
          Layer.effect(
            PersonLayoutPlatform,
            Effect.map(PersonLayoutPlatform, (inner) => ({
              ...inner,
              deleteCredentials: (
                workspace: Workspace,
                input: Parameters<typeof inner.deleteCredentials>[1],
              ) =>
                inner
                  .deleteCredentials(workspace, input)
                  .pipe(Effect.tap(() => Queue.offer(releases, undefined))),
            })),
          ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
        // Maria's pi profile cannot be set up: her start fails after her one Core call.
        exec: (argv) =>
          named(argv, "mend-pi-profile") && commandOf(argv)[4] === `/home/${JOINER}`
            ? { exitCode: 1, stdout: "", stderr: "a disk that is full" }
            : undefined,
        joinWith: (engine, _world, joined, seen) =>
          Effect.gen(function* () {
            refused = (yield* engine.launch(joined, ["pi"]).pipe(Effect.flip)).message;
            // The release runs off the refusal's path: Core's delete is what it left to wait for.
            yield* signalled(releases)(
              () => seen.calls.includes(`delete:/home/${JOINER}`),
              "what Core wrote for her released",
            );
          }),
      });
      expect(refused).toContain("the pi profile could not be set up");
      expect(run.calls).toContain(`post:${MARIA}:/home/${JOINER}`);
      expect(run.calls).toContain(`delete:/home/${JOINER}`);
      expect(run.calls).not.toContain(`delete:/home/${LAUNCHER}`);
    }),
  );

  it.effect(
    "a join whose delivery fails while its login write is still in flight releases what Core wrote",
    () =>
      Effect.gen(function* () {
        let refused: string | null = null;
        /** Every release Core was asked for. */
        const releases = yield* Queue.make<void>();
        const run = yield* launchAndJoinEffect({
          join: "pi",
          layers: people,
          // Core takes Maria's login write and answers late; her pi profile fails at once.
          platform: (calls) =>
            Layer.effect(
              PersonLayoutPlatform,
              Effect.map(PersonLayoutPlatform, (inner) => ({
                ...inner,
                postCredentials: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.postCredentials>[1],
                ) =>
                  input.onBehalfOf === MARIA
                    ? inner
                        .postCredentials(workspace, input)
                        .pipe(Effect.tap(() => Effect.sleep("400 millis")))
                    : inner.postCredentials(workspace, input),
                deleteCredentials: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.deleteCredentials>[1],
                ) =>
                  inner
                    .deleteCredentials(workspace, input)
                    .pipe(Effect.tap(() => Queue.offer(releases, undefined))),
              })),
            ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
          exec: (argv) =>
            named(argv, "mend-pi-profile") && commandOf(argv)[4] === `/home/${JOINER}`
              ? { exitCode: 1, stdout: "", stderr: "a disk that is full" }
              : undefined,
          joinWith: (engine, _world, joined, seen) =>
            Effect.gen(function* () {
              refused = (yield* engine.launch(joined, ["pi"]).pipe(Effect.flip)).message;
              // The release runs off the refusal's path: Core's delete is what it left to wait for.
              yield* signalled(releases)(
                () => seen.calls.includes(`delete:/home/${JOINER}`),
                "what Core wrote for her released",
              );
            }),
          settle: Effect.void,
        });
        expect(refused).toContain("the pi profile could not be set up");
        expect(run.calls).toContain(`post:${MARIA}:/home/${JOINER}`);
        expect(run.calls).toContain(`delete:/home/${JOINER}`);
        expect(run.calls).not.toContain(`delete:/home/${LAUNCHER}`);
      }),
  );

  it.effect(
    "refuses to start an opencode whose in-app login could not be removed, and says another person's failed scrub nowhere but the log",
    () =>
      Effect.gen(function* () {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
        const failing = (argv: ReadonlyArray<string>) => {
          const command = commandOf(argv);
          return command[0] === "node" && (command[2] ?? "").includes("mend-scrub")
            ? {
                exitCode: 1,
                stdout: `mend-scrub failed ${command[3] ?? ""} the database is in use, so its write-ahead log still holds what was deleted\n`,
                stderr: "",
              }
            : undefined;
        };
        /** A scrub that does not finish is tried twice more, a second apart (`scrubOpencodeAs`). */
        const scrubs = yield* Queue.make<void>();
        const execEffect = (argv: ReadonlyArray<string>) => {
          if (isScrub(argv)) Queue.offerUnsafe(scrubs, undefined);
          return undefined;
        };
        const threeAttempts = (seen: DeliveryRun) =>
          Effect.gen(function* () {
            yield* signalled(scrubs)(() => scrubsOf(seen).length === 1, "the first scrub");
            for (const attempt of [2, 3]) {
              yield* TestClock.adjust(999);
              expect(scrubsOf(seen)).toHaveLength(attempt - 1);
              yield* TestClock.adjust(1);
              yield* signalled(scrubs)(() => scrubsOf(seen).length === attempt, `scrub ${attempt}`);
            }
          });
        let failure: string | null = null;
        yield* launchAndJoinEffect({
          holderHarness: "opencode",
          join: null,
          exec: failing,
          execEffect,
          launchWith: (engine, _world, holder, seen) =>
            Effect.gen(function* () {
              const launching = yield* Effect.forkChild(
                engine.launch(holder, ["opencode"]).pipe(Effect.flip),
              );
              yield* threeAttempts(seen);
              failure = (yield* Fiber.join(launching)).message;
            }),
        });
        expect(failure).toContain(
          "opencode's data still holds an in-app login Mend could not remove",
        );
        // A prepare-time scrub that fails is logged, never put on the launcher's line.
        let summary: string | null = "unread";
        const logs: Array<string> = [];
        const logged = yield* Queue.make<void>();
        const push = logs.push.bind(logs);
        logs.push = (...lines) => {
          const length = push(...lines);
          Queue.offerUnsafe(logged, undefined);
          return length;
        };
        yield* launchAndJoinEffect({
          join: null,
          exec: failing,
          execEffect,
          layers: { logs },
          prepareStdout: `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout opencode ${LAUNCHER}\nmend-layout ready\n`,
          inspect: (_engine, world, ids, seen) =>
            Effect.gen(function* () {
              yield* threeAttempts(seen);
              yield* signalled(logged)(
                () => logs.some((line) => line.includes("opencode in-app logins not removed")),
                "the failed scrub logged",
              );
              summary = world.sessions.get(ids.holder)?.summary ?? null;
            }),
        });
        expect(summary ?? "").not.toContain("opencode logins not removed");
      }),
    20_000,
  );

  it.effect(
    "with dotfiles as a person: none at boot, the launcher's agent after their install.sh, a joiner's beside theirs",
    () =>
      Effect.gen(function* () {
        const launcherEnds = Effect.runSync(Deferred.make<number>());
        const joinerEnds = Effect.runSync(Deferred.make<number>());
        const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
        /** Every start's wait for an install.sh armed on the clock, and every session row written. */
        const waits = yield* Queue.make<void>();
        const writes = yield* Queue.make<void>();
        const run = yield* launchAndJoinEffect({
          platform: (calls) =>
            personPlatform(
              calls,
              { person: true },
              {
                bootstrapEnds: (user) =>
                  user === LAUNCHER ? launcherEnds : user === JOINER ? joinerEnds : null,
              },
            ),
          layers: {
            dotfilesStoreLayer: dotfilesStoreLayer(() =>
              Effect.succeed({ sha: snapshot.sha, data: snapshot.data }),
            ),
          },
          prepareWorld: (world) => signalWrites(world.sessions, writes),
          launchWith: (engine, _world, holder, seen) =>
            Effect.gen(function* () {
              const launching = yield* Effect.forkChild(engine.launch(holder, ["claude"]));
              // Applied as Alice into her home; her agent waits for her install.sh, bounded.
              yield* Queue.take(waits);
              expect(seen.calls).toContain(`dotfiles:${LAUNCHER}:/home/${LAUNCHER}`);
              expect(seen.opened).toHaveLength(0);
              yield* Deferred.succeed(launcherEnds, 0);
              yield* Fiber.join(launching);
              expect(seen.opened).toHaveLength(1);
            }),
          settle: Effect.void,
          inspect: (_engine, world, ids, seen) =>
            Effect.gen(function* () {
              // Nothing at boot: the create carries no dotfiles.
              expect(seen.created[0]?.dotfiles).toBeUndefined();
              // Maria's agent started beside her install.sh, and the line says so.
              expect(seen.calls).toContain(`dotfiles:${JOINER}:/home/${JOINER}`);
              expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(
                1,
              );
              const joined = ids.joined;
              if (joined === null) throw new Error("no join");
              expect(world.sessions.get(joined)?.summary).toContain("install.sh running");
              yield* Deferred.succeed(joinerEnds, 0);
              // The watcher replaces her line off the start's path: its write is the signal.
              yield* signalled(writes)(
                () =>
                  (world.sessions.get(joined)?.summary ?? "").includes(
                    "install.sh finished after the agent started",
                  ),
                "her line replaced",
              );
              const summary = world.sessions.get(joined)?.summary ?? "";
              expect(summary).toContain("install.sh finished after the agent started");
              expect(summary).not.toContain("install.sh running");
              // Mend's links go back over what the dotfiles placed, as each of them.
              expect(
                asWho(seen, (argv) =>
                  (commandOf(argv)[2] ?? "").includes(`printf done > "$H/${FIRST_PROCESS_DONE}"`),
                ),
              ).toEqual([LAUNCHER, JOINER]);
            }),
        }).pipe(reportingSleeps(BOOTSTRAP_WAIT_BOUND_MS, waits));
        expect(run.opened).toHaveLength(2);
      }),
  );

  /** A person platform whose apply for `who` lands only after `delay`, counting every apply. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const slowApplyFor =
    (who: string, delay: Duration.Input, applies: Array<string>, asked: Queue.Queue<void>) =>
    (calls: Array<string>) =>
      Layer.effect(
        PersonLayoutPlatform,
        Effect.map(PersonLayoutPlatform, (inner) => ({
          ...inner,
          applyDotfiles: (workspace: Workspace, input: Parameters<typeof inner.applyDotfiles>[1]) =>
            Effect.sync(() => applies.push(input.user.name)).pipe(
              Effect.andThen(Queue.offer(asked, undefined)),
              Effect.andThen(input.user.name === who ? Effect.sleep(delay) : Effect.void),
              Effect.andThen(inner.applyDotfiles(workspace, input)),
            ),
        })),
      ).pipe(Layer.provide(personPlatform(calls, { person: true }, { bootstrapEnds: () => null })));
  const linksRanAs = (run: DeliveryRun) =>
    asWho(run, (argv) =>
      (commandOf(argv)[2] ?? "").includes(`printf done > "$H/${FIRST_PROCESS_DONE}"`),
    );
  const markedAs = (run: DeliveryRun) =>
    asWho(run, (argv) =>
      (commandOf(argv)[2] ?? "").includes(`printf done > "$HOME/${FIRST_PROCESS_DONE}"`),
    );

  it.effect(
    "an apply that outlives the start's wait is seen through when it lands: links, then the marker, the record and the line made true (review of mend#569, P2-1)",
    () =>
      Effect.gen(function* () {
        const applies: Array<string> = [];
        const asked = yield* Queue.make<void>();
        /** Her start's wait for the apply armed on the clock, and every session row written. */
        const bounds = yield* Queue.make<void>();
        const writes = yield* Queue.make<void>();
        const observed: {
          before?: {
            readonly links: ReadonlyArray<string | null>;
            readonly marked: ReadonlyArray<string | null>;
            readonly summary: string;
            readonly record: SessionDotfiles | null;
          };
          after?: { readonly summary: string; readonly record: SessionDotfiles | null };
        } = {};
        const run = yield* launchAndJoinEffect({
          platform: slowApplyFor(JOINER, "700 millis", applies, asked),
          dotfilesApplyBound: Duration.millis(200),
          layers: {
            dotfilesStoreLayer: dotfilesStoreLayer(() =>
              Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
            ),
          },
          prepareWorld: (world) => signalWrites(world.sessions, writes),
          joinWith: (engine, _world, joined) =>
            Effect.gen(function* () {
              const joining = yield* Effect.forkChild(engine.launch(joined, ["claude"]));
              yield* signalled(asked)(() => applies.includes(JOINER), "her apply asked of Core");
              // Her start waits its bound (200 ms) for the apply, then goes on without it.
              yield* Queue.take(bounds);
              yield* TestClock.adjust(199);
              expect(joining.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(1);
              yield* Fiber.join(joining);
            }),
          settle: Effect.void,
          inspect: (_engine, world, ids, seen) =>
            Effect.gen(function* () {
              const joined = ids.joined;
              if (joined === null) throw new Error("no join");
              // Her agent started beside the apply, which Core still runs.
              expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(
                1,
              );
              observed.before = {
                links: linksRanAs(seen),
                marked: markedAs(seen),
                summary: world.sessions.get(joined)?.summary ?? "",
                record: world.sessions.get(joined)?.dotfiles ?? null,
              };
              // Core's apply lands 700 ms after it was asked, 200 of them the start's wait; the watch
              // sees it through off the start's path, and its writes to her row are the signal.
              yield* TestClock.adjust(499);
              expect(world.sessions.get(joined)?.summary ?? "").toContain(
                DOTFILES_STILL_APPLYING_WORDS,
              );
              yield* TestClock.adjust(1);
              yield* signalled(writes)(() => {
                const session = world.sessions.get(joined);
                return (
                  (session?.summary ?? "").includes(DOTFILES_LANDED_LATE_WORDS) &&
                  session?.dotfiles?.notApplied.length === 0
                );
              }, "the apply seen through");
              observed.after = {
                summary: world.sessions.get(joined)?.summary ?? "",
                record: world.sessions.get(joined)?.dotfiles ?? null,
              };
            }),
        }).pipe(reportingSleeps(200, bounds));
        const seenBefore = observed.before;
        const seenAfter = observed.after;
        if (seenBefore === undefined || seenAfter === undefined) throw new Error("not inspected");
        // Before it lands: no links, no marker for her, and the line and record say it still applies.
        expect(seenBefore.links).toEqual([LAUNCHER]);
        expect(seenBefore.marked).not.toContain(JOINER);
        expect(seenBefore.summary).toContain(DOTFILES_STILL_APPLYING_WORDS);
        expect(seenBefore.record?.notApplied).toEqual([
          { source: "snapshot", reason: DOTFILES_STILL_APPLYING },
        ]);
        // Once it lands: Mend's links put back as her (which marks her done), the line and record true.
        expect(linksRanAs(run)).toEqual([LAUNCHER, JOINER]);
        expect(seenAfter.summary).toContain(DOTFILES_LANDED_LATE_WORDS);
        expect(seenAfter.summary).not.toContain(DOTFILES_STILL_APPLYING_WORDS);
        expect(seenAfter.record?.notApplied).toEqual([]);
        // Core was asked once for her.
        expect(applies.filter((user) => user === JOINER)).toHaveLength(1);
      }),
  );

  it.effect(
    "a start refused while its apply runs leaves it to be seen through, and the next start never asks Core again (review of mend#569, P3-1)",
    () =>
      Effect.gen(function* () {
        const applies: Array<string> = [];
        const asked = yield* Queue.make<void>();
        /** Each start's wait for the apply armed on the clock, and Core's late answer armed. */
        const bounds = yield* Queue.make<void>();
        const answering = yield* Queue.make<void>();
        let posts = 0;
        const run = yield* launchAndJoinEffect({
          platform: (calls) =>
            Layer.effect(
              PersonLayoutPlatform,
              Effect.map(PersonLayoutPlatform, (inner) => ({
                ...inner,
                // Her first write is answered late and leaves Claude out: that start is refused.
                postCredentials: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.postCredentials>[1],
                ) =>
                  input.onBehalfOf === MARIA && posts++ === 0
                    ? Queue.offer(answering, undefined).pipe(
                        Effect.andThen(Effect.sleep("150 millis")),
                        Effect.andThen(inner.postCredentials(workspace, input)),
                        Effect.as({
                          skipped: [
                            {
                              provider: "claude" as const,
                              reason: "connected-account-missing" as const,
                              message: "none",
                            },
                          ],
                        }),
                      )
                    : inner.postCredentials(workspace, input),
              })),
            ).pipe(Layer.provide(slowApplyFor(JOINER, "900 millis", applies, asked)(calls))),
          layers: {
            dotfilesStoreLayer: dotfilesStoreLayer(() =>
              Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
            ),
          },
          joinWith: (engine, _world, joined) =>
            Effect.gen(function* () {
              const first = yield* Effect.forkChild(
                engine.launch(joined, ["claude"]).pipe(Effect.flip),
              );
              yield* signalled(asked)(() => applies.includes(JOINER), "her apply asked of Core");
              yield* Queue.take(bounds);
              // Her first write answers 150 ms on, Claude left out: that start is refused mid-apply.
              yield* Queue.take(answering);
              yield* TestClock.adjust(149);
              expect(first.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(1);
              const refused = yield* Fiber.join(first);
              expect(refused.message).toContain("Connect Claude");
              // Her next start comes while Core still runs the first one's apply: it joins it,
              // its own wait on it armed. The first start armed more than one wait before it was
              // refused; what it left queued is dropped, so the take below is the second start's
              // own wait, and the apply lands only once that start is waiting on it (under load
              // the start's git work can outlast the adjusts, and a start that arrives after the
              // apply was seen through asks Core again: a different scenario).
              yield* TestClock.adjust("200 millis");
              yield* Queue.takeAll(bounds);
              const second = yield* Effect.forkChild(engine.launch(joined, ["claude"]));
              yield* Queue.take(bounds);
              // The apply lands 900 ms after it was asked: the start waits for it, asking nothing.
              yield* TestClock.adjust(549);
              expect(second.pollUnsafe()).toBeUndefined();
              yield* TestClock.adjust(1);
              yield* Fiber.join(second);
              // Past when the first start's watch would have seen it through: nothing more.
              yield* TestClock.adjust("300 millis");
            }),
          settle: Effect.void,
        }).pipe(reportingSleeps(DOTFILES_APPLY_BOUND_MS, bounds));
        // One apply for her, seen through once: Mend's links put back once, as her.
        expect(applies.filter((user) => user === JOINER)).toHaveLength(1);
        expect(linksRanAs(run).filter((user) => user === JOINER)).toHaveLength(1);
        expect(run.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
      }),
  );

  it.effect(
    'a person\'s second start while their install.sh runs waits for it too, with "Start my agents after install.sh" on (review of mend#569, P3-2)',
    () =>
      Effect.gen(function* () {
        const joinerEnds = Effect.runSync(Deferred.make<number>());
        let waitsForInstall = false;
        /** Every start's wait for her install.sh armed on the clock. */
        const waits = yield* Queue.make<void>();
        yield* launchAndJoinEffect({
          platform: (calls) =>
            personPlatform(
              calls,
              { person: true },
              { bootstrapEnds: (user) => (user === JOINER ? joinerEnds : null) },
            ),
          layers: {
            dotfilesStoreLayer: dotfilesStoreLayer(() =>
              Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
            ),
            userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
              repository: () => Effect.succeed(null),
              setRepository: (_userId, value) => Effect.succeed(value),
              startAgentsAfterInstall: () => Effect.sync(() => waitsForInstall),
              setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
            }),
          },
          joinWith: (engine, world, joined, seen) =>
            Effect.gen(function* () {
              // Her first agent starts beside her install.sh.
              yield* engine.launch(joined, ["claude"]);
              expect(world.sessions.get(joined)?.summary ?? "").toContain("install.sh running");
              // She turns the setting on and starts a second session while it still runs.
              waitsForInstall = true;
              const holderWorktree = world.sessions.get(joined)?.worktreeId;
              if (holderWorktree === undefined) throw new Error("no worktree");
              const second = yield* engine.provisionSessionIn(holderWorktree, {
                harness: "claude",
                label: null,
                ownerUserId: MARIA,
              });
              const starting = yield* Effect.forkChild(engine.launch(second.id, ["claude"]));
              // Her second start waits for it, bounded.
              yield* Queue.take(waits);
              expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(
                1,
              );
              yield* Deferred.succeed(joinerEnds, 0);
              yield* Fiber.join(starting);
              expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(
                2,
              );
            }),
          settle: Effect.void,
        }).pipe(reportingSleeps(BOOTSTRAP_WAIT_BOUND_MS, waits));
      }),
  );

  it.effect(
    "says on the line when Core left a joiner's pi ChatGPT login out (review of mend#569, P3-5)",
    () =>
      Effect.gen(function* () {
        let summary = "";
        yield* launchAndJoinEffect({
          join: "pi",
          layers: people,
          platform: (calls) =>
            Layer.effect(
              PersonLayoutPlatform,
              Effect.map(PersonLayoutPlatform, (inner) => ({
                ...inner,
                postCredentials: (
                  workspace: Workspace,
                  input: Parameters<typeof inner.postCredentials>[1],
                ) =>
                  inner.postCredentials(workspace, input).pipe(
                    Effect.as({
                      skipped:
                        input.onBehalfOf === MARIA && input.logins.pi === true
                          ? [
                              {
                                provider: "pi" as const,
                                reason: "connected-account-unsupported" as const,
                                message: "not a ChatGPT login",
                              },
                            ]
                          : [],
                    }),
                  ),
              })),
            ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
          inspect: (_engine, world, ids) =>
            Effect.sync(() => {
              summary = ids.joined === null ? "" : (world.sessions.get(ids.joined)?.summary ?? "");
            }),
        });
        expect(summary).toContain(
          "pi's ChatGPT login not written · the Codex account is not a ChatGPT login",
        );
      }),
  );

  it.effect('with "Start my agents after install.sh" on, a joiner\'s agent waits for it', () =>
    Effect.gen(function* () {
      const joinerEnds = Effect.runSync(Deferred.make<number>());
      const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
      /** Every start's wait for her install.sh armed on the clock. */
      const waits = yield* Queue.make<void>();
      yield* launchAndJoinEffect({
        platform: (calls) =>
          personPlatform(
            calls,
            { person: true },
            {
              bootstrapEnds: (user) => (user === JOINER ? joinerEnds : null),
            },
          ),
        layers: {
          dotfilesStoreLayer: dotfilesStoreLayer(() =>
            Effect.succeed({ sha: snapshot.sha, data: snapshot.data }),
          ),
          userDotfilesLayer: Layer.succeed(UserDotfilesRepo, {
            repository: () => Effect.succeed(null),
            setRepository: (_userId, value) => Effect.succeed(value),
            startAgentsAfterInstall: (userId) => Effect.succeed(userId === MARIA),
            setStartAgentsAfterInstall: (_userId, value) => Effect.succeed(value),
          }),
        },
        joinWith: (engine, world, joined, seen) =>
          Effect.gen(function* () {
            const joining = yield* Effect.forkChild(engine.launch(joined, ["claude"]));
            // Her start waits for it, bounded.
            yield* Queue.take(waits);
            expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(0);
            yield* Deferred.succeed(joinerEnds, 0);
            yield* Fiber.join(joining);
            expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
            expect(world.sessions.get(joined)?.summary ?? "").not.toContain("install.sh");
          }),
        settle: Effect.void,
      }).pipe(reportingSleeps(BOOTSTRAP_WAIT_BOUND_MS, waits));
    }),
  );

  it.effect(
    "while the platform cannot apply dotfiles as a person: a fresh worktree whose launcher keeps some runs shared, with them at boot",
    () =>
      Effect.gen(function* () {
        const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
        const run = yield* launchAndJoinEffect({
          join: null,
          layers: {
            dotfilesStoreLayer: Layer.succeed(DotfilesStore, {
              snapshot: () => Effect.die("not in test"),
              current: () =>
                Effect.succeed({
                  sha: snapshot.sha,
                  source: "laptop",
                  committedAt: new Date(0),
                  files: [],
                }),
              archive: () => Effect.succeed({ sha: snapshot.sha, data: snapshot.data }),
              clear: () => Effect.void,
            }),
          },
        });
        expect(run.created[0]?.dotfiles?.archives).toHaveLength(1);
        expect(run.opened.every((options) => options.user === undefined)).toBe(true);
        expect(run.calls.some((call) => call.startsWith("dotfiles:"))).toBe(false);
      }),
  );

  it.effect(
    "while the platform cannot apply dotfiles as a person: a worktree already person starts without them, and says why",
    () =>
      Effect.gen(function* () {
        const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
        const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
        let recorded: SessionDotfiles | null = null;
        const run = yield* launchAndJoinEffect({
          join: null,
          flag: "shared",
          state,
          before: (worktreeId) =>
            state.worktrees.set(worktreeId, { layout: "person", requested: null }),
          layers: {
            dotfilesStoreLayer: Layer.succeed(DotfilesStore, {
              snapshot: () => Effect.die("not in test"),
              current: () =>
                Effect.succeed({
                  sha: snapshot.sha,
                  source: "laptop",
                  committedAt: new Date(0),
                  files: [],
                }),
              archive: () => Effect.die("never packed: nothing applies it"),
              clear: () => Effect.void,
            }),
          },
          inspect: (_engine, world, ids) =>
            Effect.sync(() => {
              recorded = world.sessions.get(ids.holder)?.dotfiles ?? null;
            }),
        });
        expect(run.created[0]?.dotfiles).toBeUndefined();
        expect(run.opened.every((options) => options.user?.name === LAUNCHER)).toBe(true);
        expect(recorded).toEqual({
          repository: null,
          snapshotSha: null,
          notApplied: [{ source: "snapshot", reason: DOTFILES_NOT_PER_PERSON }],
        });
      }),
  );
});
