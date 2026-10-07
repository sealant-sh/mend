import { it as effectIt } from "@effect/vitest";
import { defaultWorkspaceImage } from "@mend/domain";
import {
  claudeCode,
  type CreateOptions,
  SealantApiError,
  SealantError,
  type Workspace,
  type WorkspaceCredentialsPutOptions,
  type WorkspaceDotfilesApplyOptions,
  type WorkspaceImageInspection,
} from "@sealant/sdk";
import { Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { SealantClients } from "./client.ts";
import { SealantPlatformError } from "./errors.ts";
import {
  CONTROL_PLANE_NO_PROCESS_USER,
  CONTROL_PLANE_UNREADABLE,
  PersonLayoutPlatformLive,
  imageLayoutReportOf,
} from "./person-layout-live.ts";
import {
  PersonLayoutPlatform,
  PersonLayoutPlatformNone,
  type PersonExecOptions,
  UNKNOWN_IMAGE_REPORT,
  withProcessUser,
} from "./person-layout.ts";

const user = {
  name: "m3kq7xj2a",
  uid: 40_012,
  gid: 40_000,
  groups: [40_000],
  home: "/home/m3kq7xj2a",
  umask: 0o002,
};

const unused = () => Effect.die("not in test");

const never = async (): Promise<never> => {
  throw new Error("not in test");
};

/** A workspace whose credentials and dotfiles APIs record what they were asked. */
const workspaceRecording = (
  calls: Array<string>,
  puts: Array<WorkspaceCredentialsPutOptions>,
  applies: Array<WorkspaceDotfilesApplyOptions> = [],
) => {
  const workspace: Workspace = {
    id: "ws-1",
    name: "ws",
    status: never,
    runtimeDeadline: never,
    runtime: never,
    launch: undefined,
    recover: never,
    captureDrain: never,
    ready: never,
    harness: { run: never, start: never, session: never },
    exec: never,
    bind: never,
    capture: { flush: never, status: never, replan: never },
    sessions: { open: never, get: never, list: never },
    events: async function* () {},
    forward: never,
    stop: never,
    restart: never,
    expire: never,
    image: never,
    dotfiles: {
      apply: async (options) => {
        calls.push(`dotfiles:${options.user}:${options.home}`);
        applies.push(options);
        return {
          onBehalfOf: options.onBehalfOf,
          user: options.user,
          home: options.home,
          runId: "run-dotfiles",
          bootstrap: null,
        };
      },
    },
    credentials: {
      put: async (options) => {
        calls.push(`put:${options.home}`);
        puts.push(options);
        // A partial put leaves out a GitHub the person has not connected (sealant#337).
        return {
          home: options.home,
          onBehalfOf: options.onBehalfOf,
          accounts: {},
          skipped:
            options.partial === true && options.github === true
              ? [
                  {
                    provider: "github" as const,
                    reason: "connected-account-missing" as const,
                    message: 'No github connected account matches "default".',
                  },
                ]
              : [],
        };
      },
      release: async (home) => {
        calls.push(`release:${home}`);
        return { released: true };
      },
      list: async () => {
        calls.push("list");
        return [
          {
            home: "/home/m3kq7xj2a",
            onBehalfOf: "su-alice",
            accounts: { claude: { connectedAccountId: "cacc_1", name: "default" } },
          },
          {
            home: "/home/mxyz2345a",
            onBehalfOf: "su-maria",
            accounts: {
              codex: { connectedAccountId: "cacc_2", name: "default" },
              github: { connectedAccountId: "cacc_3", name: "default" },
            },
          },
        ];
      },
    },
  };
  return workspace;
};

const inspection = (
  status: "supported" | "unsupported" | "unknown",
  missing: ReadonlyArray<string> = [],
): WorkspaceImageInspection => ({
  imageKey: "key-1",
  planHash: "plan-1",
  ...(status === "unknown"
    ? {}
    : {
        image: {
          reference: "registry/img:1",
          digestReference: "registry/img@sha256:abc",
          digest: "sha256:abc",
        },
      }),
  personLayout: { status, missing: [...missing], unknown: [], runtime: "docker", acl: "supported" },
});

const clientsLayer = (
  inspections: Array<CreateOptions>,
  answer: WorkspaceImageInspection = inspection("supported"),
  features: () => Effect.Effect<{ readonly processUser: boolean }, SealantPlatformError> = () =>
    Effect.succeed({ processUser: true }),
) =>
  Layer.mock(SealantClients, {
    controlPlaneFeatures: features,
    connectedAccounts: () => ({ list: unused, connect: unused, disconnect: unused }),
    sshKeys: () => ({ ensure: unused, list: unused }),
    sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
    imageKey: (options) => Effect.succeed(`key:${options.os ?? options.baseImage ?? ""}`),
    inspectImage: (_userId, options) =>
      Effect.sync(() => {
        inspections.push(options);
        return answer;
      }),
  });

const platformWith = (layer: Layer.Layer<PersonLayoutPlatform>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* PersonLayoutPlatform;
    }).pipe(Effect.provide(layer)),
  );

