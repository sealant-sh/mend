import * as fs from "node:fs";
import * as path from "node:path";

import {
  type HarnessLayoutsMemoryState,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
} from "@mend/db";
import { LinuxIdentity } from "@mend/domain/workbench";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  PersonLayoutPlatform,
  type PersonSessionOptions,
  SealantClient,
  SealantPlatformError,
  SealantPrincipal,
} from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { processStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions, Workspace } from "@sealant/sdk";
import { Clock, Duration, Effect, Fiber, Layer, Queue } from "effect";
import { describe, expect } from "vitest";

import { LEASE_REAPER_INTERVAL_SECONDS } from "../src/capture-runtime.ts";
import {
  REMOTE_SSH_RESET_PENDING_WORDS,
  REMOTE_SSH_ROOT_UNSUPPORTED_WORDS,
  REMOTE_SSH_ROOT_WORDS,
} from "../src/harness-layout-steps.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { signal, signalWrites, signalled, watched, parkingClock } from "./engine/clock-fixture.ts";
import {
  now,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";
import {
  LAYOUT_READY,
  MARIA,
  answerLayout,
  isPrepare,
  personPlatform,
} from "./engine/person-fixture.ts";
import { recordedBeforeStart } from "./engine/person-layout-fixture.ts";

/**
 * The platform as the dispatching client serves it on an install (`SealantClients.forPrincipal`):
 * a workspace lookup made with no principal fails `NO_PRINCIPAL`, as every call does. The launch
 * fake beneath answers the rest. A boot fiber that forgot to run as the session's owner reads the
 * workspace `unknown` here, as it does on the box. Every lookup's principal lands in `seen`
 * (`none`, or the user id), so a test can say whose the calls were.
 */
/** Records whose principal each create is made under (`none`, or the user id). */
const createPrincipals = (
  inner: Layer.Layer<SealantClient>,
  seen: Array<string>,
): Layer.Layer<SealantClient> =>
  Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => ({
      ...client,
      createWorkspace: (options, launch, watch) =>
        Effect.flatMap(SealantPrincipal, (principal) => {
          seen.push(principal.kind === "none" ? "none" : principal.userId);
          return client.createWorkspace(options, launch, watch);
        }),
    })),
  ).pipe(Layer.provide(inner));

const isRepair = (argv: ReadonlyArray<string>) => (argv[2] ?? "").includes("mend-repair");

const isPersonHome = (argv: ReadonlyArray<string>) =>
  (argv[2] ?? "").includes("useradd") && !isPrepare(argv);

interface Scenario {
  readonly cold: number;
  readonly join: number;
  readonly joinRepairs: number;
  readonly joinPersonHomes: number;
  readonly resume: number;
  readonly created: number;
  readonly homes: ReadonlyArray<string | undefined>;
  readonly sshUsers: ReadonlyArray<string | undefined>;
  readonly opened: ReadonlyArray<PersonSessionOptions>;
  readonly users: ReadonlyArray<string | null>;
  readonly execs: ReadonlyArray<ReadonlyArray<string>>;
  readonly worktreeId: string;
}

/**
 * A holder's cold launch, a second session in its executor (owned by `joiner`), then the holder
 * stopped and resumed: the launch, join and resume of the exec budget (Performance). What runs
 * beside the join and beside the joiner's stop (the worktree repair, the joiner's logins
 * released) is waited for through the engine's own log lines, never a clock.
 */
const coldJoinResume = (options: {
  readonly flag: HarnessLayout;
  readonly joiner: string;
  readonly state?: HarnessLayoutsMemoryState;
  readonly platform?: Layer.Layer<PersonLayoutPlatform>;
  readonly exec?: (
    argv: ReadonlyArray<string>,
  ) => { exitCode: number; stdout: string; stderr: string } | undefined;
  readonly before?: (worktreeId: string) => void;
  /** Called as the scenario passes each point: after the cold launch, the join, the joiner's stop. */
  readonly onStage?: (stage: "cold" | "joined" | "joinerStopped") => void;
}): Effect.Effect<Scenario> =>
  Effect.gen(function* () {
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const opened: Array<PersonSessionOptions> = [];
    const users: Array<string | null> = [];
    const homes: Array<string | undefined> = [];
    const sshUsers: Array<string | undefined> = [];
    const memory = makeMemoryCaptureStore();
    /** The engine wrote a log line. */
    const logged = yield* Queue.make<void>();
    const logs = watched<string>(logged);
    /** The engine said one of these (what the work beside a step reports, ran or not). */
    const said =
      (...outcomes: ReadonlyArray<string>) =>
      () =>
        logs.some((line) => outcomes.some((words) => line.includes(words)));
    // A fresh executor warms the harness in a background exec. Wait for that exec's own
    // completion log so it belongs to its launch, never to the next stage's exec budget.
    const warmupsFinished = (count: number) =>
      signalled(logged)(
        () =>
          logs.filter((line) => line.includes("session engine: harness warm-up ·")).length ===
          count,
        "the fresh executor's harness warm-up",
      );
    let result: Scenario | null = null;
    yield* withPreparedEngineEffect(
      (world, tmp) => setup(tmp, world),
      (world, _tmp, project) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          options.before?.(holder.worktreeId);
          yield* engine.launch(holder.id, ["claude"]);
          yield* warmupsFinished(1);
          const cold = execCalls.length;
          options.onStage?.("cold");
          const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: options.joiner,
          });
          yield* engine.launch(joined.id, ["claude"]);
          // Another person's process in a person executor: the worktree repair runs beside the
          // join, never awaited by it, and their logins are released beside their stop, never
          // awaited by it. The engine says when each ran. A same-person join starts neither.
          const another =
            options.joiner !== "user-fixture" &&
            opened.some((process) => process.user?.name === linuxLoginNameOf(options.joiner));
          if (another) {
            yield* signalled(logged)(
              said("worktree repair · observed", "worktree repair did not run"),
              "the join's worktree repair",
            );
          }
          options.onStage?.("joined");
          const joinExecs = execCalls.slice(cold);
          const joinRepairs = joinExecs.filter(isRepair).length;
          const joinPersonHomes = joinExecs.filter(isPersonHome).length;
          const afterJoin = execCalls.length;
          // A resume after a Stop: the holder's executor ends and a new one starts.
          const agent = [...world.processes.values()].findLast(
            (process) => process.sessionId === holder.id && process.kind === "agent-pty",
          );
          yield* engine.stop(joined.id);
          if (another) {
            yield* signalled(logged)(
              said("a person's logins released", "a person's logins were not released"),
              "the joiner's logins released",
            );
          }
          options.onStage?.("joinerStopped");
          yield* engine.stop(holder.id);
          if (agent !== undefined) {
            const stateDir = processStatePathOf(project.storePath, holder.id, agent.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness: "claude",
                providerSessionId: "11111111-2222-3333-4444-555555555555",
                capturedAt: now().toISOString(),
              }),
            );
          }
          const beforeResume = execCalls.length;
          yield* engine.resumeSession(holder.id, null);
          yield* warmupsFinished(2);
          result = {
            cold,
            join: afterJoin - cold - joinRepairs,
            joinRepairs,
            joinPersonHomes,
            resume: execCalls.length - beforeResume,
            created: created.length,
            homes,
            sshUsers,
            opened,
            users,
            execs: execCalls,
            worktreeId: holder.worktreeId,
          };
        }),
      {
        captured: memory,
        logs,
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: sealantLaunchLayer(
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
          {
            execUsers: users,
            createHomes: homes,
            createSshUsers: sshUsers,
            ...(options.exec === undefined ? {} : { exec: options.exec }),
          },
        ),
        harnessLayout: {
          flag: options.flag,
          ...(options.state === undefined ? {} : { state: options.state }),
          ...(options.platform === undefined ? {} : { platform: options.platform }),
        },
      },
    );
    if (result === null) throw new Error("the scenario did not run");
    return result;
  });

