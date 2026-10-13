import * as fs from "node:fs";
import * as path from "node:path";

import {
  UserGitAuthorRepo,
  type HarnessLayoutsMemoryState,
  linuxLoginNameOf,
  makeHarnessLayoutsMemoryState,
  piProfileDigest,
} from "@mend/db";
import { SessionId } from "@mend/domain";
import {
  type GitAuthMode,
  Project,
  ResolvedGitAuthor,
  Session,
  PiProfile,
} from "@mend/domain/workbench";
import { LinuxIdentity } from "@mend/domain/workbench";
import type { HarnessLayout } from "@mend/domain/workbench";
import {
  PersonLayoutPlatform,
  type PersonSessionOptions,
  SealantClient,
  SealantPlatformError,
  SealantPrincipal,
} from "@mend/sealant";
import { SessionEngine, WorkspaceGitHooks, WorkspaceGitHooksLive } from "@mend/sessions";
import { AgentBridge, processStatePathOf } from "@mend/store";
import type {
  CreateOptions,
  Workspace,
  WorkspaceCaptureOwnerMap,
  WorkspaceCaptureReplanned,
} from "@sealant/sdk";
import { Duration, Effect, Exit, Fiber, Layer } from "effect";
import { describe, expect } from "vitest";

import { CONTAINER_TOKEN_REFUSED } from "../src/channel-identity.ts";
import {
  REMOTE_SSH_RESET_PENDING_WORDS,
  REMOTE_SSH_ROOT_UNSUPPORTED_WORDS,
  REMOTE_SSH_ROOT_WORDS,
} from "../src/harness-layout-steps.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { it } from "./effect-vitest.ts";
import {
  eventually,
  failureText,
  lifecycleLayer,
  memoryHotPool,
  until,
} from "./engine/capture-fixture.ts";
import {
  isPickupExec,
  now,
  piProfilesLayerOf,
  recordingProtocolHostLayer,
  redeemPickupExec,
  sealantLaunchLayer,
  secretFilesLayerOf,
  servedSocketApis,
  setup,
  type World,
  withEngine,
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
import { recordedBeforeStart } from "./engine/person-layout-fixture.ts";
import { secretForms } from "./pickup-channel.ts";

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
 * stopped and resumed: the launch, join and resume of the exec budget (Performance).
 */
const coldJoinResume = async (options: {
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
}): Promise<Scenario> => {
  const created: Array<CreateOptions> = [];
  const execCalls: Array<ReadonlyArray<string>> = [];
  const opened: Array<PersonSessionOptions> = [];
  const users: Array<string | null> = [];
  const homes: Array<string | undefined> = [];
  const sshUsers: Array<string | undefined> = [];
  const memory = makeMemoryCaptureStore();
  let result: Scenario | null = null;
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
        options.before?.(holder.worktreeId);
        yield* engine.launch(holder.id, ["claude"]);
        const cold = execCalls.length;
        options.onStage?.("cold");
        const joined = yield* engine.provisionSessionIn(holder.worktreeId, {
          harness: "claude",
          label: null,
          ownerUserId: options.joiner,
        });
        yield* engine.launch(joined.id, ["claude"]);
        // The repair runs beside the join, never awaited by it.
        yield* Effect.sleep("50 millis");
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
        // The joiner's logins are released beside the stop, never awaited by it.
        yield* Effect.sleep("50 millis");
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
};

describe("per-person harness homes (docs/adr/0016)", () => {
  // The shared layout's counts (main at 4ccbaa2cd, measured with this same scenario): what the
  // `MEND_HARNESS_LAYOUT=shared` opt-out must keep (Performance, CI guards). Its memory hand-over,
  // withholding and delivery into the one home stay (Delivery 22): a shared home still takes
  // several people.
  const BUDGET = { cold: 13, sameJoin: 4, otherJoin: 3, resume: 13 } as const;
  // The default layout's counts (Delivery 22, measured with this same scenario): a person launch
  // runs none of the shared home's steps, and may not grow back toward them.
  const PERSON_BUDGET = { cold: 6, sameJoin: 3, otherJoin: 4, resume: 6 } as const;
  const LAUNCHER = linuxLoginNameOf("user-fixture");
  const JOINER = linuxLoginNameOf(MARIA);
  const IMAGE = "digest:sha256:img\u0000docker";

  it("the shared opt-out costs what it did: its execs, no home, no user, nothing recorded", async () => {
    const state = makeHarnessLayoutsMemoryState();
    const same = await coldJoinResume({ flag: "shared", joiner: "user-fixture", state });
    const other = await coldJoinResume({ flag: "shared", joiner: MARIA, state });
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
  });

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
            base: null,
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

  it("a person launch names no SSH user where Core does not run SSH sessions as one", async () => {
    // A control plane from before `workspaceSshUser` (sealant#348): its gateway runs every SSH
    // session as root, so the create names nobody, and nothing is set later.
    const calls: Array<string> = [];
    const run = await coldJoinResume({
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
  });

  it("a person launch runs as the launcher's own user, in no more execs than its budget", async () => {
    const state = makeHarnessLayoutsMemoryState();
    const calls: Array<string> = [];
    const run = await coldJoinResume({
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
  });

  it("a join by another person runs as them: at most two more execs, and one repair beside it", async () => {
    const calls: Array<string> = [];
    const same = await coldJoinResume({
      flag: "person",
      joiner: "user-fixture",
      platform: personPlatform(calls, { person: true }),
      exec: answerLayout(LAYOUT_READY),
    });
    const other = await coldJoinResume({
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
  });

  it("Maria's join into Alice's executor runs on Maria's logins alone: one Core call, never Alice's home, released when she stops", async () => {
    const calls: Array<string> = [];
    const marks: Record<string, number> = {};
    const run = await coldJoinResume({
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
    expect(calls.slice(marks["joined"], marks["joinerStopped"])).toEqual([`delete:${mariaHome}`]);
    expect(calls.some((call) => call === `delete:${aliceHome}`)).toBe(false);
    expect(calls.some((call) => call.startsWith(`post:user-fixture`))).toBe(false);
  });

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
            base: null,
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
            base: null,
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
    expect(created.map((options) => options.credentials)).toEqual([
      { claude: true, github: true },
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
              base: null,
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
            base: null,
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
            base: null,
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

  it("with the flag off, the platform's credentials API is never called", async () => {
    const calls: Array<string> = [];
    const state = makeHarnessLayoutsMemoryState();
    for (const joiner of ["user-fixture", MARIA]) {
      await coldJoinResume({
        flag: "shared",
        joiner,
        state,
        platform: personPlatform(calls, { person: true }),
      });
    }
    expect(calls).toEqual([]);
  });

  it("a member with an identity from another worktree and nothing saved here is made at their join", async () => {
    // Maria ran a person launch elsewhere on this instance: identities are instance-wide. This
    // worktree's head holds no people/<maria>, so prepare skips her and says it made only the
    // launcher; her first process here makes her before it starts as her.
    const state = makeHarnessLayoutsMemoryState();
    state.identities.set(MARIA, new LinuxIdentity({ accountId: MARIA, name: JOINER, uid: 40_001 }));
    const run = await coldJoinResume({
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
  });

  it("has no way back: a person worktree launches person with the flag off", async () => {
    const state = recordedBeforeStart(makeHarnessLayoutsMemoryState());
    const run = await coldJoinResume({
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
  });

  /** One cold launch of a new session; its failure, if any, as the error it failed with. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep this scenario helper beside the assertions that use it.
  const launchPersonOnce = async (options: {
    readonly flag: HarnessLayout;
    readonly state: HarnessLayoutsMemoryState;
    readonly platform: Layer.Layer<PersonLayoutPlatform>;
    readonly exec?: (
      argv: ReadonlyArray<string>,
    ) => { exitCode: number; stdout: string; stderr: string } | undefined;
    readonly before?: (worktreeId: string) => void;
    readonly harnessLayout?: HarnessLayout;
    /** Read the session line this long after the launch (what work beside it said). */
    readonly summaryAfter?: Duration.Input;
  }) => {
    let summary: string | null = null;
    const sshUsers: Array<string | undefined> = [];
    const created: Array<CreateOptions> = [];
    const opened: Array<PersonSessionOptions> = [];
    const execCalls: Array<ReadonlyArray<string>> = [];
    const stops: Array<"drain" | "discard"> = [];
    const order: Array<string> = [];
    let failure: string | null = null;
    let worktreeId: string | null = null;
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
            base: null,
            ...(options.harnessLayout === undefined
              ? {}
              : { harnessLayout: options.harnessLayout }),
          });
          worktreeId = session.worktreeId;
          options.before?.(session.worktreeId);
          const launched = yield* engine.launch(session.id, ["claude"]).pipe(Effect.result);
          if (launched._tag === "Failure") failure = launched.failure.message;
          if (options.summaryAfter !== undefined) {
            yield* Effect.sleep(options.summaryAfter);
            summary = world.sessions.get(session.id)?.summary ?? null;
          }
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
  };

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

  it("a launcher whose person Core cannot bind asks for no SSH user: Remote-SSH stays root, and the line says so", async () => {
    const run = await launchPersonOnce({
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
      summaryAfter: "100 millis",
    });
    expect(run.failure).toBeNull();
    // Still a person launch (their logins in their own home), but no `sshAsOwner` on the create.
    expect(run.sshUsers).toEqual([undefined]);
    expect(run.summary).toContain(REMOTE_SSH_ROOT_WORDS);
  });

  it("a person launch on a Sealant that runs no SSH session as a user says Remote-SSH is root (review 3 of mend#641, N4)", async () => {
    const run = await launchPersonOnce({
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
      summaryAfter: "100 millis",
    });
    expect(run.failure).toBeNull();
    expect(run.sshUsers).toEqual([undefined]);
    expect(run.summary).toContain(REMOTE_SSH_ROOT_UNSUPPORTED_WORDS);
  });

  it("a fallback whose SSH reset Core has not taken starts the agent anyway, and says Remote-SSH is down", async () => {
    const calls: Array<string> = [];
    const run = await launchPersonOnce({
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
      summaryAfter: "200 millis",
    });
    expect(run.failure).toBeNull();
    expect(run.order).toContain("open");
    expect(calls).toContain("ssh-user:root");
    expect(run.summary).toContain(REMOTE_SSH_RESET_PENDING_WORDS);
  });

  it("with the flag off, a start interrupted once its operator's person request is written still makes the worktree's next launch person", async () => {
    // The client of the start went away (an HTTP fiber is interrupted on disconnect) after the
    // request was written and before the start went on: the next start joining the worktree by
    // name must see the request, not run as before (review of mend#559, P2-1).
    const state = makeHarnessLayoutsMemoryState();
    const opened: Array<PersonSessionOptions> = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const start = {
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "op",
            ownerUserId: "user-fixture",
            base: null,
          } as const;
          const interrupted = yield* engine
            .provision({ ...start, harnessLayout: "person" })
            .pipe(Effect.forkChild);
          yield* eventually("the operator's request written", Duration.seconds(5), () =>
            [...state.worktrees.values()].some((worktree) => worktree.requested === "person"),
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
          afterRequest: Effect.never,
        },
      },
    );
    expect(
      [...state.launches.values()].map((launch) => `${launch.layout}/${launch.source}`),
    ).toEqual(["person/operator"]);
    expect(opened.some((options) => options.user?.name === linuxLoginNameOf("user-fixture"))).toBe(
      true,
    );
  });

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
            base: null,
          });
          state.worktrees.set(first.worktreeId, { layout: "person", requested: null });
          return yield* engine
            .provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: "pph",
              ownerUserId: "user-fixture",
              base: null,
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
            base: null,
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
            base: null,
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

  it("with the flag off and nothing recorded, a steered turn reads nothing and nothing polls the store", async () => {
    const authors: Array<string | null> = [];
    const submitted: Array<string> = [];
    const sessionReads: Array<string> = [];
    const anyRecordedQueries: Array<string> = [];
    const layoutReads: Array<string> = [];
    const turnReads = await withEngine(
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
          yield* engine.launch(session.id, ["claude"]);
          // The capture reaper's first tick runs as the engine starts: let it.
          yield* Effect.sleep(Duration.millis(50));
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
    );
    expect(authors).toEqual([MARIA, "user-fixture", MARIA]);
    // Three steered turns, another person's among them: each reads the session once, to run as
    // its owner (`owned`), as before mend#551, and no read for the layout on top.
    expect(turnReads).toBe(3);
    // The one query at startup, and none on any reaper tick since.
    expect(anyRecordedQueries).toEqual(["anyRecorded"]);
    // No layout was read: not by the launch, the turns or the access reconciliation.
    expect(layoutReads).toEqual([]);
  });
});

describe("no secret rides an exec's arguments (review of mend#552/#553, P1-1)", () => {
  // Core keeps every exec's argv, in plaintext, for good. A person's secret files and their pi
  // profile (its `mcp.json` holds their MCP servers' keys) reach the executor through a pickup
  // ticket redeemed over the session channel; only the ticket and the paths ride the argv.
  it("a pi launch delivers the owner's secret files and pi profile, and no byte of either reaches the platform's argv", async () => {
    const created: Array<CreateOptions> = [];
    const spawned: ReadonlyArray<string>[] = [];
    const execCalls: ReadonlyArray<string>[] = [];
    const tokenEvents: Array<string> = [];
    const secrets: Record<string, string> = {
      ".aws/credentials":
        "[default]\naws_access_key_id = AKIAEXAMPLE0SECRET01\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
      ".npmrc": "//registry.npmjs.org/:_authToken=npm_0123456789abcdefghijklmnopqrstuvwxyz\n",
    };
    const mcp = JSON.stringify({
      mcpServers: {
        linear: { headers: { Authorization: "Bearer lin_api_0123456789abcdefSECRET" } },
      },
    });
    const profileFiles = [
      { path: "root/mcp.json", encoding: "utf8", contents: mcp },
      {
        path: "extensions/git-info/index.ts",
        encoding: "utf8",
        contents: "export default () => {};\n",
      },
    ] as const;
    const known = [...Object.values(secrets), mcp].map((text) => new TextEncoder().encode(text));
    // What each redemption answered, by purpose of the exec that carried it.
    const picked = new Map<
      string,
      ReadonlyArray<{ readonly path: string; readonly base64: string }>
    >();
    let sessionId: SessionId | null = null;
    const launchOf = () => {
      const issued = tokenEvents.findLast((event) => event.startsWith("issue:"));
      return issued === undefined ? null : issued.slice("issue:".length);
    };
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "pi",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          yield* engine.launch(session.id, ["pi"]);

          // Both deliveries happened, each in one exec, and each redeemed exactly what it carries.
          const secretExecs = execCalls.filter(
            (argv) => argv[3] === "mend-secret-files" && isPickupExec(argv),
          );
          const profileExecs = execCalls.filter(
            (argv) => argv[3] === "mend-write" && isPickupExec(argv),
          );
          expect(secretExecs).toHaveLength(1);
          expect(profileExecs).toHaveLength(1);
          expect(
            (picked.get("mend-secret-files") ?? []).map((file) => [
              file.path,
              Buffer.from(file.base64, "base64").toString("utf8"),
            ]),
          ).toEqual(Object.entries(secrets));
          const profile = new Map(
            (picked.get("mend-write") ?? []).map((file) => [
              file.path,
              Buffer.from(file.base64, "base64").toString("utf8"),
            ]),
          );
          expect(profile.get("/workspace/harness-home/.pi/agent/mend/profile/root/mcp.json")).toBe(
            mcp,
          );

          // Not one form of a secret anywhere the platform keeps: no exec argv, no agent argv,
          // no create request.
          const everything = [
            ...execCalls.map((argv) => argv.join("\u0000")),
            ...spawned.map((argv) => argv.join("\u0000")),
            ...created.map((options) => JSON.stringify(options)),
          ].join("\n");
          for (const bytes of known) {
            for (const form of secretForms(bytes)) expect(everything).not.toContain(form);
          }
          // The tickets that did ride the argv are spent: none redeems again.
          for (const argv of [...secretExecs, ...profileExecs]) {
            const again = yield* redeemPickupExec(argv, session.id, launchOf()).pipe(Effect.flip);
            expect(again.message).toBe(
              "this pickup ticket was already redeemed, perhaps through another channel",
            );
          }
        }),
      {
        captured: makeMemoryCaptureStore(),
        tokenEvents,
        sealantLayer: lifecycleLayer(created, {
          spawned,
          execCalls,
          captureOps: {
            execEffect: (argv) => {
              if (!isPickupExec(argv)) return undefined;
              const purpose = argv[3] ?? "";
              const launch = launchOf();
              // Another executor's launch is refused, and spends nothing it can use: the
              // ticket is taken by the first presentation, so only the right channel asks.
              return redeemPickupExec(argv, sessionId, launch).pipe(
                Effect.map((answer) => {
                  picked.set(purpose, answer.files);
                  return {
                    exitCode: 0,
                    stdout:
                      purpose === "mend-secret-files"
                        ? answer.files.map((file) => `written\t${file.path}\n`).join("")
                        : "",
                    stderr: "",
                  };
                }),
                Effect.orDie,
              );
            },
          },
        }),
        secretFilesLayer: secretFilesLayerOf(() =>
          Effect.succeed(
            Object.entries(secrets).map(([at, text]) => ({
              path: at,
              sealedContents: `sealed:${Buffer.from(text, "utf8").toString("base64")}`,
            })),
          ),
        ),
        piProfilesLayer: piProfilesLayerOf(() =>
          Effect.succeed({
            profile: new PiProfile({
              fileCount: profileFiles.length,
              bytes: profileFiles.reduce((sum, file) => sum + file.contents.length, 0),
              extensions: ["git-info"],
              packages: [],
              digest: piProfileDigest(profileFiles),
              revision: 1,
              updatedAt: new Date(0),
            }),
            files: profileFiles,
          }),
        ),
      },
    );
  });

  it("a ticket redeemed through another executor's launch answers nothing, and is spent", async () => {
    const created: Array<CreateOptions> = [];
    const tokenEvents: Array<string> = [];
    const answers: Array<string> = [];
    const logs: Array<string> = [];
    let sessionId: SessionId | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          sessionId = session.id;
          yield* engine.launch(session.id, ["codex"]);
          expect(answers).toEqual([
            "refused: this pickup ticket is another executor's",
            "refused: this pickup ticket was already redeemed, perhaps through another channel",
          ]);
          // Both refusals read as a possible theft, and neither names the ticket.
          expect(
            logs.filter((line) => line.startsWith("session engine: pickup refused")),
          ).toHaveLength(2);
          // The refusal is logged by path, and no byte of the file is in any line.
          expect(logs).toContain("session engine: secret file · not written");
          expect(logs.join("\n")).not.toContain("npm_secret_value_01");
        }),
      {
        captured: makeMemoryCaptureStore(),
        tokenEvents,
        logs,
        sealantLayer: lifecycleLayer(created, {
          execCalls: [],
          captureOps: {
            execEffect: (argv) => {
              if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
              const issued = tokenEvents.findLast((event) => event.startsWith("issue:"));
              const launch = issued === undefined ? null : issued.slice("issue:".length);
              expect(launch).not.toBeNull();
              const attempt = (as: string | null) =>
                redeemPickupExec(argv, sessionId, as).pipe(
                  Effect.match({
                    onFailure: (error) => answers.push(`refused: ${error.message}`),
                    onSuccess: () => answers.push("answered"),
                  }),
                );
              return attempt("launch-of-another-executor").pipe(
                Effect.andThen(attempt(launch)),
                Effect.as({
                  exitCode: 0,
                  stdout:
                    "refused\t.npmrc\tthe pickup was refused: this pickup ticket is spent, expired or unknown\n",
                  stderr: "",
                }),
              );
            },
          },
        }),
        secretFilesLayer: secretFilesLayerOf(() =>
          Effect.succeed([
            {
              path: ".npmrc",
              sealedContents: `sealed:${Buffer.from("//r/:_authToken=npm_secret_value_01", "utf8").toString("base64")}`,
            },
          ]),
        ),
      },
    );
  });
});

describe("who may redeem a pickup ticket (review of mend#555, P3-10)", () => {
  const npmrc = "//registry.npmjs.org/:_authToken=npm_redeem_rules_0123456789";
  const sealedNpmrc = () =>
    secretFilesLayerOf(() =>
      Effect.succeed([
        {
          path: ".npmrc",
          sealedContents: `sealed:${Buffer.from(npmrc, "utf8").toString("base64")}`,
        },
      ]),
    );

  it("a same-owner sibling's socket redeems; another owner's socket in the same worktree does not, on a retained run", async () => {
    const created: Array<CreateOptions> = [];
    const answers: Array<string> = [];
    // Through which session's socket the next delivery's ticket is presented.
    let via: SessionId | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const first = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            base: null,
          });
          via = first.id;
          yield* engine.launch(first.id, ["codex"]);
          yield* engine.openShell(first.id);
          // The holder's own delivery, through its own socket.
          expect(answers).toEqual(["answered"]);

          // A second session of the same owner joins the executor: its delivery, through the
          // socket the workspace mounts (the first session's), is answered.
          const sibling = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-fixture",
          });
          const converse = (sessionId: SessionId, owner: string) =>
            engine.launchProtocol(sessionId, { mode: "protocol", permissionMode: "bypass" }, owner);
          yield* converse(sibling.id, "user-fixture");
          expect(world.sessions.get(sibling.id)?.sealantWorkspaceId).toBe("workspace-1");
          expect(answers).toEqual(["answered", "answered"]);

          // Maria's session in the same worktree: no delivery of hers there (another person's
          // home), but her socket is served. A retained run of the sibling presents its ticket
          // through her socket: refused, and spent.
          const maria = yield* engine.provisionSessionIn(first.worktreeId, {
            harness: "codex",
            label: null,
            ownerUserId: "user-maria",
          });
          yield* converse(maria.id, "user-maria");
          expect(answers).toHaveLength(2);
          via = maria.id;
          yield* engine.stop(sibling.id);
          yield* converse(sibling.id, "user-fixture");
          expect(created).toHaveLength(1);
          expect(answers).toEqual([
            "answered",
            "answered",
            "refused: this pickup ticket is another session's",
          ]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        sealantLayer: lifecycleLayer(created, {
          execCalls: [],
          captureOps: {
            execEffect: (argv) => {
              if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
              return redeemPickupExec(argv, via).pipe(
                Effect.match({
                  onFailure: (error) => {
                    answers.push(`refused: ${error.message}`);
                    return {
                      exitCode: 0,
                      stdout: `refused\t.npmrc\t${error.message}\n`,
                      stderr: "",
                    };
                  },
                  onSuccess: (answer) => {
                    expect(Buffer.from(answer.files[0]?.base64 ?? "", "base64").toString()).toBe(
                      npmrc,
                    );
                    answers.push("answered");
                    return { exitCode: 0, stdout: "written\t.npmrc\n", stderr: "" };
                  },
                }),
              );
            },
          },
        }),
        secretFilesLayer: sealedNpmrc(),
        protocolHostLayer: recordingProtocolHostLayer([], []),
      },
    );
  });

  it("a launch that claimed a standby redeems through the standby's launch, and through no other", async () => {
    const created: Array<CreateOptions> = [];
    const memory = makeMemoryCaptureStore();
    const pool = memoryHotPool();
    const answers: Array<string> = [];
    let executor: SessionId | null = null;
    const replan = (workspace: Workspace) =>
      Effect.gen(function* () {
        if (executor === null) throw new Error("no executor to replan");
        const api = servedSocketApis.get(executor)?.capture;
        if (api === undefined) throw new Error("the executor serves no capture api");
        const plan = yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(
          Effect.mapError(
            (error) =>
              new SealantPlatformError({
                code: "replan_refused",
                status: error.status,
                message: `${error.reason}: ${error.message}`,
                cause: error,
              }),
          ),
        );
        void workspace;
        return {
          worktreeId: plan.worktree_id,
          epoch: plan.epoch,
          ...(plan.head === null
            ? {}
            : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
          filesWritten: 0,
          bytesWritten: 0,
          filesSkipped: 0,
          bytesSkipped: 0,
          removed: 0,
          unchanged: true,
        } satisfies WorkspaceCaptureReplanned;
      });
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(() => pool.entries.some((entry) => entry.status === "ready"), "a standby");
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          executor = session.id;
          yield* engine.launch(session.id, ["codex"]);
          expect(world.sessions.get(session.id)?.sealantWorkspaceId).toBe("workspace-1");
          expect(answers).toEqual([
            "refused: this pickup ticket is another executor's",
            "refused: this pickup ticket was already redeemed, perhaps through another channel",
          ]);
        }),
      {
        captured: memory,
        hotWorkspacesLayer: pool.layer,
        secretFilesLayer: sealedNpmrc(),
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            replan,
            execEffect: (argv) => {
              if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
              const attempt = (launch: string) =>
                redeemPickupExec(argv, executor, launch).pipe(
                  Effect.match({
                    onFailure: (error) => void answers.push(`refused: ${error.message}`),
                    onSuccess: () => void answers.push("answered"),
                  }),
                );
              // The cold launch key the session would have had, then the standby's own: the
              // first presentation spends the ticket, so this proves the binding refuses a
              // launch that is not the standby's.
              return attempt("not-the-standby-launch").pipe(
                Effect.andThen(attempt(`standby:${executor ?? ""}`)),
                Effect.as({ exitCode: 0, stdout: "refused\t.npmrc\tspent\n", stderr: "" }),
              );
            },
          },
        }),
      },
    );
  });

  it("the standby's own launch is the one a claimed launch's ticket is bound to", async () => {
    const created: Array<CreateOptions> = [];
    const replanned: Array<
      { readonly expectedOwnerMap: WorkspaceCaptureOwnerMap | null } | undefined
    > = [];
    const pool = memoryHotPool();
    const answers: Array<string> = [];
    let executor: SessionId | null = null;
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          world.projects.set(project.id, new Project({ ...project, hotSessions: 1 }));
          const engine = yield* SessionEngine;
          yield* engine.reconcileHotSessions(project.id);
          yield* until(() => pool.entries.some((entry) => entry.status === "ready"), "a standby");
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          executor = session.id;
          yield* engine.launch(session.id, ["codex"]);
          expect(answers).toEqual(["answered"]);
        }),
      {
        captured: makeMemoryCaptureStore(),
        hotWorkspacesLayer: pool.layer,
        secretFilesLayer: sealedNpmrc(),
        sealantLayer: lifecycleLayer(created, {
          captureOps: {
            replan: (workspace, options) =>
              Effect.gen(function* () {
                void workspace;
                replanned.push(options);
                const api = servedSocketApis.get(executor ?? SessionId.make(""))?.capture;
                if (api === undefined) throw new Error("the executor serves no capture api");
                const plan = yield* api.planGet({ worktree_id: null, epoch: 0 }).pipe(Effect.orDie);
                return {
                  worktreeId: plan.worktree_id,
                  epoch: plan.epoch,
                  ...(plan.head === null
                    ? {}
                    : { headN: plan.head.n, headCaptureId: plan.head.capture_id }),
                  filesWritten: 0,
                  bytesWritten: 0,
                  filesSkipped: 0,
                  bytesSkipped: 0,
                  removed: 0,
                  unchanged: true,
                } satisfies WorkspaceCaptureReplanned;
              }),
            execEffect: (argv) => {
              if (argv[3] !== "mend-secret-files" || !isPickupExec(argv)) return undefined;
              return redeemPickupExec(argv, executor, `standby:${executor ?? ""}`).pipe(
                Effect.match({
                  onFailure: (error) => {
                    answers.push(`refused: ${error.message}`);
                    return {
                      exitCode: 0,
                      stdout: `refused\t.npmrc\t${error.message}\n`,
                      stderr: "",
                    };
                  },
                  onSuccess: () => {
                    answers.push("answered");
                    return { exitCode: 0, stdout: "written\t.npmrc\n", stderr: "" };
                  },
                }),
              );
            },
          },
        }),
      },
    );
    // A standby boots with no owner map, and a claim says it expects none (sealant#333), so Core
    // refuses one booted with a map before its daemon is reached.
    expect(replanned).toEqual([{ expectedOwnerMap: null }]);
  });
});

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
const livePersonJoin = async <A>(options: {
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
  /**
   * The stand-in platform has one workspace for every create, so a scenario that launches a second
   * executor cannot keep each workspace its creator's; it runs on one platform user instead. Every
   * other scenario runs where only a workspace's creator reaches it (`workspacesPerOwner`).
   */
  readonly onePlatformUser?: boolean;
  readonly inspect: (
    engine: SessionEngine["Service"],
    join: LiveJoin,
  ) => Effect.Effect<A, unknown, SessionEngine>;
}): Promise<A> => {
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
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
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
          base: null,
        });
        yield* engine.launch(holder.id, ["claude"]);
        const joinedRow = yield* engine.provisionSessionIn(holder.worktreeId, {
          harness: "claude",
          label: null,
          ownerUserId: MARIA,
        });
        const joinExit = yield* engine.launch(joinedRow.id, ["claude"]).pipe(Effect.exit);
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
                exec: answerLayout(LAYOUT_READY),
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

  it("lets a retry that arrives while the first answer is made wait for it: one token, no refusal", async () => {
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
    await livePersonJoin({
      flag: "person",
      gitAuthorLayer: slow,
      presentOverlapping: true,
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
    });
  });

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
            base: null,
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
            MARIA,
          );
          expect(join.opened.at(started)?.user?.name).toBe(JOINER);
          const restarted = join.opened.length;
          yield* engine.restartService(service.service.id);
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