describe("a process asked for as a person (docs/adr/0016, decision 1)", () => {
  it("reaches the SDK as that user's passwd name, and nothing else changes", async () => {
    const seen: Array<unknown> = [];
    const run = (options: unknown) => Effect.sync(() => seen.push(options));
    const asUser: PersonExecOptions = { user, cwd: "/workspace/repo" };
    const asRoot: PersonExecOptions = { cwd: "/tmp" };
    await Effect.runPromise(withProcessUser(asUser, run));
    await Effect.runPromise(withProcessUser(undefined, run));
    await Effect.runPromise(withProcessUser(asRoot, run));
    expect(seen).toEqual([{ user: user.name, cwd: "/workspace/repo" }, undefined, { cwd: "/tmp" }]);
  });
});

describe("the live platform (Core 0.39)", () => {
  it("runs processes as a user, and writes, releases and lists a person's logins per home", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
    expect(platform.processUser).toBe(true);
    const calls: Array<string> = [];
    const puts: Array<WorkspaceCredentialsPutOptions> = [];
    const workspace = workspaceRecording(calls, puts);
    const whole = await Effect.runPromise(
      platform.postCredentials(workspace, {
        onBehalfOf: "maria",
        home: "/home/mxyz2345a",
        owner: { uid: 40_002, gid: 40_000 },
        logins: { claude: true, github: null },
      }),
    );
    expect(whole.skipped).toEqual([]);
    // Core is named the person's Sealant user, and the home's numeric owner.
    expect(puts).toEqual([
      {
        home: "/home/mxyz2345a",
        onBehalfOf: "su-maria",
        uid: 40_002,
        gid: 40_000,
        claude: true,
        github: null,
      },
    ]);
    await Effect.runPromise(platform.deleteCredentials(workspace, { home: "/home/mxyz2345a" }));
    const homes = await Effect.runPromise(platform.listCredentials(workspace));
    expect(homes).toEqual([
      { home: "/home/m3kq7xj2a", onBehalfOf: "su-alice", providers: ["claude"] },
      { home: "/home/mxyz2345a", onBehalfOf: "su-maria", providers: ["codex", "github"] },
    ]);
    expect(calls).toEqual(["put:/home/mxyz2345a", "release:/home/mxyz2345a", "list"]);
  });

  it("puts a join's logins in one partial call, pi's and opencode's ChatGPT logins included, and answers what Core left out (sealant#336, #337)", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
    const puts: Array<WorkspaceCredentialsPutOptions> = [];
    const written = await Effect.runPromise(
      platform.postCredentials(workspaceRecording([], puts), {
        onBehalfOf: "maria",
        home: "/home/mxyz2345a",
        owner: { uid: 40_002, gid: 40_000 },
        logins: { codex: true, github: true, pi: true, opencode: true },
        partial: true,
      }),
    );
    expect(puts).toEqual([
      {
        home: "/home/mxyz2345a",
        onBehalfOf: "su-maria",
        uid: 40_002,
        gid: 40_000,
        codex: true,
        github: true,
        pi: true,
        opencode: true,
        partial: true,
      },
    ]);
    expect(written.skipped).toEqual([
      {
        provider: "github",
        reason: "connected-account-missing",
        message: 'No github connected account matches "default".',
      },
    ]);
  });

  it("applies a person's dotfiles as their user into their home, and waits for install.sh once (sealant#334)", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
    expect(platform.dotfilesUser).toBe(true);
    const calls: Array<string> = [];
    const applies: Array<WorkspaceDotfilesApplyOptions> = [];
    const base = workspaceRecording(calls, [], applies);
    let waits = 0;
    const workspace: Workspace = {
      ...base,
      dotfiles: {
        apply: async (options) => {
          const applied = await base.dotfiles.apply(options);
          return {
            ...applied,
            bootstrap: {
              processId: "proc-install",
              wait: async () => {
                waits++;
                return { exitCode: 3, stdout: "", stderr: "boom" };
              },
            },
          };
        },
      },
    };
    const archives = [
      { data: "cmVwbw==", manager: "auto" as const, bootstrap: true },
      { data: "c25hcA==", manager: "copy" as const, bootstrap: false },
    ];
    const applied = await Effect.runPromise(
      platform.applyDotfiles(workspace, {
        onBehalfOf: "user-alice",
        user,
        home: user.home,
        archives,
      }),
    );
    // Named by their Sealant user and their passwd name, never root; the archives as resolved.
    expect(applies).toEqual([
      { onBehalfOf: "su-user-alice", user: user.name, home: user.home, archives },
    ]);
    expect(calls).toEqual([`dotfiles:${user.name}:${user.home}`]);
    const bootstrap = applied.bootstrap;
    expect(bootstrap).not.toBeNull();
    if (bootstrap === null) return;
    // A failing install.sh ends with its exit code, a datum; asked twice, Core is waited on once.
    expect(await Effect.runPromise(bootstrap.ended)).toEqual({ exitCode: 3 });
    expect(await Effect.runPromise(bootstrap.ended)).toEqual({ exitCode: 3 });
    expect(waits).toBe(1);
  });

  it("fails a refused dotfiles apply with Core's stable code, and a failed one with dotfiles_failed", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
    const base = workspaceRecording([], []);
    const refusing = (error: Error): Workspace => ({
      ...base,
      dotfiles: {
        apply: async () => {
          throw error;
        },
      },
    });
    const codeOf = async (error: Error) => {
      const exit = await Effect.runPromiseExit(
        platform.applyDotfiles(refusing(error), {
          onBehalfOf: "user-alice",
          user,
          home: user.home,
          archives: [{ data: "eA==", manager: "copy", bootstrap: false }],
        }),
      );
      if (Exit.isSuccess(exit)) return null;
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      return failure?._tag === "Fail" ? failure.error.code : null;
    };
    expect(
      await codeOf(
        new SealantApiError("home-mismatch", {
          code: "WorkspaceConflictError",
          status: 409,
          reason: "home-mismatch",
        }),
      ),
    ).toBe("home-mismatch");
    expect(await codeOf(new SealantError("chezmoi: exit 1", { code: "dotfiles_failed" }))).toBe(
      "dotfiles_failed",
    );
  });

  it("puts a person launch's owner map on its capture source, and leaves any other create as it is", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
    const map = { gid: 40_000, worktreeUid: 40_001, people: [{ id: "alice", uid: 40_001 }] };
    const capture: CreateOptions = {
      harness: claudeCode(),
      source: { kind: "capture", endpoint: "https://mend.test", token: "t".repeat(43) },
    };
    const mapped = platform.withOwnerMap(capture, map);
    expect(mapped.source).toEqual({ ...capture.source, ownerMap: map });
    // The create it was given is unchanged.
    expect(capture.source).not.toHaveProperty("ownerMap");
    const standby: CreateOptions = {
      harness: claudeCode(),
      source: { kind: "standby", rootPath: "/store/worktrees" },
    };
    expect(platform.withOwnerMap(standby, map)).toBe(standby);
  });

  it("asks Core about an image once per key while the answer lasts, as the launcher", async () => {
    const asked: Array<CreateOptions> = [];
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(
        Layer.provide(clientsLayer(asked, inspection("unsupported", ["setuid-sudo", "acl"]))),
      ),
    );
    const input = { ownerUserId: "alice", image: defaultWorkspaceImage, harness: claudeCode() };
    const first = await Effect.runPromise(platform.imageReport(input));
    const again = await Effect.runPromise(platform.imageReport(input));
    expect(first).toEqual({
      digest: "sha256:abc",
      runtime: "docker",
      person: false,
      missing: ["no sudo", "no ACLs on /workspace"],
    });
    expect(again).toEqual(first);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.harness.id).toBe(claudeCode().id);
  });

  it("reads Core's unknown as unknown, never as a no", () => {
    expect(imageLayoutReportOf(inspection("unknown"))).toEqual({
      digest: null,
      runtime: "docker",
      person: null,
      missing: [],
    });
    expect(imageLayoutReportOf(inspection("supported")).person).toBe(true);
  });
});

