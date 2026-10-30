import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { deserialize, serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "https://mend.example";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const projectId = "p_shop";
const proposalId = "rprop_1";
const digest = "a".repeat(64);
let answer: Response;

beforeEach(() => {
  answer = Response.json({});
  vi.stubGlobal("fetch", async () => answer.clone());
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

const approval = {
  projectId,
  timeZone: "Europe/Athens",
  request: { source: { kind: "settings", id: "rdef_1", digest }, worktreeId: null },
};

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
    expect(await mutate("resources.approve", approval)).toEqual({
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
    expect(await mutate("resources.approve", approval)).toMatchObject({
      value: { ok: false, kind: "stale" },
    });
    for (const [tag, status] of [
      ["ResourceRegistryUnavailable", 503],
      ["ResourceManifestUnverifiable", 502],
    ] as const) {
      answer = Response.json({ _tag: tag, message: `@db · ${tag}` }, { status });
      expect(await mutate("resources.approve", approval)).toEqual({
        status: 200,
        value: { ok: false, kind: "unanswered", message: `@db · ${tag}` },
      });
    }
  });

  it("says a proposal another removal took is gone, and leaves a project the reader cannot see an error", async () => {
    answer = Response.json({ _tag: "NotFound", id: proposalId }, { status: 404 });
    expect(await mutate("resources.withdraw", { projectId, proposalId })).toEqual({
      status: 200,
      value: { ok: false, kind: "gone" },
    });
    answer = Response.json({ _tag: "NotFound", id: projectId }, { status: 404 });
    expect(await mutate("resources.withdraw", { projectId, proposalId })).toEqual({
      status: 404,
    });
  });

  it("sends each kind of proposal as its own member", async () => {
    answer = Response.json(
      { _tag: "ResourceRejected", name: "db", refusals: [], message: "@db" },
      { status: 422 },
    );
    expect(
      await mutate("resources.propose", {
        projectId,
        timeZone: "Europe/Athens",
        proposal: {
          kind: "preset",
          name: "db",
          preset: "postgres",
          version: "17",
          scope: "project",
        },
      }),
    ).toMatchObject({ value: { ok: false, kind: "rejected" } });
  });
});
