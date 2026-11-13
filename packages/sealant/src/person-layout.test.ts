import { it as effectIt } from "@effect/vitest";
import { defaultWorkspaceImage } from "@mend/domain";
import {
  claudeCode,
  type CreateOptions,
  SealantApiError,
  SealantError,
  type SealantFeatures,
  type Workspace,
  type WorkspaceCredentialPlacementReceipt,
  type WorkspaceCredentialsPutOptions,
  type WorkspaceDotfilesApplyOptions,
  type WorkspaceImageInspection,
} from "@sealant/sdk";
import { Effect, Exit, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { ConnectedAccount } from "./accounts.ts";
import { SealantClients } from "./client.ts";
import { SealantPlatformError } from "./errors.ts";
import {
  CONTROL_PLANE_UNREADABLE,
  controlPlaneObstacleOf,
  runsSshAsUser,
  PersonLayoutPlatformLive,
  imageLayoutReportOf,
} from "./person-layout-live.ts";
import {
  PersonLayoutPlatform,
  PersonLayoutPlatformNone,
  personProcessRefusal,
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
    publication: never,
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
    processUser: never,
    sshAsRoot: never,
    phase: never,
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
      prune: async (home) => {
        calls.push(`prune:${home}`);
        return undefined;
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

/** sealant 0.39.0-next.706: every feature the person layout uses, before SSH users. */
const EVERY_FEATURE: SealantFeatures = {
  processUserRoutes: true,
  dotfilesApply: true,
  credentialsPartialPut: true,
  credentialsPiOpencode: true,
  captureOwnerMap: true,
  kubernetesPersonLayout: true,
  workspaceSshUser: false,
  personBinding: false,
  sshKeyRemovalEndsConnections: false,
  connectedAccountDefaults: false,
  connectedAccountLoginClass: false,
  credentialPlacements: false,
  connectedAccountApiKeys: false,
  connectedAccountEndpoints: false,
  inferenceAllowedLogin: false,
};
/** A control plane from before any of them (an older sealant reports every flag false). */
const NO_FEATURE: SealantFeatures = {
  processUserRoutes: false,
  dotfilesApply: false,
  credentialsPartialPut: false,
  credentialsPiOpencode: false,
  captureOwnerMap: false,
  kubernetesPersonLayout: false,
  workspaceSshUser: false,
  personBinding: false,
  sshKeyRemovalEndsConnections: false,
  connectedAccountDefaults: false,
  connectedAccountLoginClass: false,
  credentialPlacements: false,
  connectedAccountApiKeys: false,
  connectedAccountEndpoints: false,
  inferenceAllowedLogin: false,
};

const clientsLayer = (
  inspections: Array<CreateOptions>,
  answer: WorkspaceImageInspection = inspection("supported"),
  features: () => Effect.Effect<SealantFeatures, SealantPlatformError> = () =>
    Effect.succeed(EVERY_FEATURE),
) =>
  Layer.mock(SealantClients, {
    controlPlaneFeatures: features,
    connectedAccounts: () => ({ list: unused, connect: unused, disconnect: unused }),
    sshKeys: () => ({ ensure: unused, list: unused, remove: unused }),
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

/** A partial put of Maria's Claude and Codex logins, through the live platform. */
const put = (layer: Layer.Layer<SealantClients>, workspace: Workspace) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const platform = yield* PersonLayoutPlatform;
      return yield* platform.postCredentials(workspace, {
        onBehalfOf: "maria",
        home: "/home/mxyz2345a",
        logins: { claude: true, codex: true },
        partial: true,
      });
    }).pipe(Effect.provide(PersonLayoutPlatformLive.pipe(Layer.provide(layer)))),
  );

/** One of Maria's Claude accounts, chosen or not. */
const account = (id: string, isDefault: boolean) =>
  new ConnectedAccount({
    id,
    provider: "claude",
    name: id,
    kind: "api-key",
    status: "active",
    metadata: {},
    connectedAt: new Date(0),
    updatedAt: new Date(0),
    lastUsedAt: null,
    isDefault,
  });

describe("the live platform (sealant 0.39)", () => {
  it("runs processes as a user, and writes, releases and lists a person's logins per home", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
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
    // sealant is named the person's Sealant user, and the home's numeric owner.
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
      { home: "/home/m3kq7xj2a", onBehalfOf: "su-alice", providers: ["claude"], placed: {} },
      {
        home: "/home/mxyz2345a",
        onBehalfOf: "su-maria",
        providers: ["codex", "github"],
        placed: {},
      },
    ]);
    expect(calls).toEqual(["put:/home/mxyz2345a", "release:/home/mxyz2345a", "list"]);
  });

  it("puts a join's logins in one partial call, pi's and opencode's ChatGPT logins included, and answers what sealant left out (sealant#336, #337)", async () => {
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

  describe("what each login in a home spends (docs/adr/0018, decision 1)", () => {
    const FAKE_KEY_PATH = "/home/mxyz2345a/.sealant/keys/plc_key";
    const subscription = {
      provider: "claude" as const,
      placementId: "plc_sub",
      accountId: "cacc_sub",
      revision: 1,
      login: { kind: "subscription" as const },
      pinned: false,
    };
    const claudeKey = {
      provider: "claude" as const,
      placementId: "plc_key",
      accountId: "cacc_key",
      revision: 1,
      login: { kind: "api-key" as const, suffix: "a1b2", keyPath: FAKE_KEY_PATH },
      pinned: false,
    };
    const codexKey = {
      provider: "codex" as const,
      placementId: "plc_codex",
      accountId: "cacc_codex",
      revision: 2,
      login: { kind: "api-key" as const, suffix: "c3d4" },
      pinned: false,
    };
    const PLACEMENTS: SealantFeatures = {
      ...EVERY_FEATURE,
      credentialPlacements: true,
      connectedAccountApiKeys: true,
    };
    /** A workspace whose put answers `receipts` as the home's placements afterwards. */
    const answering = (receipts: ReadonlyArray<WorkspaceCredentialPlacementReceipt>) => {
      const base = workspaceRecording([], []);
      const workspace: Workspace = {
        ...base,
        credentials: {
          ...base.credentials,
          put: async (options) => ({
            home: options.home,
            onBehalfOf: options.onBehalfOf,
            accounts: {},
            placements: receipts,
            skipped: [],
          }),
          list: async () => [
            { home: "/home/mxyz2345a", onBehalfOf: "su-maria", accounts: {}, placements: receipts },
          ],
        },
      };
      return workspace;
    };
    /** sealant with `features`, whose connected accounts for a person answer `accounts`. */
    const clientsWith = (
      features: SealantFeatures,
      accounts: Effect.Effect<ReadonlyArray<ConnectedAccount>, SealantPlatformError>,
      asked: Array<string> = [],
    ) =>
      Layer.mock(SealantClients, {
        controlPlaneFeatures: () => Effect.succeed(features),
        connectedAccounts: (userId) => ({
          list: () => Effect.sync(() => asked.push(userId)).pipe(Effect.andThen(accounts)),
          connect: unused,
          disconnect: unused,
        }),
        sshKeys: () => ({ ensure: unused, list: unused, remove: unused }),
        sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
      });
    const withAccounts = (accounts: ReadonlyArray<ConnectedAccount>, asked: Array<string>) =>
      clientsWith(PLACEMENTS, Effect.succeed(accounts), asked);
    it("answers each provider's placed login from sealant's receipts, a Claude key's file path included", async () => {
      const asked: Array<string> = [];
      const written = await put(withAccounts([], asked), answering([claudeKey, codexKey]));
      expect(written.placed).toEqual({
        claude: { kind: "api-key", suffix: "a1b2", keyPath: FAKE_KEY_PATH },
        codex: { kind: "api-key", suffix: "c3d4" },
      });
      expect(asked).toEqual([]);
    });

    it("picks the person's chosen Claude login when a key sits beside a subscription", async () => {
      const asked: Array<string> = [];
      const toKey = await put(
        withAccounts([account("cacc_sub", false), account("cacc_key", true)], asked),
        answering([subscription, claudeKey]),
      );
      expect(toKey.placed.claude).toEqual(claudeKey.login);
      const toSubscription = await put(
        withAccounts([account("cacc_sub", true), account("cacc_key", false)], asked),
        answering([subscription, claudeKey]),
      );
      expect(toSubscription.placed.claude).toEqual({ kind: "subscription" });
      expect(asked).toEqual(["maria", "maria"]);
    });

    it("leaves Claude out when it cannot tell which of two placements is chosen: no key is read", async () => {
      const unreadable = clientsWith(
        PLACEMENTS,
        Effect.fail(
          new SealantPlatformError({ code: "x", status: 503, message: "down", cause: null }),
        ),
      );
      const written = await put(unreadable, answering([subscription, claudeKey, codexKey]));
      expect(written.placed).toEqual({ codex: codexKey.login });
    });

    it("answers nothing placed from a control plane without receipts, as before", async () => {
      const older = clientsWith(EVERY_FEATURE, Effect.succeed([]));
      const written = await put(older, answering([claudeKey]));
      expect(written.placed).toEqual({});
    });

    it("lists a home's Claude key as held, with what it spends", async () => {
      const homes = await Effect.runPromise(
        Effect.gen(function* () {
          const platform = yield* PersonLayoutPlatform;
          return yield* platform.listCredentials(answering([claudeKey]));
        }).pipe(Effect.provide(PersonLayoutPlatformLive.pipe(Layer.provide(withAccounts([], []))))),
      );
      expect(homes).toEqual([
        {
          home: "/home/mxyz2345a",
          onBehalfOf: "su-maria",
          providers: ["claude"],
          placed: { claude: claudeKey.login },
        },
      ]);
    });
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
    // A failing install.sh ends with its exit code, a datum; asked twice, sealant is waited on once.
    expect(await Effect.runPromise(bootstrap.ended)).toEqual({ exitCode: 3 });
    expect(await Effect.runPromise(bootstrap.ended)).toEqual({ exitCode: 3 });
    expect(waits).toBe(1);
  });

  it("fails a refused dotfiles apply with sealant's stable code, and a failed one with dotfiles_failed", async () => {
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

  it("asks sealant about an image once per key while the answer lasts, as the launcher", async () => {
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

  it("reads an image question the SDK refuses as unknown, and asks sealant nothing", async () => {
    const asked: Array<CreateOptions> = [];
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(
        Layer.provide(
          Layer.mock(SealantClients, {
            controlPlaneFeatures: () => Effect.succeed(EVERY_FEATURE),
            connectedAccounts: () => ({ list: unused, connect: unused, disconnect: unused }),
            sshKeys: () => ({ ensure: unused, list: unused, remove: unused }),
            imageKey: () =>
              Effect.fail(
                new SealantPlatformError({
                  code: "invalid_create_options",
                  status: null,
                  message: "workspaces.create requires exactly one of `repository` or `source`.",
                  cause: null,
                }),
              ),
            inspectImage: (_userId, options) =>
              Effect.sync(() => {
                asked.push(options);
                return inspection("supported");
              }),
          }),
        ),
      ),
    );
    const report = await Effect.runPromise(
      platform.imageReport({
        ownerUserId: "alice",
        image: defaultWorkspaceImage,
        harness: claudeCode(),
      }),
    );
    expect(report).toEqual(UNKNOWN_IMAGE_REPORT);
    expect(asked).toEqual([]);
  });

  it("reads sealant's unknown as unknown, never as a no", () => {
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
  effectIt.effect(
    "refuses the person layout by sealant's own report, read once while it lasts",
    () =>
      Effect.gen(function* () {
        const answers: Array<SealantFeatures | null> = [NO_FEATURE, EVERY_FEATURE, null];
        let asked = 0;
        const features = () =>
          Effect.suspend(() => {
            const answer = answers[asked++];
            return answer === null || answer === undefined
              ? Effect.fail(
                  new SealantPlatformError({
                    code: "x",
                    status: 503,
                    message: "down",
                    cause: null,
                  }),
                )
              : Effect.succeed(answer);
          });
        const platform = yield* PersonLayoutPlatform.pipe(
          Effect.provide(
            PersonLayoutPlatformLive.pipe(
              Layer.provide(clientsLayer([], inspection("supported"), features)),
            ),
          ),
        );
        const older = controlPlaneObstacleOf(NO_FEATURE);
        expect(yield* platform.controlPlaneObstacle).toBe(older);
        // Kept: asked once while the answer lasts.
        expect(yield* platform.controlPlaneObstacle).toBe(older);
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

const refused = (message: string) =>
  personProcessRefusal(
    new SealantPlatformError({ code: "user-unsupported", status: 409, message, cause: null }),
  ).message;

describe("the features the person layout needs, and the workspace's own answer (sealant#343)", () => {
  it("names the Sealant version a control plane missing any feature needs, never the feature", () => {
    expect(controlPlaneObstacleOf(EVERY_FEATURE)).toBeNull();
    const older =
      "the Sealant control plane does not report what per-person users need, which Sealant 0.40.0 or later does";
    // An older sealant: every flag false (it reports none of them, or only `processUser`).
    expect(controlPlaneObstacleOf(NO_FEATURE)).toBe(older);
    expect(controlPlaneObstacleOf({ ...EVERY_FEATURE, credentialsPiOpencode: false })).toBe(older);
    expect(controlPlaneObstacleOf({ ...EVERY_FEATURE, kubernetesPersonLayout: false })).toBe(older);
  });

  it("reads the workspace's answer from its launch, else asks sealant, and reads a failure as unknown", async () => {
    const platform = await platformWith(
      PersonLayoutPlatformLive.pipe(Layer.provide(clientsLayer([]))),
    );
    const base = workspaceRecording([], []);
    let asked = 0;
    const launched: Workspace = {
      ...base,
      launch: { replayed: false, processUser: "supported" },
      processUser: async () => {
        asked++;
        return "unsupported";
      },
    };
    expect(await Effect.runPromise(platform.workspaceProcessUser(launched))).toBe("supported");
    expect(asked).toBe(0);
    const fetched: Workspace = {
      ...base,
      processUser: async () => {
        asked++;
        return "unsupported";
      },
    };
    expect(await Effect.runPromise(platform.workspaceProcessUser(fetched))).toBe("unsupported");
    const failing: Workspace = {
      ...base,
      processUser: async () => {
        throw new Error("down");
      },
    };
    expect(await Effect.runPromise(platform.workspaceProcessUser(failing))).toBe("unknown");
  });

  it("says why a process was refused as a person, by sealant's reason, never running it as anyone else", () => {
    expect(
      refused(
        "Workspace ws-1's sealantd doesn't run processes as another user (no exec.user), so nothing was started as 'm1'.",
      ),
    ).toBe(
      "This workspace cannot start processes as each person (its sealantd or runtime does not), so nothing was started.",
    );
    expect(refused("User 'root' is not in range (uid 0): …. Nothing was started.")).toContain(
      "outside the range",
    );
    expect(
      refused("User 'm1' is not in workspace ws-1 (no passwd entry). Nothing was started."),
    ).toBe(
      "This person's user does not exist in the workspace yet, so nothing was started. Start the session again.",
    );
    expect(
      refused("The workspace's executor did not answer whether 'm1' may run a process: x."),
    ).toContain("did not answer");
    expect(
      refused(
        "This control plane cannot start a process as the Linux user 'm1' (it does not report the feature, or could not be asked); nothing was sent.",
      ),
    ).toBe(
      "This Sealant control plane cannot start processes as each person, so nothing was started.",
    );
    expect(refused("something new")).toBe("Nothing was started as this person: something new");
    // Anything else as it is.
    const other = new SealantPlatformError({
      code: "x",
      status: 500,
      message: "boom",
      cause: null,
    });
    expect(personProcessRefusal(other)).toBe(other);
  });
});

describe("a credentials call sealant never answers (review 2 of mend#564, P3-5)", () => {
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
    expect(await Effect.runPromise(platform.controlPlaneObstacle)).toBe(
      "this Mend's platform cannot start processes as a user",
    );
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

describe("the workspace's SSH user (docs/adr/0016 decision 10, sealant#348)", () => {
  const reporting = { ...EVERY_FEATURE, workspaceSshUser: true };
  const platformReporting = (features: SealantFeatures) =>
    platformWith(
      PersonLayoutPlatformLive.pipe(
        Layer.provide(clientsLayer([], inspection("supported"), () => Effect.succeed(features))),
      ),
    );

  it("is named only where sealant says its gateway runs SSH sessions as one", async () => {
    expect(runsSshAsUser(reporting)).toBe(true);
    expect(runsSshAsUser(EVERY_FEATURE)).toBe(false);
    expect(await Effect.runPromise((await platformReporting(reporting)).sshUser)).toBe(true);
    expect(await Effect.runPromise((await platformReporting(EVERY_FEATURE)).sshUser)).toBe(false);
  });

  it("is set back to root through the handle, only where sealant takes it, and never fails", async () => {
    const asked: Array<string | null> = [];
    const settable = {
      ...workspaceRecording([], []),
      sshAsRoot: async () => {
        asked.push(null);
      },
    };
    expect(await Effect.runPromise((await platformReporting(reporting)).sshAsRoot(settable))).toBe(
      true,
    );
    expect(asked).toEqual([null]);
    // A control plane that does not take it is not asked: there is nothing to set.
    expect(
      await Effect.runPromise((await platformReporting(EVERY_FEATURE)).sshAsRoot(settable)),
    ).toBe(true);
    expect(asked).toEqual([null]);
    // A refusal is an answer of no, for the caller to try again; never a failure.
    const failing = {
      ...workspaceRecording([], []),
      sshAsRoot: async () => {
        throw new Error("down");
      },
    };
    const platform = await platformReporting(reporting);
    expect(await Effect.runPromise(platform.sshAsRoot(failing))).toBe(false);
  });

  effectIt.effect("gives up on an attempt sealant does not answer within 5 s, as a no", () =>
    Effect.gen(function* () {
      const platform = yield* PersonLayoutPlatform.pipe(
        Effect.provide(
          PersonLayoutPlatformLive.pipe(
            Layer.provide(
              clientsLayer([], inspection("supported"), () => Effect.succeed(reporting)),
            ),
          ),
        ),
      );
      const silent = {
        ...workspaceRecording([], []),
        sshAsRoot: () => new Promise<void>(() => {}),
      };
      const fiber = yield* Effect.forkChild(platform.sshAsRoot(silent));
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toBe(false);
    }),
  );

  effectIt.effect(
    "is not done while sealant cannot be asked: an unreadable feature read keeps the reset pending (review 2 of mend#641, N2)",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let resets = 0;
        const features = () =>
          ++reads === 1
            ? Effect.succeed(reporting)
            : Effect.fail(
                new SealantPlatformError({ code: "x", status: 503, message: "down", cause: null }),
              );
        const platform = yield* PersonLayoutPlatform.pipe(
          Effect.provide(
            PersonLayoutPlatformLive.pipe(
              Layer.provide(clientsLayer([], inspection("supported"), features)),
            ),
          ),
        );
        const handle = {
          ...workspaceRecording([], []),
          sshAsRoot: async () => {
            resets++;
            throw new Error("down");
          },
        };
        expect(yield* platform.sshAsRoot(handle)).toBe(false);
        // The kept answer runs out, and sealant cannot be asked: still tried, still not done.
        yield* TestClock.adjust("6 minutes");
        expect(yield* platform.sshAsRoot(handle)).toBe(false);
        expect({ resets, reads }).toEqual({ resets: 2, reads: 2 });
      }),
  );

  describe("the launcher's person binding (sealant#348, C2)", () => {
    const ALICE = { accountId: "acct_alice", uid: 40001, home: "/home/m4lice000" };
    const withBinding = (
      features: SealantFeatures,
      bind: () => Effect.Effect<"bound" | "refused", SealantPlatformError>,
      calls: Array<string>,
    ) =>
      PersonLayoutPlatformLive.pipe(
        Layer.provide(
          Layer.mock(SealantClients, {
            controlPlaneFeatures: () => Effect.succeed(features),
            connectedAccounts: () => ({ list: unused, connect: unused, disconnect: unused }),
            sshKeys: () => ({ ensure: unused, list: unused, remove: unused }),
            sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
            bindPerson: (userId, person) =>
              Effect.suspend(() => {
                calls.push(`${userId}:${person.id}:${String(person.uid)}:${person.home}`);
                return bind();
              }),
          }),
        ),
      );
    const binding = { ...reporting, personBinding: true };

    effectIt.effect("binds once and asks for the owner's SSH user from then on", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const platform = yield* PersonLayoutPlatform.pipe(
          Effect.provide(withBinding(binding, () => Effect.succeed("bound" as const), calls)),
        );
        expect(yield* platform.sshAsOwnerFor(ALICE)).toBe("yes");
        expect(yield* platform.sshAsOwnerFor(ALICE)).toBe("yes");
        expect(calls).toEqual(["acct_alice:acct_alice:40001:/home/m4lice000"]);
      }),
    );

    effectIt.effect(
      "stays root where sealant cannot bind: refused (kept a while), no route, no answer",
      () =>
        Effect.gen(function* () {
          const refusedCalls: Array<string> = [];
          const refusing = yield* PersonLayoutPlatform.pipe(
            Effect.provide(
              withBinding(binding, () => Effect.succeed("refused" as const), refusedCalls),
            ),
          );
          expect(yield* refusing.sshAsOwnerFor(ALICE)).toBe("unbound");
          expect(yield* refusing.sshAsOwnerFor(ALICE)).toBe("unbound");
          expect(refusedCalls).toHaveLength(1);
          yield* TestClock.adjust("6 minutes");
          expect(yield* refusing.sshAsOwnerFor(ALICE)).toBe("unbound");
          expect(refusedCalls).toHaveLength(2);

          // A sealant that runs SSH as a user but has no binding route: never asks for the user.
          const noRoute: Array<string> = [];
          const older = yield* PersonLayoutPlatform.pipe(
            Effect.provide(withBinding(reporting, () => Effect.succeed("bound" as const), noRoute)),
          );
          expect(yield* older.sshAsOwnerFor(ALICE)).toBe("unbound");
          expect(noRoute).toEqual([]);

          // A binding sealant does not answer within 5 s.
          const silent = yield* PersonLayoutPlatform.pipe(
            Effect.provide(withBinding(binding, () => Effect.never, [])),
          );
          const fiber = yield* Effect.forkChild(silent.sshAsOwnerFor(ALICE));
          yield* TestClock.adjust("5 seconds");
          expect(yield* Fiber.join(fiber)).toBe("unbound");
        }),
    );

    effectIt.effect("asks nothing where sealant runs no SSH session as a user", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const platform = yield* PersonLayoutPlatform.pipe(
          Effect.provide(withBinding(EVERY_FEATURE, () => Effect.succeed("bound" as const), calls)),
        );
        expect(yield* platform.sshAsOwnerFor(ALICE)).toBe("not-taken");
        expect(calls).toEqual([]);
      }),
    );
  });
});