describe("what the control plane says it can do (review of mend#569, P3-4)", () => {
  effectIt.effect("refuses the person layout by Core's own report, read once while it lasts", () =>
    Effect.gen(function* () {
      const answers: Array<boolean | null> = [false, true, null];
      let asked = 0;
      const features = () =>
        Effect.suspend(() => {
          const answer = answers[asked++];
          return answer === null || answer === undefined
            ? Effect.fail(
                new SealantPlatformError({ code: "x", status: 503, message: "down", cause: null }),
              )
            : Effect.succeed({ processUser: answer });
        });
      const platform = yield* PersonLayoutPlatform.pipe(
        Effect.provide(
          PersonLayoutPlatformLive.pipe(
            Layer.provide(clientsLayer([], inspection("supported"), features)),
          ),
        ),
      );
      expect(yield* platform.controlPlaneObstacle).toBe(CONTROL_PLANE_NO_PROCESS_USER);
      // Kept: asked once while the answer lasts.
      expect(yield* platform.controlPlaneObstacle).toBe(CONTROL_PLANE_NO_PROCESS_USER);
      expect(asked).toBe(1);
      // An upgraded control plane is seen once it has passed.
      yield* TestClock.adjust("6 minutes");
      expect(yield* platform.controlPlaneObstacle).toBeNull();
      yield* TestClock.adjust("6 minutes");
      // Unreadable is no, and asked again soon.
      expect(yield* platform.controlPlaneObstacle).toBe(CONTROL_PLANE_UNREADABLE);
      expect(asked).toBe(3);
    }),
  );
});

