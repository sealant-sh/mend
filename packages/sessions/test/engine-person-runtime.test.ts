import * as fs from "node:fs";
import * as path from "node:path";

import {
  AgentConversationRepo,
  WorktreesRepo,
  AgentMemoryRepo,
  UserDotfilesRepo,
  type HarnessLayoutsMemoryState,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
  piProfileDigest,
  type AgentMemoryHomes,
  type PreReleaseMigrationRecord,
  agentMemoryDigest,
} from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  AgentRequest,
  AgentTurn,
  type WorkspaceRetirement,
  Session,
  SessionProcess,
  type SessionDotfiles,
  PiProfile,
} from "@mend/domain/workbench";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  type CaptureFlushKind,
  type HomeLogins,
  PersonLayoutPlatform,
  type PersonSessionOptions,
  SealantPlatformError,
} from "@mend/sealant";
import {
  ProtocolHost,
  type ProtocolHostHooks,
  SessionEngine,
  SessionTurnRefusedError,
  WorkspaceReplaceRefusedError,
} from "@mend/sessions";
import { DotfilesStore, Store, processStatePathOf } from "@mend/store";
import type { CreateOptions, SessionOptions, Workspace } from "@sealant/sdk";
import { Deferred, Duration, Effect, Fiber, Layer, type Scope } from "effect";
import { describe, expect } from "vitest";

import { PI_PERSON_SEED } from "../src/harness-seeds.ts";
import {
  DOTFILES_LANDED_LATE_WORDS,
  DOTFILES_NOT_PER_PERSON,
  DOTFILES_STILL_APPLYING,
  DOTFILES_STILL_APPLYING_WORDS,
  FIRST_PROCESS_DONE,
  dotfilesRefusalWords,
} from "../src/person-deliveries.ts";
import { makeMemoryCaptureStore, type MemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
import {
  SNAPSHOT,
  configuredHarnessHomePath,
  dotfilesStoreLayer,
  eventually,
  headFlush,
  headReport,
  seedStoppedBeforeRestart,
  shipCapturedHarnessHome,
  until,
} from "./engine/capture-fixture.ts";
import {
  agentConversationStub,
  agentMemoryLayerOf,
  captureAnswer,
  launchSkill,
  now,
  piProfilesLayerOf,
  recordingProtocolHostLayer,
  redeemPickupExec,
  sealantLaunchLayer,
  secretFilesLayerOf,
  servedSocketApis,
  setup,
  skillsForLaunchLayer,
  type World,
  withEngine,
} from "./engine/fixture.ts";
import {
  LAYOUT_READY,
  MARIA,
  answerLayout,
  isPrepare,
  personPlatform,
} from "./engine/person-fixture.ts";
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
}

