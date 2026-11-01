import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { deserialize, serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "https://mend.example";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const projectId = "p_shop";
const digest = "a".repeat(64);
let answer: Response;
/** Each request the web tier sent the API: its method, path and query. */
let asked: Array<string> = [];

beforeEach(() => {
  answer = Response.json({});
  asked = [];
  vi.stubGlobal("fetch", async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    asked.push(`${method} ${url.pathname}${url.search}`);
    return answer.clone();
  });
});
afterEach(() => vi.unstubAllGlobals());

/** One mutation through the web tier, and what tRPC answered: its value, or its error's code. */
const mutate = async (path: string, input: unknown) => {
  const handle = createTrpcHandler({ network, apiUrl: "http://api.internal" });
  const response = await handle(
    new Request(`${origin}/trpc/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "session=person",
        authorization: "Bearer person",
        origin,
      },
      body: JSON.stringify(serialize(input)),
    }),
  );
  const body: { result?: { data: Parameters<typeof deserialize>[0] }; error?: unknown } =
    await response.json();
  return body.result === undefined
    ? { status: response.status }
    : { status: response.status, value: deserialize(body.result.data) };
};

const preset = {
  projectId,
  timeZone: "Europe/Athens",
  worktreeId: null,
  addition: { kind: "preset", name: "db", preset: "postgres", version: "17", scope: "project" },
};
const removal = { projectId, definitionId: "rdef_1", expectedDigest: digest };

describe("resource writes through the web tier", () => {
  it("returns a refusal by field as a value, each refusal apart", async () => {
    answer = Response.json(
      {
        _tag: "ResourceRejected",
        name: "mail",
        refusals: [
          { key: "ports", message: "names no port, and a resource is reached on one" },
          { key: "image", message: "is not an image reference" },
        ],
        message: "@mail · ports names no port\n@mail · image is not an image reference",
      },
      { status: 422 },
    );
    expect(await mutate("resources.add", preset)).toEqual({
      status: 200,
      value: {
        ok: false,
        kind: "rejected",
        refusals: [
          { key: "ports", message: "names no port, and a resource is reached on one" },
          { key: "image", message: "is not an image reference" },
        ],
        message: "@mail · ports names no port\n@mail · image is not an image reference",
      },
    });
  });

  it("returns a read that changed since as stale, and a registry that did not answer as unanswered", async () => {
    answer = Response.json(
      { _tag: "ResourceStale", message: "@db · the definition changed since you read it" },
      { status: 409 },
    );
    expect(await mutate("resources.remove", removal)).toMatchObject({
      value: { ok: false, kind: "stale" },
    });
    for (const [tag, status] of [
      ["ResourceRegistryUnavailable", 503],
      ["ResourceManifestUnverifiable", 502],
    ] as const) {
      answer = Response.json({ _tag: tag, message: `@db · ${tag}` }, { status });
      expect(await mutate("resources.add", preset)).toEqual({
        status: 200,
        value: { ok: false, kind: "unanswered", message: `@db · ${tag}` },
      });
    }
  });

  it("sends each kind of addition as its own member", async () => {
    answer = Response.json(
      { _tag: "ResourceRejected", name: "mail", refusals: [], message: "@mail" },
      { status: 422 },
    );
    expect(
      await mutate("resources.add", {
        projectId,
        timeZone: "Europe/Athens",
        worktreeId: "wt_1",
        addition: {
          kind: "definition",
          spec: {
            name: "mail",
            scope: "worktree",
            preset: null,
            image: "axllent/mailpit:v1.21",
            command: null,
            ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
            env: {},
            volumes: [],
            ready: { kind: "tcp" },
            exports: {},
          },
        },
      }),
    ).toMatchObject({ value: { ok: false, kind: "rejected" } });
  });

  it("sends a Start or Stop to its route, with the worktree it names, and answers the line", async () => {
    answer = Response.json({
      instance: "stopped",
      statusLine: "@mail · stopped by Tom · its own instance",
    });
    expect(
      await mutate("resources.control", {
        projectId,
        timeZone: "UTC",
        name: "mail",
        worktreeId: "wt_1",
        verb: "stop",
      }),
    ).toEqual({
      status: 200,
      value: {
        ok: true,
        result: { instance: "stopped", statusLine: "@mail · stopped by Tom · its own instance" },
      },
    });
    expect(asked).toEqual([
      "POST /api/projects/p_shop/resources/mail/stop?timeZone=UTC&worktreeId=wt_1",
    ]);
  });
});