describe("a credentials call Core never answers (review 2 of mend#564, P3-5)", () => {
  effectIt.effect(
    "gives up after 30 s with words, so a person's lock is never held for minutes",
    () =>
      Effect.gen(function* () {
        const platform = yield* PersonLayoutPlatform;
        const base = workspaceRecording([], []);
        const hung: Workspace = {
          ...base,
          credentials: {
            ...base.credentials,
            put: () => new Promise(() => {}),
            release: () => new Promise(() => {}),
          },
        };
        const writing = yield* platform
          .postCredentials(hung, { onBehalfOf: "maria", home: "/home/m", logins: { claude: true } })
          .pipe(Effect.flip, Effect.forkChild);
        const releasing = yield* platform
          .deleteCredentials(hung, { home: "/home/m" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("31 seconds");
        const written = yield* Fiber.join(writing);
        const released = yield* Fiber.join(releasing);
        expect(written.code).toBe("credentials_timeout");
        expect(written.message).toContain("within 30 s");
        expect(released.code).toBe("credentials_timeout");
      }).pipe(Effect.provide(PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))))),
  );
});

describe("a platform with none of the person layout", () => {
  it("can run no part of it, and says so", async () => {
    const platform = await platformWith(PersonLayoutPlatformNone);
    expect(platform.processUser).toBe(false);
    expect(
      await Effect.runPromise(
        platform.imageReport({
          ownerUserId: "alice",
          image: defaultWorkspaceImage,
          harness: claudeCode(),
        }),
      ),
    ).toEqual(UNKNOWN_IMAGE_REPORT);
    const workspace = workspaceRecording([], []);
    for (const call of [
      platform.postCredentials(workspace, { onBehalfOf: "a", home: "/root", logins: {} }),
      platform.deleteCredentials(workspace, { home: "/root" }),
      platform.listCredentials(workspace),
      platform.applyDotfiles(workspace, {
        onBehalfOf: "user-alice",
        user,
        home: user.home,
        archives: [],
      }),
    ]) {
      const exit = await Effect.runPromiseExit(call);
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });
});