/** The command a person's exec runs, past its umask and the session it names (`personExecPrefix`). */
const commandOf = (argv: ReadonlyArray<string>) => {
  if (argv[3] !== "mend-as-person" || !(argv[5] ?? "").startsWith("MEND_SESSION_ID=")) return argv;
  // Past the environment it names: the session, and a one-off write's own token file.
  let at = 6;
  while ((argv[at] ?? "").startsWith("MEND_SESSION_TOKEN_FILE=")) at++;
  return argv.slice(at);
};

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
  const launchAndJoin = async (options: {
    readonly holderHarness?: string;
    readonly join?: string | null;
    readonly flag?: HarnessLayout;
    readonly platform?: (calls: Array<string>) => Layer.Layer<PersonLayoutPlatform>;
    readonly layers?: Partial<Parameters<typeof withEngine>[1]>;
    readonly prepareStdout?: string;
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
  }): Promise<DeliveryRun> => {
    const execs: Array<ReadonlyArray<string>> = [];
    const users: Array<string | null> = [];
    const opened: Array<PersonSessionOptions> = [];
    const created: Array<CreateOptions> = [];
    const calls: Array<string> = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    const run: { cold: number } = { cold: 0 };
    const view = (): DeliveryRun => ({
      execs,
      users,
      opened,
      created,
      calls,
      cold: run.cold,
      spawned,
    });
    const holderHarness = options.holderHarness ?? "claude";
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: holderHarness,
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
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
            yield* Effect.sleep("50 millis");
          }
          yield* (
            options.inspect?.(engine, world, { holder: holder.id, joined }, view()) ?? Effect.void
          );
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
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
  };

  it("the launcher's and a joiner's own skills, memory, secret files and shell profile, each as them into their own home", async () => {
    let ids: { readonly holder: SessionId; readonly joined: SessionId | null } | null = null;
    const run = await launchAndJoin({
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
        (argv) => named(argv, "mend-skills") && commandOf(argv)[4] === "/workspace/harness-home",
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
  });

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

    it("is written as whoever pasted it, into their own saved directory", async () => {
      let seen: {
        readonly holder: SessionId;
        readonly from: number;
        readonly own: string;
        readonly steered: string;
      } | null = null;
      const run = await launchAndJoin({
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
    });

    /**
     * mend#615 review, finding 3: a first paste ran a person's whole first start (their logins
     * written, their deliveries) though no process of theirs ever ran, and nothing released it. A
     * paste makes only their user and home, with a Mend token of the write's own, in a file of its
     * own that the write's exec names, and that token, exactly, is revoked when the write ends,
     * placed or refused (review 2, 615-r2-2 and 615-r2-3). The home exec here redeems its ticket
     * over the session's channel, as the executor's root does.
     */
    it.each([
      { write: "placed", fails: false },
      { write: "refused", fails: true },
    ])(
      "makes only a first sender's user, home and a token of the write's own, and revokes exactly it, the write $write",
      async ({ fails }) => {
        const tokenEvents: Array<string> = [];
        let holder: SessionId | null = null;
        let seen: { readonly from: number; readonly outcome: string } | null = null;
        const run = await launchAndJoin({
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
      },
    );

    it("leaves a sender's first start whole: their join after a paste is made and delivered to as a first one", async () => {
      let pasted = 0;
      const run = await launchAndJoin({
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
    });

    it("is written as root, inside the harness home, in a shared executor", async () => {
      let seen: { readonly from: number; readonly path: string } | null = null;
      const run = await launchAndJoin({
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
    });
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
  const joinSameAlice = async (layers: Partial<Parameters<typeof withEngine>[1]>) => {
    let from = 0;
    const run = await launchAndJoin({
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
          yield* Effect.sleep("50 millis");
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
  };

  it("a same-person join with their memory unchanged stages and runs nothing for it", async () => {
    const { cold, join, staged } = await joinSameAlice(people);
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
  });

  it("a same-person join delivers their memory when the store changed it since their last start", async () => {
    let reads = 0;
    const { join, staged } = await joinSameAlice({
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
  });

  it("another person's join delivers their own memory, into their own P, beside Alice's in place", async () => {
    const run = await launchAndJoin({ layers: people, exec: savedMemory() });
    const join = run.execs.slice(run.cold);
    const memory = join.flatMap((argv, index) =>
      named(argv, "mend-agent-memory")
        ? [{ saved: commandOf(argv)[4], user: run.users[run.cold + index] ?? null }]
        : [],
    );
    expect(memory).toEqual([{ saved: P_JOINER, user: JOINER }]);
    const list = commandOf(join.find((argv) => named(argv, "mend-agent-memory")) ?? [])[7] ?? "";
    expect(JSON.parse(list)).toEqual([
      {
        path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
        digest: memoryOf(MARIA)[0]?.digest,
      },
    ]);
    for (const argv of join) expect(argv.join(" ")).not.toContain(P_LAUNCHER);
  });

  it("two people's pi profiles live in one executor: Maria's own is delivered beside Alice's live pi", async () => {
    const run = await launchAndJoin({ holderHarness: "pi", join: "pi", layers: people });
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
    expect(writes[0]?.targets.every((target) => target.includes(`/home/${LAUNCHER}/`))).toBe(true);
    expect(writes[1]?.targets.every((target) => target.includes(`/home/${JOINER}/`))).toBe(true);
    expect(writes[1]?.targets.some((target) => target.includes(`extensions/${MARIA}/`))).toBe(true);
  });

  it("pi in a person executor starts behind no ChatGPT copy of Mend's: Core writes pi's login, in each person's one call (sealant#336)", async () => {
    const posts: Array<{ readonly onBehalfOf: string; readonly logins: HomeLogins }> = [];
    const run = await launchAndJoin({
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
  });

  it("a joiner's dotfiles Core refuses are recorded not applied in Mend's words, and their agent starts (sealant#334)", async () => {
    let recorded: SessionDotfiles | null = null;
    const refusal = new SealantPlatformError({
      code: "home-mismatch",
      status: 409,
      message: "the home is not the user's passwd home",
      cause: null,
    });
    const run = await launchAndJoin({
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
  });

  it("an opencode's in-app logins are scrubbed as its person before it starts and after it ends", async () => {
    const run = await launchAndJoin({
      holderHarness: "opencode",
      join: null,
      // Her restored database is the one her opencode opens: scrubbed once, before it starts.
      prepareStdout: `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout opencode ${LAUNCHER}\nmend-layout ready\n`,
      inspect: (engine, _world, ids, seen) =>
        Effect.gen(function* () {
          expect(scrubsOf(seen)).toEqual([
            { user: LAUNCHER, database: `/home/${LAUNCHER}/.local/share/opencode/opencode.db` },
          ]);
          yield* engine.stop(ids.holder);
          yield* Effect.sleep("50 millis");
        }),
    });
    // And once more after it ended, as her.
    expect(scrubsOf(run)).toHaveLength(2);
    expect(scrubsOf(run).every((scrub) => scrub.user === LAUNCHER)).toBe(true);
  });

  it("a restored opencode database is scrubbed as its person at prepare, off the launch path", async () => {
    const run = await launchAndJoin({
      join: null,
      prepareStdout: `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout opencode ${LAUNCHER}\nmend-layout ready\n`,
      inspect: () => Effect.sleep("50 millis"),
    });
    expect(scrubsOf(run)).toEqual([
      { user: LAUNCHER, database: `/home/${LAUNCHER}/.local/share/opencode/opencode.db` },
    ]);
  });

  it("a join that fails after its logins were written releases them and its token", async () => {
    let refused: string | null = null;
    const run = await launchAndJoin({
      join: "pi",
      layers: people,
      // Maria's pi profile cannot be set up: her start fails after her one Core call.
      exec: (argv) =>
        named(argv, "mend-pi-profile") && commandOf(argv)[4] === `/home/${JOINER}`
          ? { exitCode: 1, stdout: "", stderr: "a disk that is full" }
          : undefined,
      joinWith: (engine, _world, joined) =>
        engine.launch(joined, ["pi"]).pipe(
          Effect.flip,
          Effect.map((error) => {
            refused = error.message;
          }),
        ),
    });
    expect(refused).toContain("the pi profile could not be set up");
    expect(run.calls).toContain(`post:${MARIA}:/home/${JOINER}`);
    expect(run.calls).toContain(`delete:/home/${JOINER}`);
    expect(run.calls).not.toContain(`delete:/home/${LAUNCHER}`);
  });

  it("a join whose delivery fails while its login write is still in flight releases what Core wrote", async () => {
    let refused: string | null = null;
    const run = await launchAndJoin({
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
          })),
        ).pipe(Layer.provide(personPlatform(calls, { person: true }))),
      exec: (argv) =>
        named(argv, "mend-pi-profile") && commandOf(argv)[4] === `/home/${JOINER}`
          ? { exitCode: 1, stdout: "", stderr: "a disk that is full" }
          : undefined,
      joinWith: (engine, _world, joined) =>
        engine.launch(joined, ["pi"]).pipe(
          Effect.flip,
          Effect.map((error) => {
            refused = error.message;
          }),
          Effect.andThen(Effect.sleep("200 millis")),
        ),
    });
    expect(refused).toContain("the pi profile could not be set up");
    expect(run.calls).toContain(`post:${MARIA}:/home/${JOINER}`);
    expect(run.calls).toContain(`delete:/home/${JOINER}`);
    expect(run.calls).not.toContain(`delete:/home/${LAUNCHER}`);
  });

  it("refuses to start an opencode whose in-app login could not be removed, and says another person's failed scrub nowhere but the log", async () => {
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
    let failure: string | null = null;
    await launchAndJoin({
      holderHarness: "opencode",
      join: null,
      exec: failing,
      launchWith: (engine, _world, holder) =>
        engine.launch(holder, ["opencode"]).pipe(
          Effect.flip,
          Effect.map((error) => {
            failure = error.message;
          }),
        ),
    });
    expect(failure).toContain("opencode's data still holds an in-app login Mend could not remove");
    // A prepare-time scrub that fails is logged, never put on the launcher's line.
    let summary: string | null = "unread";
    await launchAndJoin({
      join: null,
      exec: failing,
      prepareStdout: `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout opencode ${LAUNCHER}\nmend-layout ready\n`,
      inspect: (_engine, world, ids) =>
        Effect.gen(function* () {
          yield* Effect.sleep("2500 millis");
          summary = world.sessions.get(ids.holder)?.summary ?? null;
        }),
    });
    expect(summary ?? "").not.toContain("opencode logins not removed");
  }, 20_000);

  it("with dotfiles as a person: none at boot, the launcher's agent after their install.sh, a joiner's beside theirs", async () => {
    const launcherEnds = Effect.runSync(Deferred.make<number>());
    const joinerEnds = Effect.runSync(Deferred.make<number>());
    const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
    const run = await launchAndJoin({
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
      launchWith: (engine, _world, holder, seen) =>
        Effect.gen(function* () {
          const launching = yield* Effect.forkChild(engine.launch(holder, ["claude"]));
          yield* Effect.sleep("100 millis");
          // Applied as Alice into her home; her agent waits for her install.sh.
          expect(seen.calls).toContain(`dotfiles:${LAUNCHER}:/home/${LAUNCHER}`);
          expect(seen.opened).toHaveLength(0);
          yield* Deferred.succeed(launcherEnds, 0);
          yield* Fiber.join(launching);
          expect(seen.opened).toHaveLength(1);
        }),
      inspect: (_engine, world, ids, seen) =>
        Effect.gen(function* () {
          // Nothing at boot: the create carries no dotfiles.
          expect(seen.created[0]?.dotfiles).toBeUndefined();
          // Maria's agent started beside her install.sh, and the line says so.
          expect(seen.calls).toContain(`dotfiles:${JOINER}:/home/${JOINER}`);
          expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
          const joined = ids.joined;
          if (joined === null) throw new Error("no join");
          expect(world.sessions.get(joined)?.summary).toContain("install.sh running");
          yield* Deferred.succeed(joinerEnds, 0);
          yield* Effect.sleep("50 millis");
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
    });
    expect(run.opened).toHaveLength(2);
  });

  /** A person platform whose apply for `who` lands only after `delay`, counting every apply. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const slowApplyFor =
    (who: string, delay: Duration.Input, applies: Array<string>) => (calls: Array<string>) =>
      Layer.effect(
        PersonLayoutPlatform,
        Effect.map(PersonLayoutPlatform, (inner) => ({
          ...inner,
          applyDotfiles: (workspace: Workspace, input: Parameters<typeof inner.applyDotfiles>[1]) =>
            Effect.sync(() => applies.push(input.user.name)).pipe(
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

  it("an apply that outlives the start's wait is seen through when it lands: links, then the marker, the record and the line made true (review of mend#569, P2-1)", async () => {
    const applies: Array<string> = [];
    const observed: {
      before?: {
        readonly links: ReadonlyArray<string | null>;
        readonly marked: ReadonlyArray<string | null>;
        readonly summary: string;
        readonly record: SessionDotfiles | null;
      };
      after?: { readonly summary: string; readonly record: SessionDotfiles | null };
    } = {};
    const run = await launchAndJoin({
      platform: slowApplyFor(JOINER, "700 millis", applies),
      dotfilesApplyBound: Duration.millis(200),
      layers: {
        dotfilesStoreLayer: dotfilesStoreLayer(() =>
          Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
        ),
      },
      inspect: (_engine, world, ids, seen) =>
        Effect.gen(function* () {
          const joined = ids.joined;
          if (joined === null) throw new Error("no join");
          // Her agent started beside the apply, which Core still runs.
          expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
          observed.before = {
            links: linksRanAs(seen),
            marked: markedAs(seen),
            summary: world.sessions.get(joined)?.summary ?? "",
            record: world.sessions.get(joined)?.dotfiles ?? null,
          };
          yield* Effect.sleep("900 millis");
          observed.after = {
            summary: world.sessions.get(joined)?.summary ?? "",
            record: world.sessions.get(joined)?.dotfiles ?? null,
          };
        }),
    });
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
  });

  it("a start refused while its apply runs leaves it to be seen through, and the next start never asks Core again (review of mend#569, P3-1)", async () => {
    const applies: Array<string> = [];
    let posts = 0;
    const run = await launchAndJoin({
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
                ? inner.postCredentials(workspace, input).pipe(
                    Effect.delay("150 millis"),
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
        ).pipe(Layer.provide(slowApplyFor(JOINER, "900 millis", applies)(calls))),
      layers: {
        dotfilesStoreLayer: dotfilesStoreLayer(() =>
          Effect.succeed({ sha: SNAPSHOT.sha, data: SNAPSHOT.data }),
        ),
      },
      joinWith: (engine, _world, joined) =>
        Effect.gen(function* () {
          const refused = yield* engine.launch(joined, ["claude"]).pipe(Effect.flip);
          expect(refused.message).toContain("Connect Claude");
          // Her next start comes while Core still runs the first one's apply: it joins it.
          yield* Effect.sleep("200 millis");
          yield* engine.launch(joined, ["claude"]);
          // Past when the first start's watch would have seen it through: nothing more.
          yield* Effect.sleep("300 millis");
        }),
    });
    // One apply for her, seen through once: Mend's links put back once, as her.
    expect(applies.filter((user) => user === JOINER)).toHaveLength(1);
    expect(linksRanAs(run).filter((user) => user === JOINER)).toHaveLength(1);
    expect(run.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
  });

  it('a person\'s second start while their install.sh runs waits for it too, with "Start my agents after install.sh" on (review of mend#569, P3-2)', async () => {
    const joinerEnds = Effect.runSync(Deferred.make<number>());
    let waitsForInstall = false;
    await launchAndJoin({
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
          yield* Effect.sleep("150 millis");
          expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
          yield* Deferred.succeed(joinerEnds, 0);
          yield* Fiber.join(starting);
          expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(2);
        }),
    });
  });

  it("says on the line when Core left a joiner's pi ChatGPT login out (review of mend#569, P3-5)", async () => {
    let summary = "";
    await launchAndJoin({
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
  });

  it('with "Start my agents after install.sh" on, a joiner\'s agent waits for it', async () => {
    const joinerEnds = Effect.runSync(Deferred.make<number>());
    const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
    await launchAndJoin({
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
          yield* Effect.sleep("100 millis");
          expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(0);
          yield* Deferred.succeed(joinerEnds, 0);
          yield* Fiber.join(joining);
          expect(seen.opened.filter((options) => options.user?.name === JOINER)).toHaveLength(1);
          expect(world.sessions.get(joined)?.summary ?? "").not.toContain("install.sh");
        }),
    });
  });

  it("while the platform cannot apply dotfiles as a person: a fresh worktree whose launcher keeps some runs shared, with them at boot", async () => {
    const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
    const run = await launchAndJoin({
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
  });

  it("while the platform cannot apply dotfiles as a person: a worktree already person starts without them, and says why", async () => {
    const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
    const snapshot = { sha: "5eed0f5eed0f5eed0f5eed0f5eed0f5eed0f5eed", data: "c25hcHNob3Q=" };
    let recorded: SessionDotfiles | null = null;
    const run = await launchAndJoin({
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
  });
});

/** One line of a Claude transcript (Delivery 16's tests). */
const claudeLine = (id: string, text: string) =>
  `${JSON.stringify({
    type: "user",
    sessionId: id,
    cwd: "/workspace/repo",
    message: { role: "user", content: text },
  })}\n`;

const PROJECT_DIR = ".claude/projects/-workspace-repo";

const writeUnder = (root: string, relative: string, contents: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), contents);
};

/** A person's saved directory, under a harness home. */
const peopleDir = (account: string) => `people/${account}`;

describe("readers per person (docs/adr/0016, Delivery 16)", () => {
  it.each([
    ["never shared", false],
    ["Alice's shared once, then turned off", true],
  ] as const)(
    "two people's transcripts and memory in one capture are each read back only for their own person (%s)",
    { timeout: 30_000 },
    async (_label, aliceOnceShared) => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
      const alice = crypto.randomUUID();
      const maria = crypto.randomUUID();
      const old = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(holder.id, ["claude"]);
            const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            yield* engine.launch(joined.id, ["claude"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            // One executor's harness home, with both people's saved directories in it, and the
            // shared home a pre-release executor left beside them.
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${alice}.jsonl`,
              claudeLine(alice, "alice's turn"),
            );
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/memory/MEMORY.md`,
              "- alice learned\n",
            );
            writeUnder(
              home,
              `${peopleDir(MARIA)}/${PROJECT_DIR}/${maria}.jsonl`,
              claudeLine(maria, "maria's turn"),
            );
            writeUnder(
              home,
              `${peopleDir(MARIA)}/${PROJECT_DIR}/memory/MEMORY.md`,
              "- maria learned\n",
            );
            writeUnder(home, `${PROJECT_DIR}/${old}.jsonl`, claudeLine(old, "before 0.36"));
            writeUnder(home, `${PROJECT_DIR}/memory/MEMORY.md`, "- the old shared home\n");
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              holder.worktreeId,
              memory.leases.get(holder.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );

            if (aliceOnceShared) {
              // Shared control was on, then turned off: her session still credits nobody.
              const row = world.sessions.get(holder.id);
              if (row === undefined) return yield* Effect.die("no holder session");
              world.sessions.set(
                holder.id,
                new Session({ ...row, sharedControlEverAt: new Date(Date.now() - 60_000) }),
              );
            }
            yield* engine.stop(joined.id);
            yield* until(() => readBacks.length > 0, "Maria's read-back");
            expect(readBacks.map((input) => input.userId)).toEqual([MARIA]);
            expect(readBacks[0]?.session.map((file) => [file.path, file.contents])).toEqual([
              [`${PROJECT_DIR}/memory/MEMORY.md`, "- maria learned\n"],
            ]);
            expect(world.sessions.get(joined.id)?.providerSessionId).toBe(maria);

            yield* engine.stop(holder.id);
            if (aliceOnceShared) {
              yield* until(
                () => world.sessions.get(holder.id)?.providerSessionId === alice,
                "Alice's harvest",
              );
              yield* Effect.sleep("100 millis");
              expect(readBacks.map((input) => input.userId)).toEqual([MARIA]);
              return;
            }
            yield* until(() => readBacks.length > 1, "Alice's read-back");
            expect(readBacks.map((input) => input.userId)).toEqual([MARIA, "user-fixture"]);
            expect(readBacks[1]?.session.map((file) => [file.path, file.contents])).toEqual([
              [`${PROJECT_DIR}/memory/MEMORY.md`, "- alice learned\n"],
            ]);
            expect(world.sessions.get(holder.id)?.providerSessionId).toBe(alice);
          }),
        {
          captured: memory,
          prepareWorld: (world) => world.members.set(MARIA, "member"),
          agentMemoryLayer: agentMemoryLayerOf({
            readBack: (input) =>
              Effect.sync(() => {
                readBacks.push(input);
                return { saved: [], merged: [], deleted: [], skipped: [] };
              }),
          }),
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            { flush: headFlush(memory), exec: answerLayout(LAYOUT_READY) },
          ),
          harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
        },
      );
    },
  );

  /**
   * A conversation two captures of the worktree's last shared executor hold, then the worktree
   * turns person and Alice resumes it. With `marias`, a pre-release terminal session of Maria's in
   * the same worktree was harvested with the same conversation id.
   */
  const resumeAfterSharedEra = async (options: { readonly marias: boolean }) => {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const memory = makeMemoryCaptureStore();
    const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
    const id = crypto.randomUUID();
    const picked: Array<{ readonly path: string; readonly contents: string }> = [];
    let resumed: SessionId | null = null;
    let summary: string | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "before",
            ownerUserId: "user-fixture",
            base: null,
          });
          resumed = session.id;
          // The worktree's last shared executor: an earlier capture, then its final one, which
          // holds what the conversation said last.
          yield* engine.launch(session.id, ["claude"]);
          const request = created[0];
          if (request === undefined) return yield* Effect.die("the launch made no executor");
          const executorRoot = path.join(tmp, "shared-executor");
          const home = configuredHarnessHomePath(request, executorRoot);
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          writeUnder(home, `${PROJECT_DIR}/${id}.jsonl`, claudeLine(id, "first"));
          yield* shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          );
          writeUnder(
            home,
            `${PROJECT_DIR}/${id}.jsonl`,
            `${claudeLine(id, "first")}${claudeLine(id, "last")}`,
          );
          writeUnder(home, `${PROJECT_DIR}/${id}/tool-results/out.txt`, "a tool's output\n");
          yield* shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          );
          yield* engine.stop(session.id);
          yield* until(
            () => world.sessions.get(session.id)?.providerSessionId === id,
            "the shared executor's harvest",
          );
          if (options.marias) {
            // Maria's terminal agent in the same shared home: its harvest took the newest
            // transcript there, Alice's.
            const marias = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            const row = world.sessions.get(marias.id);
            if (row === undefined) return yield* Effect.die("no session of Maria's");
            world.sessions.set(marias.id, new Session({ ...row, providerSessionId: id }));
          }
          // Then the worktree runs per person, and Alice resumes that conversation.
          state.worktrees.set(session.worktreeId, { layout: "person", requested: null });
          yield* engine.resumeSession(session.id, null);
          summary = world.sessions.get(session.id)?.summary ?? null;
        }),
      {
        captured: memory,
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          {
            flush: headFlush(memory),
            exec: answerLayout(LAYOUT_READY),
            execEffect: (argv) => {
              const command = commandOf(argv);
              if (command[3] !== "mend-write" || !command.some((part) => part.startsWith("A/"))) {
                return undefined;
              }
              return redeemPickupExec(command, resumed).pipe(
                Effect.map((answer) => {
                  for (const file of answer.files) {
                    picked.push({
                      path: file.path,
                      contents: Buffer.from(file.base64, "base64").toString("utf8"),
                    });
                  }
                  return { exitCode: 0, stdout: "", stderr: "" };
                }),
                Effect.orDie,
              );
            },
          },
        ),
        harnessLayout: { flag: "shared", state, platform: personPlatform([], { person: true }) },
      },
    );
    return { id, picked, execCalls, summary };
  };

  it(
    "a resume copies its conversation from the worktree's last shared-layout capture, the final one, only where its owner has none",
    { timeout: 30_000 },
    async () => {
      const { id, picked, execCalls } = await resumeAfterSharedEra({ marias: false });
      const P = "/workspace/harness-home/people/user-fixture";
      expect(picked.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
        {
          path: `${P}/${PROJECT_DIR}/${id}.jsonl`,
          contents: `${claudeLine(id, "first")}${claudeLine(id, "last")}`,
        },
        {
          path: `${P}/${PROJECT_DIR}/${id}/tool-results/out.txt`,
          contents: "a tool's output\n",
        },
      ]);
      // Written only where nothing is, 0600, as Alice, into her own saved directory.
      const copies = execCalls.filter(
        (argv) =>
          commandOf(argv)[3] === "mend-write" && argv.some((part) => part.startsWith(`A${P}/`)),
      );
      expect(copies).toHaveLength(1);
      expect(
        commandOf(copies[0] ?? [])
          .slice(5)
          .every((part) => part.startsWith(`A${P}/`)),
      ).toBe(true);
    },
  );

  it(
    "a conversation another person's pre-release session also holds is never copied, and the session says so",
    { timeout: 30_000 },
    async () => {
      const { picked, summary } = await resumeAfterSharedEra({ marias: true });
      expect(picked).toEqual([]);
      expect(summary ?? "").toContain(
        "conversation from before per-person homes not copied · another person's session in this worktree holds it too",
      );
    },
  );
});

const isStage = (argv: ReadonlyArray<string>) => (argv[2] ?? "").includes("leftover()");

const isExchange = (argv: ReadonlyArray<string>) =>
  (argv[2] ?? "").includes("nothing is staged for this conversation");

/** A protocol host that records what each attached process resumes by. */
const resumingHost = (
  attached: Array<{ readonly process: SessionProcess; readonly resumePath: string | null }>,
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({ process: input.process, resumePath: input.resumePath ?? null });
      }),
    rehydrate: () => Effect.void,
    submitTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(false),
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: () => Effect.void,
  });

