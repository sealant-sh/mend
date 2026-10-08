/**
 * The person layout's platform calls through the REAL SDK (no fake `SealantClients`): the request
 * builders the SDK runs before any call are the ones that refused Mend's image question on the box
 * (0.36.0-next.645), so these tests hand them exactly the options Mend passes, and answer the
 * calls that reach the wire from a stand-in control plane on loopback.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { defaultWorkspaceImage, type WorkspaceImage } from "@mend/domain";
import { claudeCode, codex, type CreateOptions, Sealant, SealantError } from "@sealant/sdk";
import { Context, Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SealantClientsLive } from "./client.ts";
import { SealantEnv } from "./config.ts";
import { SealantIdentityStore } from "./identity.ts";
import { IMAGE_QUESTION_SOURCE, PersonLayoutPlatformLive } from "./person-layout-live.ts";
import { type CaptureOwnerMap, PersonLayoutPlatform } from "./person-layout.ts";

interface Received {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly text: string;
  readonly body: unknown;
}

const received: Array<Received> = [];

const PERSON_LAYOUT = {
  status: "supported",
  missing: [],
  unknown: [],
  runtime: "docker",
  acl: "supported",
} as const;

/** What Core answers for each call the person layout makes. */
const answer = (request: Received): { readonly status: number; readonly body: unknown } => {
  const { method, path } = request;
  if (method === "POST" && path === "/v1/workspaces/image") {
    return {
      status: 200,
      body: {
        planHash: "plan-1",
        publishedImage: {
          reference: "registry/img:1",
          digestReference: "registry/img@sha256:abc",
          digest: "sha256:abc",
          personLayout: PERSON_LAYOUT,
        },
        personLayout: PERSON_LAYOUT,
      },
    };
  }
  if (method === "GET" && path === "/v1/workspaces/ws-1") {
    return {
      status: 200,
      body: {
        workspaceId: "ws-1",
        name: "mend-ws",
        ownerUserId: "su-alice",
        status: "running",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:00.000Z",
      },
    };
  }
  if (path === "/v1/workspaces/ws-1/credentials") {
    if (method === "POST") {
      const put = request.body;
      const home = typeof put === "object" && put !== null && "home" in put ? String(put.home) : "";
      return {
        status: 200,
        body: {
          workspaceId: "ws-1",
          runId: "run-1",
          home: { home, onBehalfOfUserId: "su-maria", accounts: {} },
          skipped: [],
        },
      };
    }
    if (method === "DELETE") {
      return {
        status: 200,
        body: {
          workspaceId: "ws-1",
          runId: "run-1",
          home: request.query.get("home") ?? "",
          released: true,
        },
      };
    }
    if (method === "GET") {
      return {
        status: 200,
        body: {
          workspaceId: "ws-1",
          runId: "run-1",
          homes: [
            {
              home: "/home/mxyz2345a",
              onBehalfOfUserId: "su-maria",
              accounts: { codex: { connectedAccountId: "cacc_2", name: "default" } },
            },
          ],
        },
      };
    }
  }
  return { status: 404, body: { _tag: "WorkspaceNotFoundError", message: `${method} ${path}` } };
};

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://loopback");
      const text = Buffer.concat(chunks).toString("utf8");
      const request: Received = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        text,
        body: text.length === 0 ? null : JSON.parse(text),
      };
      received.push(request);
      const answered = answer(request);
      res.writeHead(answered.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answered.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received.length = 0;
});

/** The live platform on the live clients, as the server composes them. */
const live = () =>
  PersonLayoutPlatformLive.pipe(
    Layer.provide(SealantClientsLive),
    Layer.provide(Layer.succeed(SealantEnv, { baseUrl, serviceKey: Option.none() })),
    Layer.provide(
      Layer.succeed(SealantIdentityStore, {
        user: (userId) =>
          Effect.succeed({ id: userId, email: `${userId}@mend.test`, name: userId }),
        sealantUserId: (userId) => Effect.succeed(`su-${userId}`),
        record: () => Effect.void,
      }),
    ),
  );

const withPlatform = <A, E>(
  use: (platform: Context.Service.Shape<typeof PersonLayoutPlatform>) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* PersonLayoutPlatform);
    }).pipe(Effect.provide(live())),
  );

/** The SDK as Mend's admin client builds it: what `imageKey` is computed with. */
const sdk = () => new Sealant({ baseUrl });

/** A capture create as the engine sends one (`captureSourceFor`, `createWorkspace`). */
const captureCreateOf = (image: WorkspaceImage) =>
  ({
    source: {
      kind: "capture",
      endpoint: "https://mend.example.com/api/session-channel",
      worktreeId: "0b7c5c5e-8f0e-4c0a-9a55-6b8e7f3f8f10",
      token: "t".repeat(43),
      harnessHome: "/mend/harness-home",
    },
    harness: claudeCode(),
    name: "mend-0b7c5c5e",
    ...(image.mode === "custom" ? { baseImage: image.baseImage } : { os: image.os }),
    ...(image.mode === "family" && image.shell !== "bash" ? { shell: image.shell } : {}),
    packages: image.packages,
    services: image.services,
    env: { MEND_SESSION_ID: "session-1" },
    ttl: "12h",
    credentials: { claude: true, github: true },
  }) satisfies CreateOptions;

const IMAGES: ReadonlyArray<readonly [string, WorkspaceImage]> = [
  ["the default image", defaultWorkspaceImage],
  [
    "a bash family image without docker",
    { mode: "family", os: "fedora", packages: ["git"], shell: "bash", services: { docker: false } },
  ],
  [
    "a custom base image",
    {
      mode: "custom",
      baseImage: "ghcr.io/acme/base:1",
      packages: ["ripgrep"],
      setupCommands: [],
      services: { docker: false },
    },
  ],
];

