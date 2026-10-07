import { defaultWorkspaceImage } from "@mend/domain";
import {
  claudeCode,
  type CreateOptions,
  type Workspace,
  type WorkspaceCredentialsPutOptions,
  type WorkspaceImageInspection,
} from "@sealant/sdk";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { SealantClients } from "./client.ts";
import { PersonLayoutPlatformLive, imageLayoutReportOf } from "./person-layout-live.ts";
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

/** A workspace whose credentials API records what it was asked. */
const workspaceRecording = (calls: Array<string>, puts: Array<WorkspaceCredentialsPutOptions>) => {
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
    credentials: {
      put: async (options) => {
        calls.push(`put:${options.home}`);
        puts.push(options);
        return { home: options.home, onBehalfOf: options.onBehalfOf, accounts: {} };
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
) =>
  Layer.mock(SealantClients, {
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
    await Effect.runPromise(
      platform.postCredentials(workspace, {
        onBehalfOf: "maria",
        home: "/home/mxyz2345a",
        owner: { uid: 40_002, gid: 40_000 },
        logins: { claude: true, github: null },
      }),
    );
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
    // Dotfiles as a person have no SDK surface yet: refused, never run as root in their place.
    const dotfiles = await Effect.runPromiseExit(
      platform.applyDotfiles(workspace, { user, home: user.home, archives: [] }),
    );
    expect(Exit.isFailure(dotfiles)).toBe(true);
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
      platform.applyDotfiles(workspace, { user: null, home: "/root", archives: [] }),
    ]) {
      const exit = await Effect.runPromiseExit(call);
      expect(Exit.isFailure(exit)).toBe(true);
    }
  });
});
