import { makePublicNetwork, PublicOrigin } from "@mend/network";
import { deserialize, serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrpcHandler } from "../trpc-handler.ts";

const origin = "https://mend.example";
const network = makePublicNetwork(PublicOrigin.make(origin), []);
const projectId = "p_shop";
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

const start = {
  projectId,
  timeZone: "UTC",
  worktreeId: "wt_1",
  name: "db",
  verb: "start",
  level: "project",
  restart: false,
};
describe("resource writes through the web tier", () => {
  it("returns a definition refusal as a typed outcome", async () => {
    answer = Response.json(
      {
        _tag: "ResourceRejected",
        name: "db",
        refusals: [{ key: "ports", message: "names no port" }],
        message: "@db · ports names no port",
      },
      { status: 422 },
    );
    expect(await mutate("resources.control", start)).toEqual({
      status: 200,
      value: {
        ok: false,
        kind: "rejected",
        refusals: [{ key: "ports", message: "names no port" }],
        message: "@db · ports names no port",
      },
    });
  });
  it("preserves needs-restart with affected worktrees", async () => {
    const result = {
      kind: "needs-restart",
      statusLine: "@db · project · definition differs from this worktree",
      hint: "mend resource start db --project --restart",
      worktrees: [{ id: "wt_1", name: "checkout" }],
    };
    answer = Response.json(result);
    expect(await mutate("resources.control", start)).toEqual({
      status: 200,
      value: { ok: true, result },
    });
    expect(asked[0]).toContain("/projects/p_shop/resources/db/start?");
  });
  it("returns a registry failure as unanswered", async () => {
    answer = Response.json(
      { _tag: "ResourceRegistryUnavailable", message: "registry unavailable" },
      { status: 503 },
    );
    expect(await mutate("resources.control", start)).toMatchObject({
      value: { ok: false, kind: "unanswered" },
    });
  });
  it("sends stop and remove by name and level", async () => {
    answer = Response.json({ instance: "stopped", statusLine: "@db · stopped", message: null });
    expect(await mutate("resources.control", { ...start, verb: "stop" })).toMatchObject({
      status: 200,
      value: { ok: true, result: { statusLine: "@db · stopped" } },
    });
    answer = Response.json({ statusLine: "archived" });
    expect(
      await mutate("resources.remove", {
        projectId,
        name: "db",
        level: "project",
        worktreeId: "wt_1",
      }),
    ).toMatchObject({ status: 200, value: { ok: true } });
    expect(asked.at(-1)).toBe("DELETE /api/projects/p_shop/resources/db");
  });
});