describe("the conversation home of a shared conversation (docs/adr/0016, Delivery 17)", () => {
  const scenario = async (options: {
    readonly harness: "claude" | "codex";
    readonly shared: boolean;
    readonly mode: "protocol" | "pty";
  }) => {
    const created: Array<CreateOptions> = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly resumePath: string | null;
    }> = [];
    const state = makeHarnessLayoutsMemoryState();
    const provider =
      options.harness === "claude"
        ? "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11"
        : "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    let sessionId: SessionId | null = null;
    let afterFirst: { readonly execs: number; readonly calls: number } = { execs: 0, calls: 0 };
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      const script = argv[2] ?? "";
      if (isStage(argv)) {
        const home = `/run/mend/conv/${sessionId ?? ""}`;
        const resume = !script.includes(provider)
          ? ""
          : options.harness === "claude"
            ? `mend-conv resume ${home}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
            : `mend-conv resume ${home}/.codex/sessions/2026/10/07/rollout-2026-10-07T10-00-00-${provider}.jsonl\n`;
        const moved = script.includes("moved=0") ? "mend-conv moved 2\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: options.harness,
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          if (options.shared) {
            const row = world.sessions.get(session.id);
            if (row === undefined) return yield* Effect.die("no session");
            world.sessions.set(
              session.id,
              new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
            );
          }
          if (options.mode === "pty") {
            yield* engine.launch(session.id, [options.harness]);
            return;
          }
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          afterFirst = { execs: execCalls.length, calls: calls.length };
          // The conversation has a provider id now, as its first process's harvest leaves it.
          const first = [...world.processes.values()].findLast(
            (process) => process.sessionId === session.id && process.kind === "agent-protocol",
          );
          if (first === undefined) return yield* Effect.die("no protocol process");
          world.processes.set(
            first.id,
            new SessionProcess({ ...first, providerSessionId: provider }),
          );
          yield* engine.stop(session.id);
          yield* Effect.sleep("50 millis");
          yield* engine.resumeSession(session.id, null);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
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
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: resumingHost(attached),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    if (sessionId === null) throw new Error("no session");
    return { sessionId, spawned, opened, execCalls, calls, attached, state, afterFirst, provider };
  };

  it("a shared Claude conversation moves into C once and runs in its home as its sender, in the neutral context", async () => {
    const run = await scenario({ harness: "claude", shared: true, mode: "protocol" });
    const home = `/run/mend/conv/${run.sessionId}`;
    // First start: the move, as the owner, then the exchange; Core writes the owner's login into H.
    const firstExecs = run.execCalls.slice(0, run.afterFirst.execs);
    const stages = firstExecs.filter(isStage);
    expect(stages).toHaveLength(1);
    expect(stages[0]?.[2]).toContain("moved=0");
    expect(firstExecs.filter(isExchange)).toHaveLength(1);
    expect(run.calls.slice(0, run.afterFirst.calls)).toContain(`post:user-fixture:${home}`);
    expect(run.state.sharedConversations.get(run.sessionId)?.owner).toBe("user-fixture");
    // Started directly, with the neutral settings file: no seed, no shell profile.
    const agentArgv = run.spawned.filter((argv) => argv.includes("stream-json"));
    expect(agentArgv[0]?.[0]).toBe("claude");
    expect(agentArgv[0]?.slice(-2)).toEqual([
      "--settings",
      JSON.stringify({
        autoMemoryEnabled: false,
        env: {
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
          CLAUDE_CODE_DISABLE_CRON: "1",
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        },
      }),
    ]);
    const agentOptions = run.opened.filter(
      (options) => "env" in options && options.env?.["CLAUDE_CONFIG_DIR"] !== undefined,
    );
    expect(agentOptions[0]?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
    expect(agentOptions[0]?.env?.["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
    expect(agentOptions[0]?.env?.["CLAUDE_CODE_DISABLE_CRON"]).toBe("1");
    // The process says whose user it runs as.
    expect(run.attached[0]?.process.runsAs).toBe("user-fixture");
    // Stopped: the conversation is free and H's login released.
    expect(run.calls).toContain(`delete:${home}`);
    // Resumed: no move again, and Claude resumes by the full path of its transcript in C, via H.
    const resumeStages = run.execCalls.slice(run.afterFirst.execs).filter(isStage);
    expect(resumeStages).toHaveLength(1);
    expect(resumeStages[0]?.[2]).not.toContain("moved=0");
    const resumed = agentArgv.at(-1) ?? [];
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(
      `${home}/.claude/projects/-workspace-repo/${run.provider}.jsonl`,
    );
    // One live process per conversation: the resumed one holds it now.
    const last = run.attached.at(-1)?.process;
    expect(run.state.conversationHolders.get(run.sessionId)?.processId).toBe(last?.id);
  }, 30_000);

  it("a shared Codex conversation runs with HOME and its index at H, and resumes by its rollout's path", async () => {
    const run = await scenario({ harness: "codex", shared: true, mode: "protocol" });
    const home = `/run/mend/conv/${run.sessionId}`;
    const agentOptions = run.opened.filter(
      (options) => "env" in options && options.env?.["CODEX_HOME"] !== undefined,
    );
    expect(agentOptions[0]?.env?.["HOME"]).toBe(home);
    expect(agentOptions[0]?.env?.["CODEX_SQLITE_HOME"]).toBe(`${home}/.codex`);
    const agentArgv = run.spawned.filter((argv) => argv.includes("app-server"));
    expect(agentArgv[0]).toEqual([
      "codex",
      "-c",
      "features.memories=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.daemon_auto_start=false",
      "-c",
      "features.shell_snapshot=false",
      "app-server",
    ]);
    expect(run.attached.at(-1)?.resumePath).toBe(
      `${home}/.codex/sessions/2026/10/07/rollout-2026-10-07T10-00-00-${run.provider}.jsonl`,
    );
    expect(run.calls.filter((call) => call === `post:user-fixture:${home}`)).toHaveLength(2);
  }, 30_000);

  it("a conversation never shared runs in its owner's own home, as before", async () => {
    const run = await scenario({ harness: "claude", shared: false, mode: "protocol" });
    expect(run.execCalls.filter(isStage)).toHaveLength(0);
    expect(run.calls.some((call) => call.includes("/run/mend/conv/"))).toBe(false);
    expect(run.state.sharedConversations.size).toBe(0);
    // Still one live process per conversation.
    expect(run.state.conversationHolders.size).toBe(0);
  }, 30_000);

  it("Shared control on a terminal session changes nothing: no move, no conversation home, the owner's own context", async () => {
    const run = await scenario({ harness: "claude", shared: true, mode: "pty" });
    expect(run.execCalls.filter(isStage)).toHaveLength(0);
    expect(run.execCalls.filter(isExchange)).toHaveLength(0);
    expect(run.calls.some((call) => call.includes("/run/mend/conv/"))).toBe(false);
    expect(run.state.sharedConversations.size).toBe(0);
    for (const options of run.opened) {
      if ("env" in options) expect(options.env?.["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    }
  }, 30_000);
});

describe("a terminal takeover of a once-shared conversation (review of mend#572, P2-3)", () => {
  it("a handoff to the terminal opens in the conversation home, on a take, with the transcript under H", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    let takesAtStart = 0;
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          if (alice === undefined) return yield* Effect.die("no protocol process");
          world.processes.set(
            alice.id,
            new SessionProcess({ ...alice, providerSessionId: provider }),
          );
          // What the harvest leaves for the terminal to resume.
          const stateDir = processStatePathOf(project.storePath, session.id, alice.id);
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(
            path.join(stateDir, "manifest.json"),
            JSON.stringify({
              harness: "claude",
              providerSessionId: provider,
              capturedAt: new Date().toISOString(),
            }),
          );
          takesAtStart = state.conversationHolders.get(session.id)?.fence ?? 0;
          yield* engine.handoff(session.id, "pty", { mode: "pty" }, "user-fixture");
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    if (sessionId === null) throw new Error("no session");
    const home = `/run/mend/conv/${sessionId}`;
    // The terminal agent: the owner's, in H, with the neutral settings and its transcript there.
    const terminal = spawned.at(-1) ?? [];
    expect(terminal).not.toContain("stream-json");
    expect(terminal[terminal.indexOf("--resume") + 1]).toBe(
      `${home}/.claude/projects/-workspace-repo/${provider}.jsonl`,
    );
    expect(terminal.at(-2)).toBe("--settings");
    expect(opened.at(-1)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
    // No second move: the conversation already lives in C.
    expect(execCalls.filter(isStage).filter((argv) => argv[2]?.includes("moved=0"))).toHaveLength(
      1,
    );
    // The one-live-process lock: taken again, and held by the terminal agent.
    const holder = state.conversationHolders.get(sessionId);
    expect(holder?.fence).toBeGreaterThan(takesAtStart);
    const ptyAgent = [...state.conversationHolders.values()][0]?.processId ?? null;
    expect(ptyAgent).not.toBeNull();
  }, 30_000);

  it("a takeover that loses the conversation to a waiting turn's hand-over says so (review 2 of mend#572, P3-1)", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    let takesAtStart = 0;
    let lostWith = "";
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          if (alice === undefined) return yield* Effect.die("no protocol process");
          world.processes.set(
            alice.id,
            new SessionProcess({ ...alice, providerSessionId: provider }),
          );
          // What the harvest leaves for the terminal to resume.
          const stateDir = processStatePathOf(project.storePath, session.id, alice.id);
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(
            path.join(stateDir, "manifest.json"),
            JSON.stringify({
              harness: "claude",
              providerSessionId: provider,
              capturedAt: new Date().toISOString(),
            }),
          );
          takesAtStart = state.conversationHolders.get(session.id)?.fence ?? 0;
          // Maria's turn waits, and its hand-over takes the conversation first.
          const steering = attached[0]?.hooks.steering;
          if (steering === undefined) return yield* Effect.die("no steering");
          yield* steering.waiting({
            sessionId: session.id,
            processId: alice.id,
            turnId: AgentTurnId.make("turn-maria"),
            runsAs: "user-fixture",
            sender: MARIA,
            openTurn: false,
            work: [],
          });
          const held = state.conversationHolders.get(session.id);
          if (held === undefined) return yield* Effect.die("no holder");
          state.conversationHolders.set(session.id, {
            ...held,
            processId: null,
            fence: held.fence + 1,
            takenAt: Date.now(),
          });
          const lost = yield* engine
            .handoff(session.id, "pty", { mode: "pty" }, "user-fixture")
            .pipe(Effect.flip);
          lostWith = lost.message;
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
    expect(lostWith).toContain("waiting turn took the conversation first");
    // Nothing of the terminal's started, and the hand-over's take stands.
    expect(spawned.some((argv) => !argv.includes("stream-json") && argv[0] === "claude")).toBe(
      false,
    );
    expect(takesAtStart).toBeGreaterThan(0);
  }, 30_000);
});

/** What the host says at a hand-over's stop: the turn still waits and the process is quiescent. */
const atTheStop = (stillQuiescent: Effect.Effect<boolean> = Effect.succeed(true)) => ({
  stillQuiescent,
  endedCrons: 0,
});

/** A protocol host that records each attach with its hooks, and each stop for a hand-over. */
const steeringHost = (
  attached: Array<{
    readonly process: SessionProcess;
    readonly hooks: ProtocolHostHooks;
    readonly resumePath: string | null;
  }>,
  stops: Array<string>,
) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) =>
      Effect.sync(() => {
        attached.push({
          process: input.process,
          hooks: input.hooks,
          resumePath: input.resumePath ?? null,
        });
      }),
    rehydrate: () => Effect.void,
    submitTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(true),
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: (processId) =>
      Effect.sync(() => {
        stops.push(processId);
      }),
  });

describe("shared steering through the engine (docs/adr/0016, Delivery 18)", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const turnBy = (author: string | null, processId: SessionProcessId, sessionId: SessionId) =>
    new AgentTurn({
      id: AgentTurnId.make(`turn-${author ?? "mend"}`),
      sessionId,
      processId,
      ordinal: 0,
      author,
      input: "go",
      status: "running",
      providerTurnId: null,
      error: null,
      usage: null,
      createdAt: now(),
      startedAt: now(),
      endedAt: null,
    });

  it("B's turn runs as B with A's conversation, and a hand-over costs two Core calls, DELETE then POST, one stop and one start", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0];
          if (alice === undefined) return yield* Effect.die("no process attached");
          expect(alice.process.runsAs).toBe("user-fixture");
          const steering = alice.hooks.steering;
          if (steering === undefined)
            return yield* Effect.die("no steering for a person's process");
          // The conversation holds a transcript now, as its first turn leaves it.
          world.processes.set(
            alice.process.id,
            new SessionProcess({ ...alice.process, providerSessionId: provider }),
          );
          // Who each turn runs as: the owner's turn on her own process, Maria's in a new one of
          // hers, Mend's own as the owner.
          expect(
            yield* steering.decide(turnBy("user-fixture", alice.process.id, session.id)),
          ).toEqual({
            kind: "send",
          });
          expect(yield* steering.decide(turnBy(null, alice.process.id, session.id))).toEqual({
            kind: "send",
          });
          expect(yield* steering.decide(turnBy(MARIA, alice.process.id, session.id))).toEqual({
            kind: "hand-over",
            sender: MARIA,
          });

          // Maria's turn: her own user, her own login, Alice's conversation.
          yield* steering.handOver(MARIA, AgentTurnId.make("turn-maria"), atTheStop());
          const maria = attached[1];
          expect(maria?.process.runsAs).toBe(MARIA);
          expect(stops).toEqual([alice.process.id]);
          expect(world.processes.get(alice.process.id)?.exitedAt).not.toBeNull();
          const home = `/run/mend/conv/${session.id}`;
          const mariasOpen = opened.at(-1);
          const mariasUser =
            mariasOpen !== undefined && "user" in mariasOpen ? mariasOpen.user : undefined;
          expect(typeof mariasUser === "string" ? mariasUser : mariasUser?.name).toBe(
            linuxLoginNameOf(MARIA),
          );
          expect(mariasOpen?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
          const mariasArgv = spawned.at(-1) ?? [];
          expect(mariasArgv[mariasArgv.indexOf("--resume") + 1]).toBe(
            `${home}/.claude/projects/-workspace-repo/${provider}.jsonl`,
          );
          // Her own login into H, after Alice's was released; nobody else's is ever written.
          expect(calls.filter((call) => call.includes(home))).toEqual([
            `post:user-fixture:${home}`,
            `delete:${home}`,
            `post:${MARIA}:${home}`,
          ]);
          // One live process: Maria's holds the conversation now.
          expect(state.conversationHolders.get(session.id)?.processId).toBe(maria?.process.id);

          // And back to Alice: the hand-over's budget, with both people already made here.
          const steeringOfMaria = maria?.hooks.steering;
          if (steeringOfMaria === undefined || maria === undefined) {
            return yield* Effect.die("no steering for Maria's process");
          }
          world.processes.set(
            maria.process.id,
            new SessionProcess({ ...maria.process, providerSessionId: provider }),
          );
          const before = { calls: calls.length, opened: opened.length, stops: stops.length };
          yield* steeringOfMaria.handOver(
            "user-fixture",
            AgentTurnId.make("turn-alice"),
            atTheStop(),
          );
          expect(calls.slice(before.calls)).toEqual([
            `delete:${home}`,
            `post:user-fixture:${home}`,
          ]);
          expect(stops.length - before.stops).toBe(1);
          expect(opened.length - before.opened).toBe(1);
          expect(attached.at(-1)?.process.runsAs).toBe("user-fixture");
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
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
          execCalls,
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        harnessLayout: { flag: "person", state, platform: personPlatform(calls, { person: true }) },
      },
    );
  }, 30_000);

  /**
   * Alice's shared Claude conversation in a person executor, her process attached, and a hand-over
   * to Maria asked of its steering, as the host asks once Maria's turn has waited.
   */
  const handOverToMaria = async (options: {
    readonly logins?: (accountId: string) => "active" | "invalid" | "missing" | "unknown";
    readonly postFails?: (onBehalfOf: string, home: string) => boolean;
    /** What the host says at the stop (review 2 of mend#572, P2-2). */
    readonly stillQuiescent?: Effect.Effect<boolean>;
    /** Maria's next turn asks for the conversation again at once (review 2, P3-3). */
    readonly again?: boolean;
    /** The conversation then goes idle and Mend stops it, as the idle stop does. */
    readonly thenIdle?: boolean;
  }) => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const calls: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    const stops: Array<string> = [];
    const failed: Array<{ readonly turnId: string; readonly words: string }> = [];
    /** Every process whose open turns were cancelled (`cancelOpenForProcess`). */
    const swept: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const provider = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    let sessionId: SessionId | null = null;
    const result: {
      outcome: { readonly code: string; readonly message: string } | null;
      second: { readonly code: string; readonly message: string } | null;
      stopsBeforeSecond: number;
      summary: string | null;
    } = { outcome: null, second: null, stopsBeforeSecond: 0, summary: null };
    /** The session's status at every write, `settled` when the write settled it. */
    const statuses: Array<string> = [];
    const exec = (argv: ReadonlyArray<string>) => {
      if (isPrepare(argv)) return { exitCode: 0, stdout: LAYOUT_READY, stderr: "" };
      if (isStage(argv)) {
        const resume = (argv[2] ?? "").includes(provider)
          ? `mend-conv resume /run/mend/conv/${sessionId ?? ""}/.claude/projects/-workspace-repo/${provider}.jsonl\n`
          : "";
        const moved = (argv[2] ?? "").includes("moved=0") ? "mend-conv moved 1\n" : "";
        return { exitCode: 0, stdout: `${moved}${resume}mend-conv empty\n`, stderr: "" };
      }
      if (isExchange(argv)) {
        return { exitCode: 0, stdout: "mend-conv exchanged renameat2\n", stderr: "" };
      }
      return undefined;
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({ ...row, sharedControlEnabledAt: now(), sharedControlEverAt: now() }),
          );
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0];
          const steering = alice?.hooks.steering;
          if (alice === undefined || steering === undefined) {
            return yield* Effect.die("no steering for the owner's process");
          }
          world.processes.set(
            alice.process.id,
            new SessionProcess({ ...alice.process, providerSessionId: provider }),
          );
          const handed = yield* steering
            .handOver(MARIA, AgentTurnId.make("turn-maria"), atTheStop(options.stillQuiescent))
            .pipe(Effect.result);
          if (handed._tag === "Failure") {
            result.outcome = { code: handed.failure.code, message: handed.failure.message };
          }
          if (options.again === true) {
            result.stopsBeforeSecond = stops.length;
            const restarted = attached.at(-1);
            const again = yield* (restarted?.hooks.steering ?? steering)
              .handOver(MARIA, AgentTurnId.make("turn-maria-2"), atTheStop())
              .pipe(Effect.result);
            if (again._tag === "Failure") {
              result.second = { code: again.failure.code, message: again.failure.message };
            }
          }
          if (options.thenIdle === true) {
            yield* engine.stop(session.id, "idle");
            yield* until(
              () => (world.sessions.get(session.id)?.settledAt ?? null) !== null,
              "the idle stop's settle",
            );
          }
          result.summary = world.sessions.get(session.id)?.summary ?? null;
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => {
          world.members.set(MARIA, "member");
          const write = world.sessions.set.bind(world.sessions);
          world.sessions.set = (id, next) => {
            const before = world.sessions.get(id);
            if (before !== undefined && before.status !== next.status) {
              statuses.push(
                before.settledAt === null && next.settledAt !== null
                  ? `settled ${next.status}`
                  : next.status,
              );
            }
            return write(id, next);
          };
        },
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          [],
          undefined,
          { exec },
        ),
        protocolHostLayer: steeringHost(attached, stops),
        conversationLayer: Layer.succeed(AgentConversationRepo, {
          ...agentConversationStub,
          cancelOpenForProcess: (processId) => Effect.sync(() => void swept.push(processId)),
          failTurn: (turnId, words) =>
            Effect.sync(() => {
              failed.push({ turnId, words });
              return new AgentTurn({
                id: turnId,
                sessionId: sessionId ?? SessionId.make("no-session"),
                processId: SessionProcessId.make("process-maria"),
                ordinal: 1,
                author: MARIA,
                input: "go",
                status: "failed",
                providerTurnId: null,
                error: words,
                usage: null,
                createdAt: now(),
                startedAt: null,
                endedAt: now(),
              });
            }),
        }),
        harnessLayout: {
          flag: "person",
          state,
          platform: personPlatform(
            calls,
            { person: true },
            undefined,
            options.logins,
            options.postFails,
          ),
        },
      },
    );
    if (sessionId === null) throw new Error("no session");
    return {
      sessionId,
      spawned,
      opened,
      calls,
      attached,
      stops,
      failed,
      swept,
      state,
      outcome: result.outcome,
      second: result.second,
      stopsBeforeSecond: result.stopsBeforeSecond,
      summary: result.summary,
      statuses,
    };
  };

  it("a change of sender is not a settle: the session stays running through the hand-over, and settles once when it goes idle (review 0.36, S1)", async () => {
    const run = await handOverToMaria({ thenIdle: true });
    expect(run.outcome).toBeNull();
    expect(run.stops).toHaveLength(1);
    expect(run.attached.map((entry) => entry.process.runsAs)).toEqual(["user-fixture", MARIA]);
    // Alice's process stopped before Maria's started, and the session never read as settled or
    // idle between them: nothing for review prep, Slack or a phone to take as the end of work.
    const handOver = run.statuses.slice(0, run.statuses.indexOf("stopping"));
    expect(handOver.filter((status) => status !== "running")).toEqual([]);
    // The idle stop after it is the session's one settle.
    expect(run.statuses.filter((status) => status.startsWith("settled"))).toEqual([
      "settled stopped",
    ]);
  }, 30_000);

  it("a hand-over that leaves no process running settles once it ends (review 0.36, S1)", async () => {
    // Every write into the home after the owner's first fails: Maria's, then Alice's restart.
    let intoHome = 0;
    const run = await handOverToMaria({
      postFails: (_onBehalfOf, home) => home.startsWith("/run/mend/conv/") && intoHome++ > 0,
    });
    expect(run.outcome?.message).toContain("Core did not answer");
    expect(run.statuses.filter((status) => status.startsWith("settled"))).toEqual([
      "settled stopped",
    ]);
  }, 30_000);

  it("a hand-over that fails after the stop starts the conversation again as the person before, on their login, and fails the waiting turn with its line (review of mend#572, P2-2)", async () => {
    const run = await handOverToMaria({
      // Her own home's write goes through; the one into the conversation's home does not.
      postFails: (onBehalfOf, home) => onBehalfOf === MARIA && home.startsWith("/run/mend/conv/"),
    });
    const home = `/run/mend/conv/${run.sessionId}`;
    expect(run.outcome?.message).toContain("Core did not answer");
    // Alice's process was stopped for it; nothing of Maria's started.
    expect(run.stops).toHaveLength(1);
    expect(run.attached.map((entry) => entry.process.runsAs)).toEqual([
      "user-fixture",
      "user-fixture",
    ]);
    // The conversation goes on in a process of Alice's, on her own login, in its home.
    expect(run.calls.filter((call) => call.includes(home))).toEqual([
      `post:user-fixture:${home}`,
      `delete:${home}`,
      `post:${MARIA}:${home}`,
      `delete:${home}`,
      `post:user-fixture:${home}`,
    ]);
    expect(run.opened.at(-1)?.env?.["CLAUDE_CONFIG_DIR"]).toBe(`${home}/.claude`);
    const restarted = run.attached.at(-1)?.process;
    expect(run.state.conversationHolders.get(run.sessionId)?.processId).toBe(restarted?.id);
    // Maria's turn fails with the line, and says what went wrong.
    expect(run.failed).toEqual([
      { turnId: "turn-maria", words: expect.stringContaining("Core did not answer") },
    ]);
    // The turns queued behind hers are not cancelled: Alice's restarted process takes them.
    expect(run.swept).not.toContain(run.attached[0]?.process.id);
  }, 30_000);

  it("a hand-over whose turn is withdrawn while it is prepared stops nothing and writes nothing into the home (review 2 of mend#572, P2-2)", async () => {
    // S6: Maria withdraws while Mend asks Core for her login; the host's look at the stop says so.
    let withdrawn = false;
    const run = await handOverToMaria({
      logins: (accountId) => {
        if (accountId === MARIA) withdrawn = true;
        return "active";
      },
      stillQuiescent: Effect.sync(() => !withdrawn),
    });
    const home = `/run/mend/conv/${run.sessionId}`;
    expect(withdrawn).toBe(true);
    expect(run.outcome?.code).toBe("hand_over_not_now");
    expect(run.stops).toEqual([]);
    expect(run.attached).toHaveLength(1);
    expect(run.calls).not.toContain(`post:${MARIA}:${home}`);
    expect(run.calls.filter((call) => call === `delete:${home}`)).toEqual([]);
    // Alice's process still holds the conversation.
    expect(run.state.conversationHolders.get(run.sessionId)?.processId).toBe(
      run.attached[0]?.process.id,
    );
    expect(run.failed).toEqual([]);
  }, 30_000);

  it("a hand-over that failed after its stop is not tried again at once, and a restart that fails too says why on the session line (review 2 of mend#572, P3-2 and P3-3)", async () => {
    const backoff = await handOverToMaria({
      postFails: (onBehalfOf, home) => onBehalfOf === MARIA && home.startsWith("/run/mend/conv/"),
      again: true,
    });
    expect(backoff.second?.message).toContain("failed less than a minute ago");
    expect(backoff.stops).toHaveLength(backoff.stopsBeforeSecond);
    // Every write into the home after the owner's first fails: Maria's, then Alice's restart.
    let intoHome = 0;
    const restart = await handOverToMaria({
      postFails: (_onBehalfOf, home) => home.startsWith("/run/mend/conv/") && intoHome++ > 0,
    });
    expect(restart.outcome?.message).toContain("Core did not answer");
    expect(restart.summary).toContain("could not be started again");
    // The cause's own full stop is not doubled (RC 0.36.0-next.754, B-F4: `Nothing was sent..`).
    expect(restart.summary).toContain("could not be started again: Core did not answer. Resume");
    // No process takes the conversation's queue: what waited behind Maria's turn ends with the
    // stopped process, as at any stop.
    expect(restart.swept).toContain(restart.attached[0]?.process.id);
  }, 30_000);

  it("a hand-over whose sender's login went invalid while the turn waited stops nothing (review of mend#572, P2-2)", async () => {
    // Her turn was queued while her login stood; it needs reconnecting by the hand-over.
    const run = await handOverToMaria({
      logins: (accountId) => (accountId === MARIA ? "invalid" : "active"),
    });
    expect(run.outcome).toEqual({
      code: "person_login_refused",
      message:
        "Your Claude login needs reconnecting. Reconnect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    });
    expect(run.stops).toEqual([]);
    expect(run.attached).toHaveLength(1);
    expect(run.calls.some((call) => call.startsWith(`post:${MARIA}:`))).toBe(false);
    expect(run.failed).toEqual([]);
  }, 30_000);

  it("a follow-up and a launch that opens with a steerer's words check the steerer's own login (review of mend#572, P2-2)", async () => {
    const refusals: Array<string> = [];
    const calls: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(session.id, new Session({ ...row, sharedControlEnabledAt: now() }));
          const followUp = yield* engine
            .launchFollowUp(session.id, "fix the review comment", "corr-1", MARIA)
            .pipe(Effect.flip);
          refusals.push(followUp.message);
          const launched = yield* engine
            .launchProtocol(session.id, { mode: "protocol", prompt: "start here" }, MARIA)
            .pipe(Effect.flip);
          refusals.push(launched.message);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        harnessLayout: {
          flag: "person",
          platform: personPlatform(calls, { person: true }, undefined, () => "missing"),
        },
      },
    );
    expect(refusals).toEqual([
      "Connect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
      "Connect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    ]);
    expect(calls).toEqual([`login:${MARIA}`, `login:${MARIA}`]);
  }, 30_000);

  it("only the person a process runs as answers its agent's questions; a steerer sends a turn instead (owner's rule, review 2 of mend#572)", async () => {
    const answered: Array<string> = [];
    const refusals: Array<string> = [];
    const attached: Array<{
      readonly process: SessionProcess;
      readonly hooks: ProtocolHostHooks;
      readonly resumePath: string | null;
    }> = [];
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
    const askedBy = (processId: SessionProcessId, sessionId: SessionId) =>
      new AgentRequest({
        id: AgentRequestId.make("request-1"),
        sessionId,
        processId,
        turnId: AgentTurnId.make("turn-alice"),
        kind: "tool-permission",
        providerRequestId: "provider-request-1",
        providerItemId: null,
        title: "Run npm test?",
        detail: null,
        questions: null,
        status: "pending",
        decision: null,
        decidedBy: null,
        answers: null,
        createdAt: now(),
        decidedAt: null,
      });
    let asking: AgentRequest | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          // Alice's own process in a person executor: it runs as her.
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
          const alice = attached[0]?.process;
          expect(alice?.runsAs).toBe("user-fixture");
          if (alice === undefined) return yield* Effect.die("no protocol process");
          asking = askedBy(alice.id, session.id);
          const steerer = yield* engine
            .respondRequest(AgentRequestId.make("request-1"), { decision: "accept" }, MARIA)
            .pipe(Effect.flip);
          refusals.push(steerer.message);
          yield* engine.respondRequest(
            AgentRequestId.make("request-1"),
            { decision: "accept" },
            "user-fixture",
          );
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        protocolHostLayer: Layer.succeed(ProtocolHost, {
          attach: (input) =>
            Effect.sync(() => {
              attached.push({ process: input.process, hooks: input.hooks, resumePath: null });
            }),
          rehydrate: () => Effect.void,
          submitTurn: () => Effect.die("not in test"),
          interruptTurn: () => Effect.void,
          respondRequest: (request, _response, decidedBy) =>
            Effect.sync(() => {
              answered.push(decidedBy);
              return request;
            }),
          detach: () => Effect.void,
          has: () => Effect.succeed(true),
          quiescence: () => Effect.succeed(null),
          awaitQuiescent: () => Effect.void,
          endWork: () => Effect.void,
          detachForHandOver: () => Effect.void,
        }),
        conversationLayer: Layer.succeed(AgentConversationRepo, {
          ...agentConversationStub,
          byRequestId: () => Effect.sync(() => asking),
        }),
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatch(/^Only .+ can answer this; send a turn instead\.$/);
    // The owner's own answer reaches the agent; Maria's never did.
    expect(answered).toEqual(["user-fixture"]);
  }, 30_000);

  /** A Claude conversation of Alice's in a person executor, shared, and a turn sent to it. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const submitScenario = async (options: {
    readonly harness: "claude" | "opencode";
    readonly author: string;
    readonly logins?: (accountId: string) => "active" | "invalid" | "missing" | "unknown";
  }) => {
    const calls: Array<string> = [];
    const submitted: Array<string> = [];
    let refused: string | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: options.harness,
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          const row = world.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          world.sessions.set(
            session.id,
            new Session({
              ...row,
              sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
              sharedControlEnabledAt: now(),
            }),
          );
          const sent = yield* engine
            .submitTurn(session.id, "please", options.author)
            .pipe(Effect.result);
          if (sent._tag === "Failure" && sent.failure._tag === "SessionTurnRefusedError") {
            refused = sent.failure.message;
          }
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        protocolHostLayer: recordingProtocolHostLayer([], submitted),
        harnessLayout: {
          flag: "person",
          platform: personPlatform(calls, { person: true }, undefined, options.logins),
        },
      },
    );
    return { calls, submitted, refused };
  };

  it("refuses a steerer whose own login is missing or needs reconnecting, before anything is queued", async () => {
    const missing = await submitScenario({
      harness: "claude",
      author: MARIA,
      logins: () => "missing",
    });
    expect(missing.refused).toBe(
      "Connect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    expect(missing.submitted).toEqual([]);
    const invalid = await submitScenario({
      harness: "claude",
      author: MARIA,
      logins: () => "invalid",
    });
    expect(invalid.refused).toBe(
      "Your Claude login needs reconnecting. Reconnect Claude to steer this session. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    // Connected: queued, on the conversation, with one look at Core.
    const active = await submitScenario({ harness: "claude", author: MARIA });
    expect(active.refused).toBeNull();
    expect(active.submitted).toEqual(["please"]);
    expect(active.calls).toEqual([`login:${MARIA}`]);
  }, 30_000);

  it("the owner's own turns ask Core nothing", async () => {
    const own = await submitScenario({
      harness: "claude",
      author: "user-fixture",
      logins: () => "missing",
    });
    expect(own.refused).toBeNull();
    expect(own.calls).toEqual([]);
  }, 30_000);

  it("refuses another person's turn to an opencode session: it is one person's", async () => {
    const run = await submitScenario({ harness: "opencode", author: MARIA });
    expect(run.refused).toBe(
      "opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.",
    );
    expect(run.submitted).toEqual([]);
  }, 30_000);

  it("a process whose person is not recorded, in a person executor, takes its owner's turns only (review of mend#572, P1-1)", async () => {
    // A Claude protocol process started before steering, so `runs_as` was never written, and
    // restored after Mend restarts: Maria's turn must never run on the owner's login there.
    const sessionId = SessionId.make("session-unrecorded");
    const runId = SealantRunId.make("run-unrecorded");
    const workspaceId = SealantWorkspaceId.make("workspace-1");
    const state = makeHarnessLayoutsMemoryState();
    const restored: Array<{ readonly process: SessionProcess; readonly hooks: ProtocolHostHooks }> =
      [];
    const host = Layer.succeed(ProtocolHost, {
      attach: () => Effect.die("not in test"),
      rehydrate: (input) =>
        Effect.sync(() => {
          restored.push({ process: input.process, hooks: input.hooks });
        }),
      submitTurn: () => Effect.die("not in test"),
      interruptTurn: () => Effect.void,
      respondRequest: () => Effect.die("not in test"),
      detach: () => Effect.void,
      has: () => Effect.succeed(true),
      quiescence: () => Effect.succeed(null),
      awaitQuiescent: () => Effect.void,
      endWork: () => Effect.void,
      detachForHandOver: () => Effect.void,
    });
    await withEngine(
      (world) =>
        Effect.gen(function* () {
          yield* eventually("the process restored", Duration.seconds(5), () => restored.length > 0);
          const steering = restored[0]?.hooks.steering;
          if (steering === undefined) return yield* Effect.die("no steering for the process");
          const processId = SessionProcessId.make("agent-boot");
          expect(yield* steering.decide(turnBy(MARIA, processId, sessionId))).toEqual({
            kind: "refuse",
            words: expect.stringContaining("owner"),
          });
          expect(yield* steering.decide(turnBy("user-fixture", processId, sessionId))).toEqual({
            kind: "send",
          });
          expect(yield* steering.decide(turnBy(null, processId, sessionId))).toEqual({
            kind: "send",
          });
          expect(world.processes.get("agent-boot")?.runsAs).toBeNull();
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world, tmp) => {
          world.members.set(MARIA, "member");
          seedStoppedBeforeRestart(world, tmp, {
            sessionId,
            runId,
            workspaceId,
            processLive: true,
          });
          const session = world.sessions.get(sessionId);
          const process = world.processes.get("agent-boot");
          if (session === undefined || process === undefined) throw new Error("not seeded");
          world.sessions.set(
            sessionId,
            new Session({
              ...session,
              harness: "claude",
              sharedControlEnabledAt: now(),
              sharedControlEverAt: now(),
            }),
          );
          world.processes.set(
            "agent-boot",
            new SessionProcess({
              ...process,
              kind: "agent-protocol",
              harness: "claude",
              label: "claude",
              argv: ["claude"],
              runsAs: null,
            }),
          );
          world.executorLaunches.set(sessionId, { workspaceId, launchId: "launch-unrecorded" });
          state.launches.set("launch-unrecorded", {
            launchId: "launch-unrecorded",
            worktreeId: WorktreeId.make("wt-boot"),
            sessionId,
            layout: "person",
            source: "flag",
            reason: null,
            imageKey: null,
            confirmed: true,
          });
        },
        sealantLayer: sealantLaunchLayer([]),
        protocolHostLayer: host,
        harnessLayout: { flag: "person", state, platform: personPlatform([], { person: true }) },
      },
    );
  }, 30_000);

  it("in a person executor, only the change owner's own Claude processes keep scheduled prompts", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(holder.id, ["claude"]);
          const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          yield* engine.launch(joined.id, ["claude"]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
    const claudes = spawned.filter((argv) => argv.includes("claude"));
    expect(claudes).toHaveLength(2);
    // Alice made the worktree: hers keep crons, with only the session-state switch.
    expect(claudes[0]?.slice(-2)).toEqual([
      "--settings",
      JSON.stringify({ env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" } }),
    ]);
    // Maria's personal Claude in Alice's worktree: no scheduled prompts, whatever the repository says.
    expect(claudes[1]?.slice(-2)).toEqual([
      "--settings",
      JSON.stringify({
        env: { CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      }),
    ]);
  }, 30_000);
});

const isRetireCheck = (argv: ReadonlyArray<string>) => (argv[2] ?? "").includes("mend-retire");

/** What the change's owner is shown, and its fingerprint. */
const shownTo = (engine: SessionEngine["Service"], session: Session, viewer = "user-fixture") =>
  engine
    .workspaceRetirement(session.id, viewer)
    .pipe(
      Effect.flatMap((retirement) =>
        retirement === null ? Effect.die("no retirement") : Effect.succeed(retirement),
      ),
    );

describe("pre-release executors and the migration of their shared home (docs/adr/0016, Delivery 19)", () => {
  const IMAGE_KEY = "digest:sha256:img\u0000docker";

  /** A protocol host whose agents say they are quiescent, or have a turn in flight. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const quiescentHost = (busy: () => boolean) =>
    Layer.succeed(ProtocolHost, {
      attach: () => Effect.void,
      rehydrate: () => Effect.void,
      submitTurn: (sessionId, input, author) =>
        Effect.succeed(
          new AgentTurn({
            id: AgentTurnId.make(`turn-${crypto.randomUUID()}`),
            sessionId,
            processId: SessionProcessId.make("process"),
            ordinal: 0,
            author,
            input,
            status: "queued",
            providerTurnId: null,
            error: null,
            usage: null,
            createdAt: now(),
            startedAt: null,
            endedAt: null,
          }),
        ),
      interruptTurn: () => Effect.void,
      respondRequest: () => Effect.die("not in test"),
      detach: () => Effect.void,
      has: () => Effect.succeed(true),
      quiescence: () =>
        Effect.sync(() => ({
          quiescent: !busy(),
          openTurn: busy(),
          work: [],
          settleMs: 0,
        })),
      awaitQuiescent: () => Effect.void,
      endWork: () => Effect.void,
      detachForHandOver: () => Effect.void,
    });

  /**
   * A worktree whose launch ran `shared` with the flag on (its image not yet known, so prepare
   * probed it and found it can run per person), on an image a per-person launch has confirmed
   * since: its next launch would be `person`. The first prepare answers the probe, every later
   * one makes the launcher.
   */
  const retiringWorld = async (
    run: (
      engine: SessionEngine["Service"],
      world: World,
      ids: { readonly session: Session; readonly order: ReadonlyArray<string> },
    ) => Effect.Effect<void, unknown, Store | WorktreesRepo | Scope.Scope | SessionEngine>,
    options: {
      readonly busy?: () => boolean;
      readonly saved?: () => boolean;
      readonly retireCheck?: () => string;
      readonly state?: HarnessLayoutsMemoryState;
      /** Whether a per-person launch has confirmed the image since; yes unless a test says. */
      readonly confirmed?: boolean;
      /** Holds a PTY's open on the platform until it completes (a slow start). */
      readonly aroundOpen?: () => Effect.Effect<void>;
    } = {},
  ) => {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const order: Array<string> = [];
    const scripts: Array<string> = [];
    const flushKinds: Array<CaptureFlushKind> = [];
    const memory = makeMemoryCaptureStore();
    const state = options.state ?? makeHarnessLayoutsMemoryState();
    let prepares = 0;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "auth",
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", prompt: "fix it", permissionMode: "bypass" },
            "user-fixture",
          );
          const launched = world.sessions.get(session.id);
          if (launched === undefined) return yield* Effect.die("no session");
          // A per-person launch elsewhere has since confirmed the image: a shared probe's yes
          // alone retires nothing (review of mend#582, finding 1).
          if (options.confirmed !== false) {
            for (const [key, record] of state.capabilities) {
              state.capabilities.set(key, { ...record, confirmed: true });
            }
          }
          yield* run(engine, world, { session: launched, order });
        }),
      {
        captured: memory,
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        protocolHostLayer: quiescentHost(options.busy ?? (() => false)),
        drainPolicy: { stallSeconds: 1 },
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          {
            flushKinds,
            ...(options.aroundOpen === undefined ? {} : { aroundOpen: options.aroundOpen }),
            // sealantd's record of each process: its pid, which the retire check counts as Mend's.
            timeline: (runId) => [
              {
                sequence: 1n,
                occurredAt: "2026-10-08T10:00:00Z",
                summary: "started",
                kind: "processStarted",
                data: {
                  pid: 100 + Number(runId.replace(/\D/g, "") || "0"),
                  pgid: 100,
                  pidfd: true,
                  executable: "codex",
                  args: [],
                  cwd: "/workspace/repo",
                  startedAt: "0",
                },
              },
            ],
            flush: (target) =>
              Effect.sync(() => {
                order.push(`flush:${target.id}`);
                const saved = options.saved?.() ?? true;
                return captureAnswer({
                  ...headReport(memory),
                  ...(saved ? {} : { pending: 3, pendingBytes: 1024 }),
                });
              }),
            stopAnswer: () => {
              order.push("stop");
              return "stopped";
            },
            exec: (argv) => {
              if (isRetireCheck(argv)) {
                order.push("check");
                scripts.push(argv[2] ?? "");
                return {
                  exitCode: 0,
                  stdout: options.retireCheck?.() ?? "mend-retire checked\n",
                  stderr: "",
                };
              }
              if (argv[0] === "sh" && isPrepare(argv)) {
                prepares += 1;
                return {
                  exitCode: 0,
                  stdout: prepares === 1 ? "mend-layout probed\n" : LAYOUT_READY,
                  stderr: "",
                };
              }
              return undefined;
            },
          },
        ),
        harnessLayout: { flag: "person", state, platform: personPlatform([], { person: null }) },
      },
    );
    return { created, execCalls, order, flushKinds, state, scripts };
  };

  it(
    "replaces a shared executor on its own only after its final flush is saved, and the worktree's next launch runs per person",
    { timeout: 30_000 },
    async () => {
      const run = await retiringWorld((engine, world, { session }) =>
        Effect.gen(function* () {
          expect(world.sessions.get(session.id)?.sealantWorkspaceId).not.toBeNull();
          expect(yield* engine.workspaceRetirement(session.id, "user-fixture")).toBeNull();
          yield* engine.sweepRetirements();
        }),
      );
      expect(run.state.capabilities.get(IMAGE_KEY)?.person).toBe(true);
      // The check counted the agent's pid from its record (run-2, as the stand-in numbers it).
      expect(run.scripts[0]).toContain("for e in 102:0;");
      const check = run.order.indexOf("check");
      const flush = run.order.findIndex((entry) => entry.startsWith("flush:"));
      const stop = run.order.indexOf("stop");
      expect(check).toBeGreaterThanOrEqual(0);
      expect(flush).toBeGreaterThan(check);
      expect(stop).toBeGreaterThan(flush);
      expect(run.flushKinds).toContain("final");
      expect(run.created).toHaveLength(2);
      expect([...run.state.worktrees.values()].map((worktree) => worktree.layout)).toContain(
        "person",
      );
      expect([...run.state.retirements.values()]).toEqual([]);
    },
  );

  it(
    "retires nothing on a shared probe's yes alone: only an answer a per-person executor gave replaces a live executor (review of mend#582, finding 1)",
    { timeout: 30_000 },
    async () => {
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            expect(yield* engine.workspaceRetirement(session.id, "user-fixture")).toBeNull();
          }),
        { confirmed: false },
      );
      expect(run.state.capabilities.get(IMAGE_KEY)).toMatchObject({
        person: true,
        confirmed: false,
      });
      expect(run.order).not.toContain("check");
      expect(run.order).not.toContain("stop");
      expect(run.created).toHaveLength(1);
      expect([...run.state.retirements.values()]).toEqual([]);
    },
  );

  it(
    "says a steered turn spends the owner's logins in a shared executor with the flag on, and runs on its sender's once the executor is per person (review of mend#576, P1-2)",
    { timeout: 30_000 },
    async () => {
      const answers: Array<boolean> = [];
      await retiringWorld((engine, world, { session }) =>
        Effect.gen(function* () {
          answers.push(yield* engine.steersPerPerson(session));
          yield* engine.sweepRetirements();
          const relaunched = world.sessions.get(session.id);
          if (relaunched === undefined) return yield* Effect.die("no session");
          answers.push(yield* engine.steersPerPerson(relaunched));
        }),
      );
      expect(answers).toEqual([false, true]);
    },
  );

  it(
    "keeps the executor when its final flush is not saved, and says why: nothing is lost",
    { timeout: 30_000 },
    async () => {
      let shown: { readonly state: string; readonly reason: string | null } | null = null;
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            const retirement = yield* shownTo(engine, session);
            shown = { state: retirement.state, reason: retirement.reason };
          }),
        { saved: () => false },
      );
      expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
      expect(run.created).toHaveLength(1);
      // Its final flush was sent: it stays `retiring` while its drain asks again, as it would
      // after a restart, and says why (review 2 of mend#575).
      expect(shown).toEqual({
        state: "retiring",
        reason: "not replaced yet · the final flush was not saved (kept)",
      });
    },
  );

  it(
    "never replaces on its own an executor with a hand-started Service, and refuses others' joins, turns and follow-ups until it is replaced",
    { timeout: 30_000 },
    async () => {
      const run_state = makeHarnessLayoutsMemoryState();
      let seen: WorkspaceRetirement | null = null;
      let asMaria: WorkspaceRetirement | null = null;
      let joinRefusal = "";
      let turnRefusal = "";
      let followUpRefusal = "";
      let ownTurn: string | null = null;
      const run = await retiringWorld(
        (engine, world, { session }) =>
          Effect.gen(function* () {
            yield* engine.runService(session.id, ["sh", "-c", "sleep 600"], 5173, "web", "tcp");
            // The executor started before this release: no layout recorded for its launch.
            const launch = world.executorLaunches.get(session.id)?.launchId;
            if (launch !== undefined) run_state.launches.delete(launch);
            yield* engine.sweepRetirements();
            seen = yield* shownTo(engine, session);
            asMaria = yield* shownTo(engine, session, MARIA);
            const joined = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            joinRefusal = yield* engine.launch(joined.id, ["claude"]).pipe(
              Effect.flip,
              Effect.map((error) => (error instanceof SealantPlatformError ? error.message : "")),
            );
            turnRefusal = yield* engine.submitTurn(session.id, "hello", MARIA).pipe(
              Effect.flip,
              Effect.map((error) =>
                error instanceof SessionTurnRefusedError ? error.message : "",
              ),
            );
            // A reviewer's follow-up is a turn too (review of mend#575, P2-1).
            followUpRefusal = yield* engine
              .launchFollowUp(session.id, "address the comments", "follow-up-1", MARIA)
              .pipe(
                Effect.flip,
                Effect.map((error) => (error instanceof SealantPlatformError ? error.message : "")),
              );
            ownTurn = (yield* engine.submitTurn(session.id, "go on", "user-fixture")).input;
            expect(world.sessions.get(joined.id)?.status).toBe("failed");
          }),
        { state: run_state },
      );
      expect(seen).toMatchObject({
        state: "marked",
        preRelease: true,
        launcher: "user-fixture",
        stops: [{ kind: "service", label: "auth · web" }],
        canReplace: true,
      });
      expect(seen).not.toMatchObject({ checkedAt: null });
      // Checked, never flushed for good, never stopped.
      expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
      expect(run.flushKinds).not.toContain("final");
      expect(asMaria).toMatchObject({ canReplace: false });
      expect(joinRefusal).toBe(
        "This worktree's workspace started before Mend 0.36 and shares one home; it takes another person once it is replaced.",
      );
      expect(turnRefusal).toBe(joinRefusal);
      expect(followUpRefusal).toBe(joinRefusal);
      expect(ownTurn).toBe("go on");
    },
  );

  it(
    "lists what runs in it that Mend did not start, and its containers, by name to the owner only; replaces on its own once they have gone",
    { timeout: 30_000 },
    async () => {
      let answer =
        "mend-retire process 31 python\nmend-retire container pg (postgres:17)\nmend-retire checked\n";
      let first: WorkspaceRetirement | null = null;
      let other: WorkspaceRetirement | null = null;
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            first = yield* shownTo(engine, session);
            other = yield* shownTo(engine, session, MARIA);
            answer = "mend-retire checked\n";
            yield* engine.sweepRetirements();
          }),
        { retireCheck: () => answer },
      );
      expect(first).toMatchObject({
        state: "marked",
        stops: [
          { kind: "process", label: "python (pid 31)" },
          { kind: "container", label: "pg (postgres:17)" },
        ],
        reason: "not replaced · 1 process Mend did not start, 1 running container",
      });
      // Anyone else who sees the session sees what kind of thing would stop, not its name.
      expect(other).toMatchObject({
        stops: [
          { kind: "process", label: "" },
          { kind: "container", label: "" },
        ],
      });
      expect(run.order.at(-1)).toBe("stop");
    },
  );

  it(
    "sees a start the launcher began before the check: it would stop, so nothing is replaced (review 2 of mend#575, P2-B)",
    { timeout: 30_000 },
    async () => {
      const open = Effect.runSync(Deferred.make<void>());
      let holding = false;
      let shown: ReadonlyArray<string> = [];
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            // The launcher's second session joins the executor; its start is under way.
            const second = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: "second",
              ownerUserId: "user-fixture",
            });
            holding = true;
            const starting = yield* Effect.forkChild(engine.launch(second.id, ["claude"]));
            yield* Effect.sleep("100 millis");
            yield* engine.sweepRetirements();
            shown = (yield* shownTo(engine, session)).stops.map((stop) => stop.label);
            yield* Deferred.succeed(open, undefined);
            yield* Fiber.join(starting).pipe(Effect.ignore);
          }),
        { aroundOpen: () => (holding ? Deferred.await(open) : Effect.void) },
      );
      expect(shown).toContain("second · a start under way");
      expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
      expect(run.flushKinds).not.toContain("final");
    },
  );

  it(
    "holds an automatic replacement when the containers cannot be checked, and says why",
    { timeout: 30_000 },
    async () => {
      let shown: WorkspaceRetirement | null = null;
      const run = await retiringWorld(
        (engine, _world, { session }) =>
          Effect.gen(function* () {
            yield* engine.sweepRetirements();
            shown = yield* shownTo(engine, session);
          }),
        {
          retireCheck: () =>
            "mend-retire unknown running containers: docker ps failed (Cannot connect to the Docker daemon)\nmend-retire checked\n",
        },
      );
      expect(shown).toMatchObject({
        stops: [
          {
            kind: "unchecked",
            label: "running containers: docker ps failed (Cannot connect to the Docker daemon)",
          },
        ],
        reason: "not replaced · 1 thing Mend could not check",
      });
      expect(run.order.filter((entry) => entry === "stop")).toEqual([]);
    },
  );

  it(
    "lets only the change's owner replace it now, never with a turn in flight, and never ending more than they were shown",
    { timeout: 30_000 },
    async () => {
      let busy = false;
      let answer = "mend-retire checked\n";
      const refusals: Array<string> = [];
      const run = await retiringWorld(
        (engine, _world, { session, order }) =>
          Effect.gen(function* () {
            yield* engine.runService(session.id, ["sh", "-c", "sleep 600"], 5173, "web", "tcp");
            yield* engine.sweepRetirements();
            const refused = (actor: string, seen: string) =>
              engine.replaceWorkspaceNow(session.id, actor, seen).pipe(
                Effect.flip,
                Effect.map((error) =>
                  error instanceof WorkspaceReplaceRefusedError ? error.message : "",
                ),
              );
            const shown = yield* shownTo(engine, session);
            refusals.push(yield* refused(MARIA, shown.fingerprint));
            // A turn starts after the owner looked.
            busy = true;
            refusals.push(yield* refused("user-fixture", shown.fingerprint));
            busy = false;
            // A detached job starts after the owner looked: nothing they were not shown ends.
            yield* engine.sweepRetirements();
            const again = yield* shownTo(engine, session);
            answer = "mend-retire process 40 node\nmend-retire checked\n";
            refusals.push(yield* refused("user-fixture", again.fingerprint));
            expect(order.includes("stop")).toBe(false);
            // Shown it, the owner replaces it.
            yield* engine.sweepRetirements();
            const latest = yield* shownTo(engine, session);
            expect(latest.stops.map((stop) => stop.kind)).toEqual(["service", "process"]);
            yield* engine.replaceWorkspaceNow(session.id, "user-fixture", latest.fingerprint);
            yield* until(() => order.includes("stop"), "the replacement");
          }),
        { busy: () => busy, retireCheck: () => answer },
      );
      expect(refusals).toEqual([
        "Only the change's owner replaces this worktree's workspace.",
        "An agent's turn or background work is in flight in this workspace. Replace it once that has finished.",
        "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.",
      ]);
      // The owner's replacement checked what runs in it again, and waited for a saved flush.
      const lastCheck = run.order.lastIndexOf("check");
      expect(lastCheck).toBeLessThan(run.order.indexOf("stop"));
      expect(run.flushKinds).toContain("final");
    },
  );

  it(
    "takes a replacement a crash left retiring back to marked: on the sweep once stale, and when the owner asks again",
    { timeout: 30_000 },
    async () => {
      const run_state = makeHarnessLayoutsMemoryState();
      let afterSweep: string | null = null;
      let ownTurn: string | null = null;
      const run = await retiringWorld(
        (engine, _world, { session, order }) =>
          Effect.gen(function* () {
            yield* engine.runService(session.id, ["sh", "-c", "sleep 600"], 5173, "web", "tcp");
            yield* engine.sweepRetirements();
            const workspaceId = session.sealantWorkspaceId ?? "";
            const crashed = (minutesAgo: number) => {
              const row = run_state.retirements.get(workspaceId);
              if (row === undefined) throw new Error("not marked");
              run_state.retirements.set(workspaceId, {
                ...row,
                state: "retiring",
                updatedAt: new Date(Date.now() - minutesAgo * 60_000),
              });
            };
            // A fresh one is left alone: a replacement in another process may still run it.
            crashed(1);
            yield* engine.sweepRetirements();
            expect(run_state.retirements.get(workspaceId)?.state).toBe("retiring");
            // Stale: back to marked, with why, and the launcher's turns go ahead again.
            crashed(11);
            yield* engine.sweepRetirements();
            afterSweep = run_state.retirements.get(workspaceId)?.reason ?? null;
            ownTurn = (yield* engine.submitTurn(session.id, "go on", "user-fixture")).input;
            // A restart in the middle (nothing here moves it): the owner's ask takes it back first
            // and goes ahead, never answering ok while doing nothing.
            crashed(1);
            const shown = yield* shownTo(engine, session);
            yield* engine.replaceWorkspaceNow(session.id, "user-fixture", shown.fingerprint);
            yield* until(() => order.includes("stop"), "the replacement");
          }),
        { state: run_state },
      );
      expect(afterSweep).toBe("not replaced · the replacement did not finish; looked at again");
      expect(ownTurn).toBe("go on");
      expect(run.flushKinds).toContain("final");
    },
  );
});

describe("the migration of an old shared home's memory (docs/adr/0016, Delivery 19)", () => {
  const MEMORY = `${PROJECT_DIR}/memory/MEMORY.md`;
  const NOTES = ".codex/memories/notes.md";

  /**
   * A worktree whose last executor ran `shared`: its home's memory written in two captures, the
   * migration run once between them (provisional) and twice after the worktree turned person.
   */
  const migrateAcrossTheTurn = async (options: {
    readonly maria: boolean;
    /** Maria is a member of the organization; true unless said. */
    readonly mariaMember?: boolean;
    /** The owner record holds every session, deleted ones included; true unless said. */
    readonly complete?: boolean;
    /** Whose memory the home holds as the server recorded it, left in place of nothing. */
    readonly homes?: (worktreeId: string) => AgentMemoryHomes;
  }) => {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const memory = makeMemoryCaptureStore();
    const state = makeHarnessLayoutsMemoryState();
    const homes = new Map<string, AgentMemoryHomes>();
    const readBacks: Array<Parameters<AgentMemoryRepo["Service"]["readBack"]>[0]> = [];
    const records: Array<PreReleaseMigrationRecord | null> = [];
    const chainBefore: Array<number> = [];
    const chainAfter: Array<number> = [];
    let execsBefore = 0;
    let execsAfter = 0;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "before",
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launch(session.id, ["claude"]);
          // Who ever had a session in the worktree, as the durable record keeps it.
          state.sessionOwners.set(session.worktreeId, {
            owners: options.maria ? ["user-fixture", MARIA] : ["user-fixture"],
            complete: options.complete ?? true,
          });
          if (options.maria) {
            // Maria joined the shared home before 0.36: whose lines are whose cannot be told.
            const joined = yield* engine.provisionSessionIn(session.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            yield* engine.launch(joined.id, ["claude"]);
          }
          const request = created[0];
          if (request === undefined) return yield* Effect.die("the launch made no executor");
          const executorRoot = path.join(tmp, "shared-executor");
          const home = configuredHarnessHomePath(request, executorRoot);
          const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
          writeUnder(home, MEMORY, "- first\n");
          yield* shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          );
          // No record of whose memory the home holds: the sessions decide (unless a test says).
          const recorded = () => {
            homes.clear();
            if (options.homes !== undefined) {
              homes.set(session.worktreeId, options.homes(session.worktreeId));
            }
          };
          recorded();
          records.push(yield* engine.migratePreReleaseMemory(session.worktreeId));
          // The shared executor goes on writing after the provisional run.
          writeUnder(home, MEMORY, "- first\n- second\n");
          writeUnder(home, NOTES, "codex learned\n");
          yield* shipCapturedHarnessHome(
            tmp,
            memory,
            session.worktreeId,
            epoch,
            request,
            executorRoot,
          );
          recorded();
          // Its final flush was the last shared-layout capture: the worktree runs per person now.
          state.worktrees.set(session.worktreeId, { layout: "person", requested: null });
          const chain = memory.chains.get(session.worktreeId);
          chainBefore.push(chain?.headN ?? -1);
          execsBefore = execCalls.length;
          records.push(yield* engine.migratePreReleaseMemory(session.worktreeId));
          records.push(yield* engine.migratePreReleaseMemory(session.worktreeId));
          execsAfter = execCalls
            .slice(execsBefore)
            .filter((argv) => argv.join(" ").includes("memor")).length;
          chainAfter.push(memory.chains.get(session.worktreeId)?.headN ?? -1);
        }),
      {
        captured: memory,
        prepareWorld: (world) => {
          if (options.mariaMember === false) world.members.delete(MARIA);
          else world.members.set(MARIA, "member");
        },
        agentMemoryLayer: agentMemoryLayerOf(
          {
            readBack: (input) =>
              Effect.sync(() => {
                if (input.sessionId.startsWith("pre-release:")) readBacks.push(input);
                return {
                  saved: input.session.map((file) => file.path),
                  merged: [],
                  deleted: [],
                  skipped: [],
                };
              }),
          },
          homes,
        ),
        sealantLayer: sealantLaunchLayer(
          created,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          execCalls,
          undefined,
          { flush: headFlush(memory) },
        ),
        harnessLayout: { flag: "shared", state },
      },
    );
    return { readBacks, records, chainBefore, chainAfter, execsBefore, execsAfter };
  };

  it(
    "credits what a shared executor wrote after a provisional run once the worktree turns person, and a re-run credits nothing twice",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: false });
      const [provisional, final, again] = run.records;
      expect(provisional).toMatchObject({
        final: false,
        captureN: 1,
        creditedTo: "user-fixture",
        decidedBy: "only-person",
        notCredited: [],
      });
      expect(final).toMatchObject({ final: true, captureN: 2, creditedTo: "user-fixture" });
      expect(again).toEqual(final);
      // The provisional run credited the first line; the final run only what came after it,
      // read back against what the first run credited.
      expect(run.readBacks.map((input) => input.userId)).toEqual(["user-fixture", "user-fixture"]);
      expect(run.readBacks[0]?.session.map((file) => [file.path, file.contents])).toEqual([
        [MEMORY, "- first\n"],
      ]);
      expect(
        run.readBacks[1]?.session
          .map((file) => [file.path, file.contents])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual(
        [
          [NOTES, "codex learned\n"],
          [MEMORY, "- first\n- second\n"],
        ].toSorted(([a], [b]) => String(a).localeCompare(String(b))),
      );
      expect(Object.keys(run.readBacks[1]?.delivered ?? {})).toEqual([MEMORY]);
      // It reads a capture and records: no exec touches memory, nothing added to the chain.
      expect(run.execsAfter).toBe(0);
      expect(run.chainAfter).toEqual(run.chainBefore);
    },
  );

  it(
    "credits nobody memory two people's sessions shared, and lists it on the worktree as not credited",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: true });
      expect(run.readBacks).toEqual([]);
      expect(run.records[1]).toMatchObject({
        final: true,
        creditedTo: null,
        decidedBy: "nobody",
        notCredited: [NOTES, MEMORY].toSorted(),
      });
    },
  );

  it(
    "credits nobody while a hand-over is pending, or when the home's record names another executor",
    { timeout: 30_000 },
    async () => {
      const pending = await migrateAcrossTheTurn({
        maria: false,
        homes: () => ({
          settled: { userId: "user-fixture", sessionId: null, workspaceId: "workspace-1" },
          pending: {
            userId: MARIA,
            sessionId: null,
            workspaceId: "workspace-2",
            epoch: 9,
            n: null,
          },
        }),
      });
      expect(pending.readBacks).toEqual([]);
      expect(pending.records[1]).toMatchObject({ creditedTo: null, decidedBy: "nobody" });
      const elsewhere = await migrateAcrossTheTurn({
        maria: false,
        homes: () => ({
          settled: { userId: "user-fixture", sessionId: null, workspaceId: "an-older-executor" },
          pending: null,
        }),
      });
      expect(elsewhere.readBacks).toEqual([]);
      expect(elsewhere.records[1]).toMatchObject({ creditedTo: null, decidedBy: "nobody" });
    },
  );

  it(
    "credits the person a settled record names for the executor that wrote the capture",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({
        maria: true,
        homes: () => ({
          settled: { userId: "user-fixture", sessionId: null, workspaceId: "workspace-1" },
          pending: null,
        }),
      });
      expect(run.records[1]).toMatchObject({
        creditedTo: "user-fixture",
        decidedBy: "home-record",
      });
      expect(run.readBacks.map((input) => input.userId)).toEqual(["user-fixture", "user-fixture"]);
    },
  );

  it(
    "credits nobody by the only-person rule where sessions deleted before the owner record cannot be known",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: false, complete: false });
      expect(run.readBacks).toEqual([]);
      expect(run.records[1]).toMatchObject({ creditedTo: null, decidedBy: "nobody" });
    },
  );

  it(
    "credits the only member of an organization that never had a second one, on a worktree older than the owner record (owner decision 2026-10-08)",
    { timeout: 30_000 },
    async () => {
      const run = await migrateAcrossTheTurn({ maria: false, complete: false, mariaMember: false });
      expect(run.records[1]).toMatchObject({
        creditedTo: "user-fixture",
        decidedBy: "only-person",
      });
    },
  );

  it(
    "runs off the launch path: a person launch never waits for the migration it starts",
    { timeout: 30_000 },
    async () => {
      const release = Effect.runSync(Deferred.make<void>());
      let entered = false;
      let finished = false;
      let launched = false;
      const memory = makeMemoryCaptureStore();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "fresh",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(session.id, ["claude"]);
            launched = true;
            // The launch ran per person and returned; the migration it started is still waiting.
            yield* until(() => entered, "the migration's start");
            expect(finished).toBe(false);
            yield* Deferred.succeed(release, undefined);
            yield* until(() => finished, "the migration's end");
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            { flush: headFlush(memory), exec: answerLayout(LAYOUT_READY) },
          ),
          harnessLayout: {
            flag: "person",
            platform: personPlatform([], { person: true }),
            wrapRepo: (inner) => ({
              ...inner,
              preReleaseMigrationOf: (worktreeId) =>
                Effect.sync(() => {
                  entered = true;
                }).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(inner.preReleaseMigrationOf(worktreeId)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      finished = true;
                    }),
                  ),
                ),
            }),
          },
        },
      );
      expect(launched).toBe(true);
    },
  );
});

/** A session's observed agents (`agent-external` rows). */
const externalRowsOf = (world: World, sessionId: SessionId) =>
  [...world.processes.values()].filter(
    (process) => process.kind === "agent-external" && process.sessionId === sessionId,
  );

describe("agents run by hand are observed in the head capture (docs/adr/0016)", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const personLayers = (
    created: Array<CreateOptions>,
    memory: MemoryCaptureStore,
    state?: HarnessLayoutsMemoryState,
  ) => ({
    captured: memory,
    prepareWorld: (world: World) => world.members.set(MARIA, "member"),
    sealantLayer: sealantLaunchLayer(
      created,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      { flush: headFlush(memory), exec: answerLayout(LAYOUT_READY) },
    ),
    harnessLayout: {
      flag: "person" as const,
      platform: personPlatform([], { person: true }),
      ...(state === undefined ? {} : { state }),
    },
  });

  /** A person executor with one workbench session of `user-fixture`'s, a shell holding it. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const workbenchIn = (
    world: World,
    tmp: string,
    created: Array<CreateOptions>,
    memory: MemoryCaptureStore,
  ) =>
    Effect.gen(function* () {
      const project = yield* setup(tmp, world);
      const engine = yield* SessionEngine;
      const session = yield* engine.provision({
        projectId: project.id,
        harness: "claude",
        label: null,
        name: "workbench",
        ownerUserId: "user-fixture",
        base: null,
      });
      yield* engine.launch(session.id, ["bash"]);
      const request = created[0];
      if (request === undefined) return yield* Effect.die("the launch made no executor");
      const executorRoot = path.join(tmp, "person-executor");
      const home = configuredHarnessHomePath(request, executorRoot);
      const ship = shipCapturedHarnessHome(
        tmp,
        memory,
        session.worktreeId,
        memory.leases.get(session.worktreeId)?.epoch ?? 0,
        request,
        executorRoot,
      );
      return { engine, session, home, ship };
    });

  it(
    "an observed agent in a shared conversation's session is harvested from its own saved directory, not the shared conversation",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const state = makeHarnessLayoutsMemoryState();
      const byHand = crypto.randomUUID();
      const shared = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, home, ship } = yield* workbenchIn(world, tmp, created, memory);
            // Shared control moved the session's conversation into `C`: its engine conversation,
            // with other people's turns, is there and newer than anything else.
            state.sharedConversations.set(session.id, {
              owner: "user-fixture",
              movedAt: new Date(),
            });
            const handTranscript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${byHand}.jsonl`;
            writeUnder(home, handTranscript, claudeLine(byHand, "by hand"));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id).map((row) => row.providerSessionId)).toEqual([
              byHand,
            ]);

            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, handTranscript), past, past);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/conversations/${session.id}/${PROJECT_DIR}/${shared}.jsonl`,
              claudeLine(shared, "the shared conversation"),
            );
            yield* ship;
            yield* engine.observeExternalAgents();
            const [row] = externalRowsOf(world, session.id);
            expect(row?.exitedAt).not.toBeNull();
            // The harvest recorded her own conversation, never the shared one.
            expect(row?.providerSessionId).toBe(byHand);
            expect(world.sessions.get(session.id)?.providerSessionId).toBe(byHand);
          }),
        personLayers(created, memory, state),
      );
    },
  );

  it(
    "a head that cannot be read keeps an observed agent as it is, and the next readable head ends it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, home, ship } = yield* workbenchIn(world, tmp, created, memory);
            const transcript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${id}.jsonl`;
            writeUnder(home, transcript, claudeLine(id, "by hand"));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id).map((row) => row.exitedAt)).toEqual([null]);

            // The writes went quiet, but the head that says so cannot be read this pass.
            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, transcript), past, past);
            const unreadable = yield* ship;
            const manifest = path.join(tmp, "blobs", unreadable.key);
            const bytes = fs.readFileSync(manifest);
            fs.rmSync(manifest);
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id).map((row) => row.exitedAt)).toEqual([null]);

            fs.writeFileSync(manifest, bytes);
            yield* engine.observeExternalAgents();
            const rows = externalRowsOf(world, session.id);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.exitedAt).not.toBeNull();
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a fresh write from before the session began is history; one within the clock skew of its start is not",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const before = crypto.randomUUID();
      const atStart = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const { engine, session, home, ship } = yield* workbenchIn(world, tmp, created, memory);
            const began = session.createdAt.getTime();
            // A minute before the session: fresh, and still not this session's.
            const claude = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${before}.jsonl`;
            writeUnder(home, claude, claudeLine(before, "another session's"));
            fs.utimesSync(
              path.join(home, claude),
              new Date(began - 60_000),
              new Date(began - 60_000),
            );
            // A second before it, within the skew between the executor's clock and Mend's.
            const codex = `${peopleDir("user-fixture")}/.codex/sessions/2026/10/11/rollout-2026-10-11T10-00-00-${atStart}.jsonl`;
            writeUnder(home, codex, "{}\n");
            fs.utimesSync(path.join(home, codex), new Date(began - 1_000), new Date(began - 1_000));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(
              externalRowsOf(world, session.id).map((row) => [row.harness, row.providerSessionId]),
            ).toEqual([["codex", atStart]]);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a claude a person runs by hand writes into their saved directory and is observed as theirs",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      const old = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "workbench",
              ownerUserId: "user-fixture",
              base: null,
            });
            // The open workbench: a shell holds the workspace; no engine agent runs.
            yield* engine.launch(session.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            const epoch = memory.leases.get(session.worktreeId)?.epoch ?? 0;
            // A conversation of hers from before this session, in the same saved directory: history,
            // never an agent of this session's.
            const before = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${old}.jsonl`;
            writeUnder(home, before, claudeLine(old, "an earlier session"));
            const earlier = new Date(session.createdAt.getTime() - 60 * 60_000);
            fs.utimesSync(path.join(home, before), earlier, earlier);
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id)).toHaveLength(0);

            // Her `claude` in the terminal writes through her home's link into her saved directory.
            const transcript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${id}.jsonl`;
            writeUnder(home, transcript, claudeLine(id, "by hand"));
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            const observed = externalRowsOf(world, session.id);
            expect(observed).toHaveLength(1);
            expect(observed[0]?.harness).toBe("claude");
            expect(observed[0]?.providerSessionId).toBe(id);
            expect(observed[0]?.runsAs).toBe("user-fixture");
            expect(observed[0]?.exitedAt).toBeNull();
            expect(world.sessions.get(session.id)?.status).toBe("running");

            // A second pass over the same head observes nothing new.
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id)).toHaveLength(1);

            // The writes go quiet: the next capture carries the old mtime, and the end is recorded.
            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, transcript), past, past);
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, session.id)[0]?.exitedAt).not.toBeNull();
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "two people's agents in one executor are each observed in their own session, never the other's",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const alice = crypto.randomUUID();
      const maria = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const holder = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "shared",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(holder.id, ["bash"]);
            const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: MARIA,
            });
            yield* engine.launch(joined.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${alice}.jsonl`,
              claudeLine(alice, "alice by hand"),
            );
            writeUnder(
              home,
              `${peopleDir(MARIA)}/${PROJECT_DIR}/${maria}.jsonl`,
              claudeLine(maria, "maria by hand"),
            );
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              holder.worktreeId,
              memory.leases.get(holder.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();

            const alices = externalRowsOf(world, holder.id);
            expect(alices.map((row) => [row.providerSessionId, row.runsAs])).toEqual([
              [alice, "user-fixture"],
            ]);
            const marias = externalRowsOf(world, joined.id);
            expect(marias.map((row) => [row.providerSessionId, row.runsAs])).toEqual([
              [maria, MARIA],
            ]);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a sibling session's engine agent writing into the same saved directory is not read as run by hand",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const agent = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "agent",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(agent.id, ["claude"]);
            const workbench = yield* engine.provisionSessionIn(agent.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(workbench.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            // Mend's own claude writes into her saved directory, which the workbench reads too.
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${id}.jsonl`,
              claudeLine(id, "mend's agent"),
            );
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              agent.worktreeId,
              memory.leases.get(agent.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            expect(
              [...world.processes.values()].filter((row) => row.kind === "agent-external"),
            ).toHaveLength(0);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "an observed agent keeps its own conversation while a sibling's engine agent writes beside it",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const byHand = crypto.randomUUID();
      const mends = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const workbench = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "workbench",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(workbench.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "person-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            const epoch = memory.leases.get(workbench.worktreeId)?.epoch ?? 0;
            const ship = shipCapturedHarnessHome(
              tmp,
              memory,
              workbench.worktreeId,
              epoch,
              request,
              executorRoot,
            );
            const handTranscript = `${peopleDir("user-fixture")}/${PROJECT_DIR}/${byHand}.jsonl`;
            writeUnder(home, handTranscript, claudeLine(byHand, "by hand"));
            yield* ship;
            yield* engine.observeExternalAgents();
            expect(externalRowsOf(world, workbench.id).map((row) => row.providerSessionId)).toEqual(
              [byHand],
            );

            // Then she starts an agent from Mend in a second session of the worktree; it writes
            // into the same saved directory, newer than her own conversation, which goes quiet.
            const agent = yield* engine.provisionSessionIn(workbench.worktreeId, {
              harness: "claude",
              label: null,
              ownerUserId: "user-fixture",
            });
            yield* engine.launch(agent.id, ["claude"]);
            const past = new Date(Date.now() - 10 * 60_000);
            fs.utimesSync(path.join(home, handTranscript), past, past);
            writeUnder(
              home,
              `${peopleDir("user-fixture")}/${PROJECT_DIR}/${mends}.jsonl`,
              claudeLine(mends, "mend's agent"),
            );
            yield* ship;
            yield* engine.observeExternalAgents();
            const rows = externalRowsOf(world, workbench.id);
            expect(rows.map((row) => row.providerSessionId)).toEqual([byHand]);
            expect(rows[0]?.exitedAt).not.toBeNull();
            expect(externalRowsOf(world, agent.id)).toHaveLength(0);
          }),
        personLayers(created, memory),
      );
    },
  );

  it(
    "a shared executor's agent run by hand is observed from the head capture",
    { timeout: 30_000 },
    async () => {
      const created: Array<CreateOptions> = [];
      const memory = makeMemoryCaptureStore();
      const id = crypto.randomUUID();
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "codex",
              label: null,
              name: "workbench",
              ownerUserId: "user-fixture",
              base: null,
            });
            yield* engine.launch(session.id, ["bash"]);
            const request = created[0];
            if (request === undefined) return yield* Effect.die("the launch made no executor");
            const executorRoot = path.join(tmp, "shared-executor");
            const home = configuredHarnessHomePath(request, executorRoot);
            writeUnder(
              home,
              `.codex/sessions/2026/10/11/rollout-2026-10-11T10-00-00-${id}.jsonl`,
              "{}\n",
            );
            yield* shipCapturedHarnessHome(
              tmp,
              memory,
              session.worktreeId,
              memory.leases.get(session.worktreeId)?.epoch ?? 0,
              request,
              executorRoot,
            );
            yield* engine.observeExternalAgents();
            const observed = externalRowsOf(world, session.id);
            expect(observed.map((row) => [row.harness, row.providerSessionId, row.runsAs])).toEqual(
              [["codex", id, null]],
            );
          }),
        {
          captured: memory,
          sealantLayer: sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            { flush: headFlush(memory) },
          ),
        },
      );
    },
  );
});