describe("the image question at decide time, through the real SDK (box, 0.36.0-next.645)", () => {
  for (const [what, image] of IMAGES) {
    it(`asks Core about ${what} with options the SDK accepts, keyed as the create is`, async () => {
      const report = await withPlatform((platform) =>
        platform.imageReport({ ownerUserId: "alice", image, harness: claudeCode() }),
      );
      expect(report).toEqual({
        digest: "sha256:abc",
        runtime: "docker",
        person: true,
        missing: [],
      });
      // One question, as the launcher, naming a capture source as the create does; the
      // question's token never reaches the wire.
      const asked = received.filter((request) => request.path === "/v1/workspaces/image");
      expect(asked).toHaveLength(1);
      expect(asked[0]?.body).toMatchObject({
        ownerUserId: "su-alice",
        spec: { sources: { workspace: { kind: "capture" } }, harness: { id: "claude-code" } },
      });
      expect(asked[0]?.text).not.toContain(IMAGE_QUESTION_SOURCE.token);
      expect(asked[0]?.body).not.toHaveProperty("captureToken");
      // The key Mend keeps the answer under is the key of the create it is about.
      const options = {
        source: IMAGE_QUESTION_SOURCE,
        harness: claudeCode(),
        ...(image.mode === "custom" ? { baseImage: image.baseImage } : { os: image.os }),
        ...(image.mode === "family" && image.shell !== "bash" ? { shell: image.shell } : {}),
        packages: image.packages,
        services: image.services,
      } satisfies CreateOptions;
      expect(sdk().workspaces.imageKey(options)).toBe(
        sdk().workspaces.imageKey(captureCreateOf(image)),
      );
    });
  }

  it("keys another harness apart, and asks Core once per key", async () => {
    await withPlatform((platform) =>
      Effect.gen(function* () {
        const input = { ownerUserId: "alice", image: defaultWorkspaceImage };
        yield* platform.imageReport({ ...input, harness: claudeCode() });
        yield* platform.imageReport({ ...input, harness: claudeCode() });
        yield* platform.imageReport({ ...input, harness: codex() });
      }),
    );
    expect(received.filter((request) => request.path === "/v1/workspaces/image")).toHaveLength(2);
  });

  it("the SDK still refuses options with no source, as it did on the box", () => {
    const { source: _source, ...sourceless } = captureCreateOf(defaultWorkspaceImage);
    expect(() => sdk().workspaces.imageKey(sourceless)).toThrow(SealantError);
  });
});

describe("the person create's owner map, through the real SDK's create builder", () => {
  // As the engine builds it (`captureOwnerMapOf`): the mend group, a uid per person from the
  // reserved range, each person by their Mend account id (better-auth's 32-character ids).
  const map: CaptureOwnerMap = {
    gid: 40_000,
    worktreeUid: 40_001,
    people: [
      { id: "Qx7Lr2mN8vKpZ3tHwY6cB1dF9sJ4gA0e", uid: 40_001 },
      { id: "user-fixture", uid: 40_002 },
    ],
  };

  it("rides the capture source of the create, which the SDK accepts", async () => {
    const create = captureCreateOf(defaultWorkspaceImage);
    const mapped = await withPlatform((platform) =>
      Effect.sync(() => platform.withOwnerMap(create, map)),
    );
    expect(mapped.source).toEqual({ ...create.source, ownerMap: map });
    // `imageKey` runs the whole create builder, owner map checks included, and calls nothing.
    expect(() => sdk().workspaces.imageKey(mapped)).not.toThrow();
    // A map the builder refuses is refused there, so the check above is a real one.
    expect(() =>
      sdk().workspaces.imageKey({
        ...create,
        source: { ...create.source, ownerMap: { ...map, worktreeUid: 1_000 } },
      }),
    ).toThrow(/ownerMap/);
  });
});

describe("a person's logins, through the real SDK's workspace handle", () => {
  it("writes, releases and lists them with payloads the SDK encodes and Core reads", async () => {
    const workspace = await sdk().workspaces.get("ws-1");
    received.length = 0;
    const homes = await withPlatform((platform) =>
      Effect.gen(function* () {
        const written = yield* platform.postCredentials(workspace, {
          onBehalfOf: "maria",
          home: "/home/mxyz2345a",
          owner: { uid: 40_002, gid: 40_000 },
          logins: { codex: true, github: null, pi: true, opencode: true },
          partial: true,
        });
        expect(written.skipped).toEqual([]);
        yield* platform.deleteCredentials(workspace, { home: "/home/mxyz2345a" });
        return yield* platform.listCredentials(workspace);
      }),
    );
    const [put, release, list] = received;
    expect(put?.method).toBe("POST");
    expect(put?.body).toEqual({
      ownerUserId: expect.any(String),
      onBehalfOfUserId: "su-maria",
      home: "/home/mxyz2345a",
      uid: 40_002,
      gid: 40_000,
      codex: "default",
      github: null,
      pi: "default",
      opencode: "default",
      partial: true,
    });
    expect(release?.method).toBe("DELETE");
    expect(release?.query.get("home")).toBe("/home/mxyz2345a");
    expect(list?.method).toBe("GET");
    expect(homes).toEqual([
      { home: "/home/mxyz2345a", onBehalfOf: "su-maria", providers: ["codex"] },
    ]);
  });
});
