import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";

import { imageReference } from "@mend/domain/workbench";
import { classifyAddress } from "@mend/store";
import { Effect, Result } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

const servers: Array<http.Server | https.Server> = [];
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

const listening = async (server: http.Server | https.Server, seen: Array<Seen>) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, seen };
};

const recording =
  (seen: Array<Seen>, handle: Handler): Handler =>
  (request, response) => {
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
    handle(request, response);
  };

/** A local registry: every request is recorded, then answered by `handle`. */
const registry = async (handle: Handler) => {
  const seen: Array<Seen> = [];
  const { port } = await listening(http.createServer(recording(seen, handle)), seen);
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
          isPublic: (address) => classifyAddress(address) === "public",
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

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

const challenge =
  (realm: string): Handler =>
  (_request, response) => {
    response.writeHead(401, { "www-authenticate": `Bearer realm="${realm}",service="fixture"` });
    response.end();
  };

/**
 * A registry that is not a mirror: HTTPS under a name only this test resolves, on a loopback
 * address the test calls public, with a certificate the process trusts for the test's length.
 */
describe.skipIf(!hasOpenssl)("a registry that is not a mirror, over HTTPS", () => {
  const NAMES = ["registry.test", "other.test"];
  const trusted = tls.getCACertificates("default");
  const tlsFiles = { key: "", cert: "" };

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-registry-tls-"));
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    const made = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=registry.test",
      "-addext",
      `subjectAltName=${NAMES.map((name) => `DNS:${name}`).join(",")}`,
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    expect(made.status).toBe(0);
    tlsFiles.key = fs.readFileSync(key, "utf8");
    tlsFiles.cert = fs.readFileSync(cert, "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
    tls.setDefaultCACertificates([...trusted, tlsFiles.cert]);
  });

  afterAll(() => {
    tls.setDefaultCACertificates(trusted);
  });

  const secure = async (name: string, handle: Handler) => {
    const seen: Array<Seen> = [];
    const server = https.createServer(
      { key: tlsFiles.key, cert: tlsFiles.cert },
      recording(seen, handle),
    );
    const { port } = await listening(server, seen);
    return { origin: `https://${name}:${port}`, host: `${name}:${port}`, seen };
  };

  /** Each test name resolves to loopback, which these tests call public; nothing else is. */
  const publicLoopback = (addresses: Readonly<Record<string, ReadonlyArray<string>>> = {}) => {
    const asked: Array<string> = [];
    return {
      asked,
      access: {
        resolve: async (host: string) => {
          asked.push(host);
          return addresses[host] ?? (NAMES.includes(host) ? ["127.0.0.1"] : []);
        },
        isPublic: (address: string) => address === "127.0.0.1",
      },
    };
  };

  it("dials the address it checked, for a name no other resolver knows", async () => {
    const bytes = index("1");
    const remote = await secure("registry.test", serve(bytes));
    const names = publicLoopback();
    const result = await resolveWith(names.access, `${remote.host}/acme/app:1`);
    expect(result).toEqual(Result.succeed({ digest: digestOf(bytes), resolvedBy: remote.host }));
    expect(names.asked).toEqual(["registry.test"]);
    expect(remote.seen.map((each) => each.url)).toEqual(["/v2/acme/app/manifests/1"]);
  });

  it("sends its token to no origin a redirect names", async () => {
    const bytes = index("1");
    const other = await secure("other.test", serve(bytes));
    const remote = await secure("registry.test", (request, response) => {
      if (request.url?.startsWith("/token") === true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ token: "pull-token" }));
      } else if (request.headers.authorization === "Bearer pull-token") {
        response.writeHead(307, { location: `${other.origin}/v2/acme/app/manifests/1` });
        response.end();
      } else {
        challenge(`https://${request.headers.host}/token`)(request, response);
      }
    });
    const result = await resolveWith(publicLoopback().access, `${remote.host}/acme/app:1`);
    expect(result).toEqual(Result.succeed({ digest: digestOf(bytes), resolvedBy: remote.host }));
    expect(remote.seen.map((each) => each.authorization)).toEqual([
      undefined,
      undefined,
      "Bearer pull-token",
    ]);
    expect(other.seen).toEqual([{ url: "/v2/acme/app/manifests/1", authorization: undefined }]);
  });

  it.each([
    ["on a private address", () => "https://10.0.0.5/token"],
    ["over plain HTTP", (host: string) => `http://${host}/token`],
  ])("refuses a token realm %s, asking it nothing", async (_, realm) => {
    const remote = await secure("registry.test", (request, response) =>
      challenge(realm(request.headers.host ?? ""))(request, response),
    );
    const result = await resolveWith(publicLoopback().access, `${remote.host}/acme/app:1`);
    expect(failureOf(result)).toBe("registry-refused");
    expect(remote.seen.map((each) => each.url)).toEqual(["/v2/acme/app/manifests/1"]);
  });

  it.each([
    [
      "redirect",
      (mirror: string): Handler =>
        (_request, response) => {
          response.writeHead(307, { location: `${mirror}/v2/acme/app/manifests/1` });
          response.end();
        },
    ],
    ["token realm", (mirror: string) => challenge(`${mirror}/token`)],
  ])(
    "refuses a registry's %s to an operator's mirror, asking the mirror nothing",
    async (_, at) => {
      const mirror = await registry(serve(index("1")));
      const remote = await secure("registry.test", at(mirror.origin));
      const result = await resolveWith(
        { ...publicLoopback().access, mirrors: [new URL(mirror.origin)] },
        `${remote.host}/acme/app:1`,
      );
      expect(failureOf(result)).toBe("registry-refused");
      expect(mirror.seen).toEqual([]);
    },
  );

  it("refuses a name that resolves to a public address and a private one, dialing neither", async () => {
    const remote = await secure("registry.test", serve(index("1")));
    const names = publicLoopback({ "registry.test": ["127.0.0.1", "10.0.0.5"] });
    const result = await resolveWith(names.access, `${remote.host}/acme/app:1`);
    expect(failureOf(result)).toBe("registry-refused");
    expect(remote.seen).toEqual([]);
  });
});