describe("per-person harness homes (docs/adr/0016)", () => {
  // Retained launches now read mend.toml and refresh the root note, two execs. Cold launches
  // already did both. Shared layouts still perform no personal-home work.
  // Count the fresh executor's one background harness warm-up in cold/resume, rather than
  // whichever stage happens to run when it reaches the fake. Retained joins do not warm up.
  const BUDGET = { cold: 14, sameJoin: 5, otherJoin: 4, resume: 14 } as const;
  // The default layout's counts (Delivery 22, measured with this same scenario): a person launch
  // runs none of the shared home's steps, and may not grow back toward them.
  // Each person launch also writes the note as its own user, after home selection.
  const PERSON_BUDGET = { cold: 8, sameJoin: 5, otherJoin: 6, resume: 8 } as const;
  const LAUNCHER = linuxLoginNameOf("user-fixture");
  const JOINER = linuxLoginNameOf(MARIA);
  const IMAGE = "digest:sha256:img\u0000docker";

  it.effect(
    "the shared opt-out refreshes the retained note within its budget, with no personal home or user",
    () =>
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const same = yield* coldJoinResume({ flag: "shared", joiner: "user-fixture", state });
        const other = yield* coldJoinResume({ flag: "shared", joiner: MARIA, state });
        expect([same.cold, same.join, same.resume]).toEqual([
          BUDGET.cold,
          BUDGET.sameJoin,
          BUDGET.resume,
        ]);
        expect([other.cold, other.join]).toEqual([BUDGET.cold, BUDGET.otherJoin]);
        for (const run of [same, other]) {
          expect(run.homes.every((home) => home === undefined)).toBe(true);
          // A shared executor's SSH sessions run as root, as before: no user is named.
          expect(run.sshUsers.every((user) => user === undefined)).toBe(true);
          expect(run.users.every((user) => user === null)).toBe(true);
          expect(run.opened.some((options) => options.user !== undefined)).toBe(false);
          expect(run.joinRepairs + run.joinPersonHomes).toBe(0);
          expect(run.execs.some((argv) => (argv[2] ?? "").includes("mend-layout"))).toBe(false);
        }
        expect(state.launches.size).toBe(0);
        expect(state.identities.size).toBe(0);
      }),
  );

  it("Remote-SSH is the launcher's: whoever launches the executor, and after it stops, whoever launches the next one", async () => {
    // Alice launches and stops; Maria, a member, then launches the worktree's next executor. Its
    // create names Maria's user and is made as Maria's Sealant user, so Core's gateway, which
    // admits only the workspace's owner, admits Maria and refuses Alice (docs/adr/0016, decision
    // 10: the launcher of the workspace, not the worktree's first-session owner).
    const sshUsers: Array<string | undefined> = [];
    const principals: Array<string> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const first = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "remote-ssh-launcher",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(first.id, ["claude"]);
          yield* engine.stop(first.id);
          const next = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          yield* engine.launch(next.id, ["claude"]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        sealantLayer: createPrincipals(
          sealantLaunchLayer(
            [],
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            {
              createSshUsers: sshUsers,
              exec: answerLayout(
                `mend-layout probed\nmend-layout made ${LAUNCHER}\nmend-layout made ${JOINER}\nmend-layout ready\n`,
              ),
            },
          ),
          principals,
        ),
        harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
      },
    );
    expect(sshUsers).toEqual([`/home/${LAUNCHER}`, `/home/${JOINER}`]);
    expect(principals).toEqual(["user-fixture", MARIA]);
  });

  it.effect("a person launch names no SSH user where Core does not run SSH sessions as one", () =>
    Effect.gen(function* () {
      // A control plane from before `workspaceSshUser` (sealant#348): its gateway runs every SSH
      // session as root, so the create names nobody, and nothing is set later.
      const calls: Array<string> = [];
      const run = yield* coldJoinResume({
        flag: "person",
        joiner: "user-fixture",
        platform: personPlatform(
          calls,
          { person: true },
          undefined,
          undefined,
          undefined,
          undefined,
          false,
        ),
        exec: answerLayout(LAYOUT_READY),
      });
      expect(run.homes[0]).toBe(`/home/${LAUNCHER} 40001:40000`);
      expect(run.sshUsers.every((user) => user === undefined)).toBe(true);
      expect(calls.some((call) => call.startsWith("ssh-user:"))).toBe(false);
    }),
  );

  it.effect(
    "a person launch runs as the launcher's own user, in no more execs than its budget",
    () =>
      Effect.gen(function* () {
        const state = makeHarnessLayoutsMemoryState();
        const calls: Array<string> = [];
        const run = yield* coldJoinResume({
          flag: "person",
          joiner: "user-fixture",
          state,
          platform: personPlatform(calls, { person: true }),
          exec: answerLayout(LAYOUT_READY),
        });
        expect(run.cold).toBeLessThanOrEqual(PERSON_BUDGET.cold);
        expect(run.join).toBeLessThanOrEqual(PERSON_BUDGET.sameJoin);
        expect(run.resume).toBeLessThanOrEqual(PERSON_BUDGET.resume);
        // The create commits to the layout: the launcher's logins into their own home.
        expect(run.homes[0]).toBe(`/home/${LAUNCHER} 40001:40000`);
        // And their Remote-SSH: Core's gateway runs the owner's SSH sessions as their user.
        expect(run.sshUsers[0]).toBe(`/home/${LAUNCHER}`);
        // Users and homes are made in the executor's first exec, beside the helper install.
        const first = run.execs.find((argv) => (argv[2] ?? "").includes("mend-layout"));
        expect(first?.[2]).toContain(`useradd -u "$p_u" -g mend`);
        // One word per person in one list, never a copy of the script (review of mend#582).
        expect(first?.[2]).toContain(`mend_people='${LAUNCHER}:40001:`);
        expect(first?.[2]).toContain("ln -sf /run/mend/bin/mend /usr/local/bin/mend");
        // Every agent of the launcher runs as them; a same-person join makes nobody and repairs nothing.
        const users = run.opened.map((options) => options.user?.name ?? null);
        expect(users.length).toBeGreaterThan(0);
        expect(users.every((user) => user === LAUNCHER)).toBe(true);
        expect(run.joinPersonHomes + run.joinRepairs).toBe(0);
        expect(state.worktrees.get(run.worktreeId)?.layout).toBe("person");
        expect([...state.launches.values()].every((launch) => launch.confirmed)).toBe(true);
        expect(calls).toEqual([]);
      }),
  );

  it.effect(
    "a join by another person runs as them: at most two more execs, and one repair beside it",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const same = yield* coldJoinResume({
          flag: "person",
          joiner: "user-fixture",
          platform: personPlatform(calls, { person: true }),
          exec: answerLayout(LAYOUT_READY),
        });
        const other = yield* coldJoinResume({
          flag: "person",
          joiner: MARIA,
          platform: personPlatform(calls, { person: true }),
          exec: answerLayout(LAYOUT_READY),
        });
        expect(other.join - same.join).toBeLessThanOrEqual(2);
        expect(other.join).toBeLessThanOrEqual(PERSON_BUDGET.otherJoin);
        expect(other.joinPersonHomes).toBe(1);
        expect(other.joinRepairs).toBe(1);
        // Maria's agent runs as Maria; the launcher's as the launcher.
        expect(other.opened.map((options) => options.user?.name)).toEqual(
          expect.arrayContaining([LAUNCHER, JOINER]),
        );
        const home = other.execs.find(isPersonHome);
        expect(home?.[2]).toContain(`useradd -u "$p_u" -g mend`);
        expect(home?.[2]).toContain(`mend_person ${JOINER} 40002 `);
      }),
  );

  it.effect(
    "Maria's join into Alice's executor runs on Maria's logins alone: one Core call, never Alice's home, released when she stops",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const marks: Record<string, number> = {};
        const run = yield* coldJoinResume({
          flag: "person",
          joiner: MARIA,
          platform: personPlatform(calls, { person: true }),
          exec: answerLayout(LAYOUT_READY),
          onStage: (stage) => {
            marks[stage] = calls.length;
          },
        });
        const aliceHome = `/home/${LAUNCHER}`;
        const mariaHome = `/home/${JOINER}`;
        // The cold launch wrote Alice's logins at create (`credentialsHome`): no Core call of its own.
        expect(calls.slice(0, marks["cold"])).toEqual([]);
        expect(run.homes[0]).toBe(`${aliceHome} 40001:40000`);
        // The join adds exactly one Core call: Maria's own logins, into Maria's own home.
        expect(calls.slice(marks["cold"], marks["joined"])).toEqual([`post:${MARIA}:${mariaHome}`]);
        // Maria's agent runs as Maria, and nothing it is given names Alice's home or her login.
        const marias = run.opened.filter((options) => options.user?.name === JOINER);
        expect(marias.length).toBeGreaterThan(0);
        for (const options of marias) {
          expect(options.user?.home).toBe(mariaHome);
          expect(JSON.stringify(options)).not.toContain(aliceHome);
          expect(options.env?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("");
          expect(options.env?.["GH_TOKEN"]).toBe("");
          expect(options.env?.["GITHUB_TOKEN"]).toBe("");
        }
        // Nothing run for the join, as anyone, reads Alice's home: her logins are never read on
        // Maria's behalf. Alice's home is hers alone, 0700, made before her first process.
        const joinExecs = run.execs.slice(run.cold, run.cold + run.join + run.joinRepairs);
        expect(joinExecs.length).toBeGreaterThan(0);
        for (const argv of joinExecs) expect(argv.join(" ")).not.toContain(aliceHome);
        const prepare = run.execs.find(isPrepare)?.[2] ?? "";
        // Her home is `/home/<name>` from the people list, uid 40001, made 0700 and hers.
        expect(prepare).toContain(`mend_homes='/home'`);
        expect(prepare).toContain(`'${aliceHome.slice("/home/".length)}:40001:`);
        expect(prepare).toContain('chmod 0700 "$p_h"');
        expect(prepare).toContain('p_o="$2:40000"');
        expect(prepare).toContain('chown -hR "$p_o" "$p_h"');
        // Maria's stop releases her logins; Alice's create-time home stays while her executor lives.
        expect(calls.slice(marks["joined"], marks["joinerStopped"])).toEqual([
          `delete:${mariaHome}`,
        ]);
        expect(calls.some((call) => call === `delete:${aliceHome}`)).toBe(false);
        expect(calls.some((call) => call.startsWith(`post:user-fixture`))).toBe(false);
      }),
  );

  it("refuses Maria's join before her agent starts when she has not connected Claude, and never lends Alice's", async () => {
    const calls: Array<string> = [];
    const tokenEvents: Array<string> = [];
    const opened: Array<PersonSessionOptions> = [];
    const base = personPlatform(calls, { person: true });
    const platform = Layer.effect(
      PersonLayoutPlatform,
      Effect.map(PersonLayoutPlatform, (inner) => ({
        ...inner,
        postCredentials: (
          workspace: Workspace,
          input: Parameters<typeof inner.postCredentials>[1],
        ) =>
          input.onBehalfOf === MARIA
            ? // One partial call: Core writes the rest and leaves Claude out (sealant#337).
              inner.postCredentials(workspace, input).pipe(
                Effect.as({
                  skipped: [
                    {
                      provider: "claude" as const,
                      reason: "connected-account-missing" as const,
                      message: 'No claude connected account matches "default".',
                    },
                  ],
                }),
              )
            : inner.postCredentials(workspace, input),
      })),
    ).pipe(Layer.provide(base));
    const failure = await withEngine(
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
            start: { kind: "base", base: null },
          });
          yield* engine.launch(holder.id, ["claude"]);
          const before = opened.length;
          const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          const refused = yield* engine.launch(joined.id, ["claude"]).pipe(Effect.flip);
          return {
            message: refused.message,
            openedForJoin: opened.length - before,
            summary: world.sessions.get(joined.id)?.summary ?? null,
          };
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
          opened,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        harnessLayout: { flag: "person", platform },
        tokenEvents,
      },
    );
    expect(failure.message).toContain(
      "Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    expect(failure.openedForJoin).toBe(0);
    // The line says the start was refused, not that a resume failed.
    expect(failure.summary).toContain("launch refused · Connect Claude to start a session here.");
    expect(failure.summary).not.toContain("resume failed");
    // The Mend token minted for her beside the refused POST is revoked.
    expect(tokenEvents.filter((event) => event.startsWith("revokePerson:"))).toEqual([
      expect.stringContaining(`:${MARIA}`),
    ]);
    expect(calls).toEqual([`post:${MARIA}:/home/${JOINER}`]);
  });

  it("refuses a fresh worktree's first claude launch the way it refuses a join when the launcher has not connected Claude", async () => {
    const calls: Array<string> = [];
    const created: Array<CreateOptions> = [];
    const opened: Array<PersonSessionOptions> = [];
    const result = await withEngine(
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
            start: { kind: "base", base: null },
          });
          const refused = yield* engine.launch(session.id, ["claude"]).pipe(Effect.flip);
          return {
            message: refused.message,
            summary: world.sessions.get(session.id)?.summary ?? null,
          };
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
          created,
          // Core refuses every create that names Claude: the launcher has none connected.
          (credentials) => credentials?.claude === true,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        harnessLayout: { flag: "person", platform: personPlatform(calls, { person: true }) },
      },
    );
    expect(result.message).toBe(
      "Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    expect(result.summary).toContain(
      "launch refused · Connect Claude to start a session here. Connect it in Settings → Connected accounts, or run mend connect claude.",
    );
    // The ladder never stepped below Claude: no create without it, so no agent started signed out.
    // Her own Codex rode every try that could hold it.
    expect(created.map((options) => options.credentials)).toEqual([
      { claude: true, codex: true, github: true },
      { claude: true, github: true },
      { claude: true, codex: true },
      { claude: true },
    ]);
    expect(opened).toEqual([]);
    // Nobody else's login was asked for on the launcher's behalf.
    expect(calls).toEqual([]);
  });

  it("steps a person launch's create past an optional account Core refuses, missing or needing reconnecting, and stops at the harness's own, as a join does (review of mend#671)", async () => {
    type AccountState = Partial<Record<"claude" | "codex" | "github", "missing" | "invalid">>;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
    const launchWith = (harness: string, state: AccountState) => {
      const asked: Array<CreateOptions["credentials"]> = [];
      const created: Array<CreateOptions> = [];
      // Core's own refusals of a create (connected-account-selection.ts): its code, its
      // provider and its words, the first refused account in the order Core resolves them.
      const core = Layer.effect(
        SealantClient,
        Effect.map(SealantClient, (inner) => ({
          ...inner,
          createWorkspace: (
            options: CreateOptions,
            ...rest: Parameters<typeof inner.createWorkspace> extends [unknown, ...infer R]
              ? R
              : never
          ) => {
            asked.push(options.credentials);
            for (const provider of ["claude", "codex", "github"] as const) {
              if (options.credentials?.[provider] === undefined) continue;
              const standing = state[provider];
              if (standing === "missing") {
                return Effect.fail(
                  new SealantPlatformError({
                    code: "connected-account-missing",
                    status: 404,
                    provider,
                    message: `No ${provider} connected account matches "default".`,
                    cause: null,
                  }),
                );
              }
              if (standing === "invalid") {
                return Effect.fail(
                  new SealantPlatformError({
                    code: "connected-account-invalid",
                    status: 409,
                    provider,
                    message: `Connected ${provider} account "default" is invalid — reconnect it.`,
                    cause: null,
                  }),
                );
              }
            }
            return inner.createWorkspace(options, ...rest);
          },
        })),
      ).pipe(
        Layer.provide(
          sealantLaunchLayer(
            created,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            [],
            undefined,
            [],
            undefined,
            { exec: answerLayout(LAYOUT_READY) },
          ),
        ),
      );
      return withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness,
              label: null,
              name: "fresh",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            const launched = yield* engine
              .launch(session.id, [harness === "shell" ? "bash" : harness])
              .pipe(Effect.result);
            return {
              outcome: launched._tag === "Success" ? "launched" : launched.failure.message,
              asked: asked.length,
              created: created.map((options) => options.credentials),
            };
          }),
        {
          captured: makeMemoryCaptureStore(),
          sealantLayer: core,
          harnessLayout: { flag: "person", platform: personPlatform([], { person: true }) },
        },
      );
    };
    const connectClaude =
      "Connect it in Settings → Connected accounts, or run mend connect claude.";
    // The harness's own login refuses the launch in a join's words, after one create: asking
    // again with the same refused login would only be refused again.
    expect(await launchWith("claude", { claude: "missing" })).toEqual({
      outcome: `Connect Claude to start a session here. ${connectClaude}`,
      asked: 1,
      created: [],
    });
    expect(await launchWith("claude", { claude: "invalid" })).toEqual({
      outcome: `Your Claude login needs reconnecting. Reconnect Claude to start a session here. ${connectClaude}`,
      asked: 1,
      created: [],
    });
    // An account the launch does not need, missing or needing reconnecting, is left out.
    expect(await launchWith("claude", { github: "missing" })).toMatchObject({
      outcome: "launched",
      created: [{ claude: true }],
    });
    expect(await launchWith("claude", { github: "invalid" })).toMatchObject({
      outcome: "launched",
      created: [{ claude: true }],
    });
    expect(await launchWith("codex", { github: "invalid" })).toMatchObject({
      outcome: "launched",
      created: [{ codex: true }],
    });
    // Open workbenches need no login: any refused account is left out, the rest kept.
    expect(await launchWith("shell", { claude: "invalid" })).toMatchObject({
      outcome: "launched",
      created: [{ codex: true, github: true }],
    });
    expect(await launchWith("pi", { claude: "invalid" })).toMatchObject({
      outcome: "launched",
      created: [{ codex: true, github: true }],
    });
    expect(await launchWith("opencode", { codex: "invalid" })).toMatchObject({
      outcome: "launched",
      created: [{ claude: true, github: true }],
    });
    expect(
      await launchWith("pi", { claude: "missing", codex: "missing", github: "missing" }),
    ).toMatchObject({ outcome: "launched", created: [undefined] });
  }, 60_000);

  it("a person launch sends its capture owner map; a shared launch sends none (sealant#333)", async () => {
    const person = await launchPersonOnce({
      flag: "person",
      state: makeHarnessLayoutsMemoryState(),
      platform: personPlatform([], { person: true }),
      exec: answerLayout(LAYOUT_READY),
    });
    expect(person.failure).toBeNull();
    const sent = person.created[0]?.source;
    expect(sent?.kind === "capture" ? sent.ownerMap : undefined).toEqual({
      gid: 40_000,
      worktreeUid: 40_001,
      people: [{ id: "user-fixture", uid: 40_001 }],
    });
    const shared = await launchPersonOnce({
      flag: "shared",
      state: makeHarnessLayoutsMemoryState(),
      platform: personPlatform([], { person: true }),
    });
    expect(shared.failure).toBeNull();
    expect(shared.created[0]?.source).not.toHaveProperty("ownerMap");
  });

  it("the owner map gives the worktree to the change's owner, the owner of its first session", async () => {
    const created: Array<CreateOptions> = [];
    const state = makeHarnessLayoutsMemoryState();
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          // Maria's session made the worktree; Alice's is the first to launch in it.
          const first = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "theirs",
            ownerUserId: MARIA,
            start: { kind: "base", base: null },
          });
          const alices = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: "user-fixture",
          });
          yield* engine.launch(alices.id, ["claude"]);
        }),
      {
        captured: makeMemoryCaptureStore(),
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
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        harnessLayout: { flag: "person", state, platform: personPlatform([], { person: true }) },
      },
    );
    const maria = state.identities.get(MARIA);
    const sent = created[0]?.source;
    const map = sent?.kind === "capture" ? sent.ownerMap : undefined;
    expect(map?.gid).toBe(40_000);
    expect(maria).toBeDefined();
    expect(map?.worktreeUid).toBe(maria?.uid);
    expect(map?.people).toContainEqual({
      id: "user-fixture",
      uid: state.identities.get("user-fixture")?.uid,
    });
  });

  it("a person launch refused for its owner map says so in Mend's words, and the image is known from then on", async () => {
    const state = makeHarnessLayoutsMemoryState();
    let failure: string | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "pph",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          const launched = yield* engine.launch(session.id, ["claude"]).pipe(Effect.result);
          if (launched._tag === "Failure") failure = launched.failure.message;
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          () =>
            Effect.fail(
              new SealantPlatformError({
                code: "owner-map-unsupported",
                status: null,
                message:
                  "The workspace was not launched: its capture source names an owner map, and its image records no probe.",
                cause: null,
              }),
            ),
          [],
        ),
        harnessLayout: { flag: "person", state, platform: personPlatform([], { person: true }) },
      },
    );
    expect(failure).toContain(
      "This workspace cannot run per-person users (its sealantd does not restore files per person), so nothing was started.",
    );
    expect(state.capabilities.get(IMAGE)).toMatchObject({ person: false });
    expect([...state.launches.values()]).toEqual([
      expect.objectContaining({ layout: "shared", source: "fallback" }),
    ]);
  });

  it.effect("with the flag off, the platform's credentials API is never called", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const state = makeHarnessLayoutsMemoryState();
      for (const joiner of ["user-fixture", MARIA]) {
        yield* coldJoinResume({
          flag: "shared",
          joiner,
          state,
          platform: personPlatform(calls, { person: true }),
        });
      }
      expect(calls).toEqual([]);
    }),
  );

  it.effect(
    "a member with an identity from another worktree and nothing saved here is made at their join",
    () =>
      Effect.gen(function* () {
        // Maria ran a person launch elsewhere on this instance: identities are instance-wide. This
        // worktree's head holds no people/<maria>, so prepare skips her and says it made only the
        // launcher; her first process here makes her before it starts as her.
        const state = makeHarnessLayoutsMemoryState();
        state.identities.set(
          MARIA,
          new LinuxIdentity({ accountId: MARIA, name: JOINER, uid: 40_001 }),
        );
        const run = yield* coldJoinResume({
          flag: "person",
          joiner: MARIA,
          state,
          platform: personPlatform([], { person: true }),
          exec: answerLayout(LAYOUT_READY),
        });
        const prepare = run.execs.find((argv) => (argv[2] ?? "").includes("mend-layout"));
        // Prepare names her, made only if her saved directory came back.
        expect(prepare?.[2]).toContain(`:${MARIA}:1:`);
        expect(run.joinPersonHomes).toBe(1);
        const home = run.execs.find(isPersonHome);
        expect(home?.[2]).toContain(`useradd -u "$p_u" -g mend`);
        expect(home?.[2]).toContain(`mend_person ${JOINER} 40001 `);
        // Her agent starts only after that exec: no process is opened as a user nobody made.
        const homeAt = run.execs.indexOf(home ?? []);
        expect(homeAt).toBeGreaterThan(run.cold - 1);
        expect(run.opened.map((options) => options.user?.name)).toContain(JOINER);
      }),
  );

  it.effect("has no way back: a person worktree launches person with the flag off", () =>
    Effect.gen(function* () {
      const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
      const run = yield* coldJoinResume({
        flag: "shared",
        joiner: "user-fixture",
        state,
        platform: personPlatform([], { person: true }),
        exec: answerLayout(LAYOUT_READY),
        before: (worktreeId) =>
          state.worktrees.set(worktreeId, { layout: "person", requested: null }),
      });
      expect(run.homes[0]).toBe(`/home/${LAUNCHER} 40001:40000`);
      expect(run.opened.every((options) => options.user?.name === LAUNCHER)).toBe(true);
      expect([...state.launches.values()].map((launch) => launch.source)).toContain("worktree");
    }),
  );

  interface LaunchPersonOnceOptions {
    readonly flag: HarnessLayout;
    readonly state: HarnessLayoutsMemoryState;
    readonly platform: Layer.Layer<PersonLayoutPlatform>;
    readonly exec?: (
      argv: ReadonlyArray<string>,
    ) => { exitCode: number; stdout: string; stderr: string } | undefined;
    readonly before?: (worktreeId: string) => void;
    readonly harnessLayout?: HarnessLayout;
    /** Read the session line once it says this (what work beside the launch said). */
    readonly summarySaying?: string;
  }

  /** One cold launch of a new session; its failure, if any, as the error it failed with. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const launchPersonOnceEffect = (options: LaunchPersonOnceOptions) =>
    Effect.gen(function* () {
      let summary: string | null = null;
      const sshUsers: Array<string | undefined> = [];
      const created: Array<CreateOptions> = [];
      const opened: Array<PersonSessionOptions> = [];
      const execCalls: Array<ReadonlyArray<string>> = [];
      const stops: Array<"drain" | "discard"> = [];
      const order: Array<string> = [];
      /** A session row was written. */
      const rows = yield* Queue.make<void>();
      let failure: string | null = null;
      let worktreeId: string | null = null;
      yield* withPreparedEngineEffect(
        (world, tmp) => setup(tmp, world),
        (world, _tmp, project) =>
          Effect.gen(function* () {
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "pph",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
              ...(options.harnessLayout === undefined
                ? {}
                : { harnessLayout: options.harnessLayout }),
            });
            worktreeId = session.worktreeId;
            options.before?.(session.worktreeId);
            const launched = yield* engine.launch(session.id, ["claude"]).pipe(Effect.result);
            if (launched._tag === "Failure") failure = launched.failure.message;
            const words = options.summarySaying;
            if (words !== undefined) {
              yield* signalled(rows)(
                () => (world.sessions.get(session.id)?.summary ?? "").includes(words),
                "the session line's words",
              );
              summary = world.sessions.get(session.id)?.summary ?? null;
            }
          }),
        {
          captured: makeMemoryCaptureStore(),
          prepareWorld: (world) => signalWrites(world.sessions, rows),
          sealantLayer: sealantLaunchLayer(
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
            {
              stops,
              beforeOpen: () => order.push("open"),
              createSshUsers: sshUsers,
              ...(options.exec === undefined ? {} : { exec: options.exec }),
            },
          ),
          harnessLayout: { flag: options.flag, state: options.state, platform: options.platform },
        },
      );
      return { created, opened, execCalls, stops, failure, worktreeId, order, summary, sshUsers };
    });

  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const launchPersonOnce = (options: LaunchPersonOnceOptions) =>
    Effect.runPromise(launchPersonOnceEffect(options));

  it("refuses a person worktree before create when its image is known not to run it", async () => {
    const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
    state.capabilities.set(IMAGE, {
      imageKey: "digest:sha256:img",
      runtime: "docker",
      person: false,
      missing: ["no sudo"],
      confirmed: true,
      observedAt: new Date(),
    });
    const run = await launchPersonOnce({
      flag: "shared",
      state,
      platform: personPlatform([], { person: true }),
      before: (worktreeId) =>
        state.worktrees.set(worktreeId, { layout: "person", requested: null }),
    });
    expect(run.failure).toContain(
      "This worktree's sessions are saved per person, and its image cannot run per-person users (no sudo). Pick an image that can, or start a new worktree.",
    );
    // Mend's record of what prepare found wins over Core's yes; nothing was created.
    expect(run.created).toHaveLength(0);
    expect(run.execCalls).toHaveLength(0);
  });

  it("refuses at prepare a person worktree whose image turns out not to run it: nothing starts", async () => {
    const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
    const run = await launchPersonOnce({
      flag: "shared",
      state,
      platform: personPlatform([]),
      exec: answerLayout(
        "mend-layout missing uid 40001 is taken in this image\nmend-layout probed\n",
      ),
      before: (worktreeId) =>
        state.worktrees.set(worktreeId, { layout: "person", requested: null }),
    });
    expect(run.failure).toContain("(uid 40001 is taken in this image)");
    expect(run.created).toHaveLength(1);
    expect(run.opened).toHaveLength(0);
    expect(run.order).toEqual([]);
    // What prepare found is recorded for the next launch, which is refused before create.
    expect(state.capabilities.get(IMAGE)?.person).toBe(false);
    // The worktree stays person: nothing changed but the refusal.
    expect(state.worktrees.get(run.worktreeId ?? "")?.layout).toBe("person");
  });

  it("refuses a person launch whose restore did not apply the owner map, fresh worktree or not: nothing starts", async () => {
    for (const fresh of [true, false]) {
      const state = makeHarnessLayoutsMemoryState();
      const calls: Array<string> = [];
      const run = await launchPersonOnce({
        flag: "person",
        state,
        platform: personPlatform(calls, { person: true }),
        exec: answerLayout(
          "mend-layout probed\nmend-layout unowned the restored worktree's group is 0, not mend (40000)\n",
        ),
        ...(fresh
          ? {}
          : {
              before: (worktreeId: string) =>
                state.worktrees.set(worktreeId, { layout: "person", requested: null }),
            }),
      });
      expect(run.failure).toContain("did not give its files to the people working in it");
      expect(run.failure).toContain("the restored worktree's group is 0, not mend (40000)");
      expect(run.opened).toHaveLength(0);
      expect(run.order).toEqual([]);
      // Never a fallback to shared, and nothing recorded against the image.
      expect(calls).toEqual([]);
      expect(state.capabilities.get(IMAGE)).toBeUndefined();
      expect(state.worktrees.get(run.worktreeId ?? "")?.layout ?? null).toBe(
        fresh ? null : "person",
      );
    }
  });

  it("with the flag on and the image unknown, launches shared, probes, and records what it found", async () => {
    const state = makeHarnessLayoutsMemoryState();
    const run = await launchPersonOnce({
      flag: "person",
      state,
      platform: personPlatform([]),
      exec: answerLayout("mend-layout probed\n"),
    });
    expect(run.failure).toBeNull();
    expect(run.opened.some((options) => options.user !== undefined)).toBe(false);
    const probe = run.execCalls.find((argv) => (argv[2] ?? "").includes("mend-layout"));
    expect(probe?.[2]).toContain("sealantd capabilities --json");
    expect(probe?.[2]).not.toContain("useradd -u");
    // Nothing missing: the next launch on this image can be person.
    expect(state.capabilities.get(IMAGE)?.person).toBe(true);
    expect(state.worktrees.get(run.worktreeId ?? "")?.layout ?? null).toBeNull();
    expect([...state.launches.values()]).toEqual([
      expect.objectContaining({ layout: "shared", source: "capability", confirmed: true }),
    ]);
  });

  it("when Core said yes and prepare says no on a fresh worktree, puts the logins in /root before the agent starts", async () => {
    const state = makeHarnessLayoutsMemoryState();
    const calls: Array<string> = [];
    const run = await launchPersonOnce({
      flag: "person",
      state,
      platform: personPlatform(calls, { person: true }),
      exec: answerLayout("mend-layout missing no setfacl\nmend-layout probed\n"),
    });
    expect(run.failure).toBeNull();
    // The launcher's SSH sessions go back to root with the executor (decision 10), off the
    // launch path: nothing above waited on it.
    expect(calls.filter((call) => !call.startsWith("ssh-user:"))).toEqual([
      `delete:/home/${LAUNCHER}`,
      "post:user-fixture:/root",
    ]);
    // The agent starts as root, after its login is written.
    expect(run.order).toContain("open");
    expect(run.opened.some((options) => options.user !== undefined)).toBe(false);
    expect([...state.launches.values()]).toEqual([
      expect.objectContaining({ layout: "shared", source: "fallback", confirmed: true }),
    ]);
    expect(state.capabilities.get(IMAGE)).toMatchObject({ person: false, missing: ["no setfacl"] });
    expect(state.worktrees.get(run.worktreeId ?? "")?.layout ?? null).toBeNull();
  });

  it.effect(
    "a launcher whose person Core cannot bind asks for no SSH user: Remote-SSH stays root, and the line says so",
    () =>
      Effect.gen(function* () {
        const run = yield* launchPersonOnceEffect({
          flag: "person",
          state: makeHarnessLayoutsMemoryState(),
          platform: personPlatform(
            [],
            { person: true },
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            () => true,
            false,
          ),
          exec: answerLayout(LAYOUT_READY),
          summarySaying: REMOTE_SSH_ROOT_WORDS,
        });
        expect(run.failure).toBeNull();
        // Still a person launch (their logins in their own home), but no `sshAsOwner` on the create.
        expect(run.sshUsers).toEqual([undefined]);
        expect(run.summary).toContain(REMOTE_SSH_ROOT_WORDS);
      }),
  );

  it.effect(
    "a person launch on a Sealant that runs no SSH session as a user says Remote-SSH is root (review 3 of mend#641, N4)",
    () =>
      Effect.gen(function* () {
        const run = yield* launchPersonOnceEffect({
          flag: "person",
          state: makeHarnessLayoutsMemoryState(),
          platform: personPlatform(
            [],
            { person: true },
            undefined,
            undefined,
            undefined,
            undefined,
            false,
          ),
          exec: answerLayout(LAYOUT_READY),
          summarySaying: REMOTE_SSH_ROOT_UNSUPPORTED_WORDS,
        });
        expect(run.failure).toBeNull();
        expect(run.sshUsers).toEqual([undefined]);
        expect(run.summary).toContain(REMOTE_SSH_ROOT_UNSUPPORTED_WORDS);
      }),
  );

  it.effect(
    "a fallback whose SSH reset Core has not taken starts the agent anyway, and says Remote-SSH is down",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const run = yield* launchPersonOnceEffect({
          flag: "person",
          state: makeHarnessLayoutsMemoryState(),
          platform: personPlatform(
            calls,
            { person: true },
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            () => false,
          ),
          exec: answerLayout("mend-layout missing no setfacl\nmend-layout probed\n"),
          summarySaying: REMOTE_SSH_RESET_PENDING_WORDS,
        });
        expect(run.failure).toBeNull();
        expect(run.order).toContain("open");
        expect(calls).toContain("ssh-user:root");
        expect(run.summary).toContain(REMOTE_SSH_RESET_PENDING_WORDS);
      }),
  );

  it.effect(
    "with the flag off, a start interrupted once its operator's person request is written still makes the worktree's next launch person",
    () =>
      Effect.gen(function* () {
        // The client of the start went away (an HTTP fiber is interrupted on disconnect) after the
        // request was written and before the start went on: the next start joining the worktree by
        // name must see the request, not run as before (review of mend#559, P2-1).
        const state = makeHarnessLayoutsMemoryState();
        const opened: Array<PersonSessionOptions> = [];
        /** The operator's layout request is written. */
        const requests = yield* Queue.make<void>();
        yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const start = {
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "op",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              } as const;
              const interrupted = yield* engine
                .provision({ ...start, harnessLayout: "person" })
                .pipe(Effect.forkChild);
              yield* signalled(requests)(
                () =>
                  [...state.worktrees.values()].some((worktree) => worktree.requested === "person"),
                "the operator's request written",
              );
              yield* Fiber.interrupt(interrupted);
              const joined = yield* engine.provision(start);
              yield* engine.launch(joined.id, ["claude"]);
            }),
          {
            captured: makeMemoryCaptureStore(),
            sealantLayer: sealantLaunchLayer(
              [],
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              opened,
              undefined,
              [],
              undefined,
              { exec: answerLayout(LAYOUT_READY) },
            ),
            harnessLayout: {
              flag: "shared",
              state,
              platform: personPlatform([], { person: true }),
              afterRequest: signal(requests)(Effect.void).pipe(Effect.andThen(Effect.never)),
            },
          },
        );
        expect(
          [...state.launches.values()].map((launch) => `${launch.layout}/${launch.source}`),
        ).toEqual(["person/operator"]);
        expect(
          opened.some((options) => options.user?.name === linuxLoginNameOf("user-fixture")),
        ).toBe(true);
      }),
  );

  it("takes the operator's harnessLayout for a worktree it makes, and refuses another on a person worktree", async () => {
    const state = makeHarnessLayoutsMemoryState();
    const run = await launchPersonOnce({
      flag: "person",
      state,
      platform: personPlatform([], { person: true }),
      exec: answerLayout(LAYOUT_READY),
      harnessLayout: "shared",
    });
    expect(run.failure).toBeNull();
    expect(state.worktrees.get(run.worktreeId ?? "")?.requested).toBe("shared");
    expect([...state.launches.values()]).toEqual([
      expect.objectContaining({ layout: "shared", source: "operator" }),
    ]);
    expect(run.opened.some((options) => options.user !== undefined)).toBe(false);

    // The same name again, now that its worktree is person: refused before anything is made.
    const refused = await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const first = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "pph",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          state.worktrees.set(first.worktreeId, { layout: "person", requested: null });
          return yield* engine
            .provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "pph",
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
              harnessLayout: "shared",
            })
            .pipe(Effect.flip);
        }),
      { harnessLayout: { flag: "shared", state } },
    );
    expect(refused._tag).toBe("HarnessLayoutNotAppliedError");
  });

  it("settles a launch whose layout decision throws: failed, its words on the session line, nothing created (box, 0.36.0-next.645)", async () => {
    // The box's 500: the operator's person launch with the flag unset, and the SDK refusing the
    // image question's options by throwing, so the decision died rather than failed.
    const words =
      "workspaces.create requires exactly one of `repository` (a git remote to clone) or `source` (a caller-owned mount).";
    const throwing = Layer.effect(
      PersonLayoutPlatform,
      Effect.map(PersonLayoutPlatform, (inner) => ({
        ...inner,
        imageReport: () => Effect.die(new Error(words)),
      })),
    ).pipe(Layer.provide(personPlatform([], { person: true })));
    const created: Array<CreateOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "pph",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
            harnessLayout: "person",
          });
          const launched = yield* engine.launch(session.id, ["claude"]).pipe(Effect.exit);
          expect(launched._tag).toBe("Failure");
          const row = world.sessions.get(session.id);
          expect(row?.status).toBe("failed");
          expect(row?.summary).toBe(`launch failed: ${words}`);
          expect(created).toHaveLength(0);
          expect(execCalls).toHaveLength(0);
        }),
      {
        captured: makeMemoryCaptureStore(),
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
        ),
        harnessLayout: {
          flag: "shared",
          state: makeHarnessLayoutsMemoryState(),
          platform: throwing,
        },
      },
    );
  });

  it("takes another person's turn onto the conversation in a person executor, on their own login (Delivery 18)", async () => {
    const authors: Array<string | null> = [];
    const submitted: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    const outcome = await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "pph",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(session.id, ["claude"]);
          yield* engine.submitTurn(session.id, "hi", MARIA);
          yield* engine.submitTurn(session.id, "mine", "user-fixture");
          return "taken";
        }),
      {
        captured: makeMemoryCaptureStore(),
        protocolHostLayer: recordingProtocolHostLayer([], submitted, authors),
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
        harnessLayout: { flag: "person", state, platform: personPlatform([], { person: true }) },
      },
    );
    // Both queue on the conversation; dispatch runs Maria's in a process of hers (decision 6).
    expect(outcome).toBe("taken");
    expect(authors).toEqual([MARIA, "user-fixture"]);
    expect(submitted).toEqual(["hi", "mine"]);
  });

  it.effect(
    "with the flag off and nothing recorded, a steered turn reads nothing and nothing polls the store",
    () =>
      Effect.gen(function* () {
        const authors: Array<string | null> = [];
        const submitted: Array<string> = [];
        const sessionReads: Array<string> = [];
        const anyRecordedQueries: Array<string> = [];
        const layoutReads: Array<string> = [];
        const parking = yield* parkingClock;
        const turnReads = yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (_world, _tmp, project) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["claude"]);
              // The capture reaper's first tick runs as the engine starts: it has ended once the
              // reaper parks until its next.
              yield* parking.untilParked(Duration.seconds(LEASE_REAPER_INTERVAL_SECONDS));
              // The access reconciliation of the reaper's minute tick (mend#558), over the live
              // session: it reads sessions and access, never a layout.
              yield* engine.reconcileAccess();
              const before = sessionReads.length;
              for (const author of [MARIA, "user-fixture", MARIA]) {
                yield* engine.submitTurn(session.id, `from ${author}`, author);
              }
              return sessionReads.length - before;
            }),
          {
            captured: makeMemoryCaptureStore(),
            protocolHostLayer: recordingProtocolHostLayer([], submitted, authors),
            sealantLayer: sealantLaunchLayer([]),
            sessionReads,
            harnessLayout: { flag: "shared", anyRecordedQueries, launchLayoutReads: layoutReads },
          },
        ).pipe(Effect.provideService(Clock.Clock, parking.clock));
        expect(authors).toEqual([MARIA, "user-fixture", MARIA]);
        // Three steered turns, another person's among them: each reads the session once, to run as
        // its owner (`owned`), as before mend#551, and no read for the layout on top.
        expect(turnReads).toBe(3);
        // The one query at startup, and none on any reaper tick since.
        expect(anyRecordedQueries).toEqual(["anyRecorded"]);
        // No layout was read: not by the launch, the turns or the access reconciliation.
        expect(layoutReads).toEqual([]);
      }),
  );
});
