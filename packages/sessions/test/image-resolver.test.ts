import { createHash } from "node:crypto";
import * as http from "node:http";

import { imageReference } from "@mend/domain/workbench";
import { Effect, Result } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  imageRefusalLine,
  ImageResolutionError,
  type RegistryAccess,
  ResourceImageResolver,
  resourceImageResolverWith,
} from "../src/resources/image-resolver.ts";

const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";
const index = (tag: string) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: INDEX_TYPE,
      manifests: [],
      annotations: { tag },
    }),
  );
const digestOf = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

interface Seen {
  readonly url: string;
  readonly authorization: string | undefined;
}

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

const servers: Array<http.Server> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        }),
    ),
  );
});

/** A local registry: every request is recorded, then answered by `handle`. */
const registry = async (handle: Handler) => {
  const seen: Array<Seen> = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
    handle(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const { port } = address;
  return { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, seen };
};

const serve =
  (bytes: Buffer, headers: Readonly<Record<string, string>> = {}): Handler =>
  (_request, response) => {
    response.writeHead(200, { "content-type": INDEX_TYPE, ...headers });
    response.end(bytes);
  };

const resolveWith = (access: Partial<RegistryAccess>, image: string) =>
  Effect.runPromise(
    Effect.flatMap(ResourceImageResolver, (resolver) => resolver.resolve(image)).pipe(
      Effect.result,
      Effect.provide(
        resourceImageResolverWith({
          mirrors: [],
          resolve: () => Promise.reject(new Error("no name resolves in this test")),
          deadlineMs: 2_000,
          maxManifestBytes: 64 * 1024,
          ...access,
        }),
      ),
    ),
  );

const refusalLine = (reason: ImageResolutionError["reason"]) =>
  imageRefusalLine("db", new ImageResolutionError({ image: "postgres:17", reason }));

const failureOf = (result: Result.Result<unknown, ImageResolutionError>) =>
  Result.isFailure(result) ? result.failure.reason : "resolved";

describe("pinning a resource's image through the registry API", () => {
  it("pins a Docker Hub tag to the digest of the bytes its mirror served", async () => {
    const bytes = index("17");
    const mirror = await registry(serve(bytes, { "docker-content-digest": digestOf(bytes) }));
    const result = await resolveWith({ mirrors: [new URL(mirror.origin)] }, "postgres:17");
    expect(result).toEqual(Result.succeed({ digest: digestOf(bytes), resolvedBy: mirror.host }));
    expect(mirror.seen.map((each) => each.url)).toEqual(["/v2/library/postgres/manifests/17"]);
  });

  it.each(["docker.io/postgres:17", "index.docker.io/library/postgres:17", "library/postgres:17"])(
    "asks Docker Hub's mirror for %s as the repository the postgres preset reads",
    async (image) => {
      const mirror = await registry(serve(index("17")));
      await resolveWith({ mirrors: [new URL(mirror.origin)] }, image);
      expect(imageReference(image).repository).toBe("postgres");
      expect(mirror.seen.map((each) => each.url)).toEqual(["/v2/library/postgres/manifests/17"]);
    },
  );

  it("answers an image pinned by digest with that digest, asking no registry", async () => {
    const mirror = await registry(serve(index("17")));
    const pinned = `sha256:${"b".repeat(64)}`;
    const result = await resolveWith(
      { mirrors: [new URL(mirror.origin)] },
      `postgres:17@${pinned}`,
    );
    expect(result).toEqual(Result.succeed({ digest: pinned, resolvedBy: null }));
    expect(mirror.seen).toEqual([]);
  });

  it("asks the next mirror when one does not answer", async () => {
    const bytes = index("8");
    const down = await registry((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const up = await registry(serve(bytes));
    const result = await resolveWith(
      { mirrors: [new URL(down.origin), new URL(up.origin)] },
      "redis:8",
    );
    expect(result).toEqual(Result.succeed({ digest: digestOf(bytes), resolvedBy: up.host }));
  });

  it("answers one anonymous token challenge, and sends the token only to the registry", async () => {
    const bytes = index("17");
    const mirror = await registry((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (url.pathname === "/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "pull-token" }));
      } else if (request.headers.authorization === "Bearer pull-token") {
        serve(bytes)(request, response);
      } else {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="http://${request.headers.host}/token",service="fixture"`,
        });
        response.end();
      }
    });
    const result = await resolveWith({ mirrors: [new URL(mirror.origin)] }, "postgres:17");
    expect(result).toEqual(Result.succeed({ digest: digestOf(bytes), resolvedBy: mirror.host }));
    expect(mirror.seen).toEqual([
      { url: "/v2/library/postgres/manifests/17", authorization: undefined },
      {
        url: "/token?service=fixture&scope=repository%3Alibrary%2Fpostgres%3Apull",
        authorization: undefined,
      },
      { url: "/v2/library/postgres/manifests/17", authorization: "Bearer pull-token" },
    ]);
  });

  it("says a registry that still refuses after its token needs a login", async () => {
    const mirror = await registry((request, response) => {
      if (request.url?.startsWith("/token") === true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "t" }));
        return;
      }
      response.writeHead(401, {
        "www-authenticate": `Bearer realm="http://${request.headers.host}/token"`,
      });
      response.end();
    });
    expect(failureOf(await resolveWith({ mirrors: [new URL(mirror.origin)] }, "acme/app:1"))).toBe(
      "login-required",
    );
    expect(mirror.seen).toHaveLength(3);
  });

  it("says a missing tag is not found", async () => {
    const mirror = await registry((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    expect(failureOf(await resolveWith({ mirrors: [new URL(mirror.origin)] }, "postgres:99"))).toBe(
      "not-found",
    );
  });

  it("refuses a manifest over its size limit unread", async () => {
    const mirror = await registry(serve(Buffer.alloc(4096, 0x20)));
    const result = await resolveWith(
      { mirrors: [new URL(mirror.origin)], maxManifestBytes: 1024 },
      "postgres:17",
    );
    expect(failureOf(result)).toBe("unverifiable");
  });

  it("refuses bytes whose digest is not the one the registry claims", async () => {
    const mirror = await registry(
      serve(index("17"), { "docker-content-digest": `sha256:${"c".repeat(64)}` }),
    );
    expect(failureOf(await resolveWith({ mirrors: [new URL(mirror.origin)] }, "postgres:17"))).toBe(
      "unverifiable",
    );
  });

  it("refuses a reply that is not a manifest or an index", async () => {
    const mirror = await registry(serve(index("17"), { "content-type": "text/html" }));
    expect(failureOf(await resolveWith({ mirrors: [new URL(mirror.origin)] }, "postgres:17"))).toBe(
      "unverifiable",
    );
  });

  it("gives up at its deadline on a registry that never answers", async () => {
    const mirror = await registry(() => {});
    const started = Date.now();
    const result = await resolveWith(
      { mirrors: [new URL(mirror.origin)], deadlineMs: 200 },
      "postgres:17",
    );
    expect(failureOf(result)).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it.each([
    [
      "to plain HTTP off the mirror",
      (other: string) => `${other}/v2/library/postgres/manifests/17`,
    ],
    ["to a name on a private address", () => "https://registry.internal/v2/x/manifests/17"],
    ["to a private address", () => "https://10.0.0.5/v2/x/manifests/17"],
  ])("refuses a redirect %s, dialing nothing there", async (_, target) => {
    const elsewhere = await registry(serve(index("17")));
    const mirror = await registry((_request, response) => {
      response.writeHead(307, { location: target(elsewhere.origin) });
      response.end();
    });
    const result = await resolveWith(
      {
        mirrors: [new URL(mirror.origin)],
        resolve: async (host) => (host === "registry.internal" ? ["10.0.0.7"] : []),
      },
      "postgres:17",
    );
    expect(failureOf(result)).toBe("registry-refused");
    expect(elsewhere.seen).toEqual([]);
  });

  it("refuses a registry that resolves to this machine, before dialing it", async () => {
    const asked: Array<string> = [];
    const result = await resolveWith(
      {
        resolve: async (host) => {
          asked.push(host);
          return ["127.0.0.1"];
        },
      },
      "ghcr.io/acme/mail:v1",
    );
    expect(failureOf(result)).toBe("registry-refused");
    expect(asked).toEqual(["ghcr.io"]);
  });

  it("says each failure in words that end in not approved", () => {
    expect(refusalLine("not-found")).toBe(
      "@db · image postgres:17 · not found in the registry · not approved",
    );
    expect(refusalLine("login-required")).toBe(
      "@db · image postgres:17 · registry needs a login · ask the operator · not approved",
    );
    expect(refusalLine("registry-refused")).toBe(
      "@db · image postgres:17 · registry is not allowed on this instance · not approved",
    );
    expect(refusalLine("unavailable")).toBe(
      "@db · image postgres:17 · registry did not answer · try approval again · not approved",
    );
    expect(refusalLine("unverifiable")).toBe(
      "@db · image postgres:17 · registry returned an unverifiable manifest · not approved",
    );
  });
});
