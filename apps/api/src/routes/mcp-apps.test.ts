import { AgentItemId } from "@mend/domain";
import { McpAppError, McpAppRef, McpAppSnapshot } from "@mend/domain/workbench";
import type { McpAppConnections } from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, CAROL_SESSION_IN_SHARED_A } from "../../test/support/tenancy-harness.ts";

const shared = ids("shared-a");
const itemId = AgentItemId.make("app-item");
const app = new McpAppSnapshot({
  itemId,
  sessionId: shared.session,
  processId: shared.process,
  server: "charts",
  tool: "show",
  resourceUri: "ui://charts/main",
  html: "<p>Chart</p>",
  capturedAt: new Date("2026-11-07T00:00:00Z"),
});
const route = `/api/sessions/${shared.session}/mcp-apps/${itemId}`;

const fixture = async () => {
  const calls: Array<unknown> = [];
  const contexts = new Map<string, string>();
  let live = true;
  const connection: Effect.Success<ReturnType<McpAppConnections["Service"]["forProcess"]>> = {
    listTools: (server) =>
      Effect.sync(() => {
        calls.push({ listTools: server });
        return [
          {
            name: "refresh",
            annotations: { readOnlyHint: true, title: "Refresh" },
            _meta: { ui: { visibility: ["app"] } },
          },
          { name: "hidden", _meta: { ui: { visibility: ["model"] } } },
        ];
      }),
    callTool: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return {
          content: [{ type: "text", text: "refreshed" }],
          structuredContent: { count: 3 },
          _meta: { revision: 2 },
        };
      }),
    readResource: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { contents: [{ uri: input.uri, text: "fresh data" }] };
      }),
  };
  const api = await createTenancyApi(
    {},
    {
      implement: {
        mcpAppsRepo: {
          descendsFrom: (sessionId, ancestorId) =>
            Effect.succeed(
              ancestorId === shared.session &&
                (sessionId === shared.session || sessionId === CAROL_SESSION_IN_SHARED_A),
            ),
          byItem: (id) => Effect.succeed(id === itemId ? app : null),
          listForSession: () => Effect.succeed([new McpAppRef(app)]),
          setContext: (sessionId, id, text) =>
            Effect.sync(() => {
              const key = `${sessionId}:${id}`;
              if (text.trim() === "") contexts.delete(key);
              else contexts.set(key, text);
            }),
        },
        mcpAppConnections: {
          forProcess: (processId, accountId) =>
            Effect.suspend(() => {
              calls.push({ processId, accountId });
              return live
                ? Effect.succeed(connection)
                : Effect.fail(new McpAppError({ reason: "session-stopped" }));
            }),
        },
      },
    },
  );
  return {
    api,
    calls,
    contexts,
    stop: () => {
      live = false;
    },
  };
};

describe("MCP app HTTP callbacks", () => {
  it("lets session viewers read snapshots and refuses callbacks before touching another person's login", async () => {
    const { api, calls } = await fixture();
    try {
      for (const user of ["alice", "carol"] as const) {
        const snapshot = await api.request(user, "GET", route);
        expect(snapshot.status).toBe(200);
        expect(await snapshot.json()).toMatchObject({ html: app.html, server: "charts" });
      }
      const refs = await api.request("carol", "GET", `/api/sessions/${shared.session}/mcp-apps`);
      expect(refs.status).toBe(200);
      expect(await refs.json()).toEqual([
        {
          itemId,
          sessionId: shared.session,
          processId: shared.process,
          server: "charts",
          tool: "show",
          resourceUri: "ui://charts/main",
          capturedAt: app.capturedAt.toISOString(),
        },
      ]);
      for (const [method, suffix, body] of [
        ["GET", "/tool-info?name=refresh", undefined],
        ["POST", "/call-tool", { name: "refresh", arguments: {} }],
        ["GET", "/resource?uri=ui%3A%2F%2Fcharts%2Fdata", undefined],
        ["PUT", "/context", { content: [{ type: "text", text: "selected" }] }],
      ] as const) {
        expect((await api.request("carol", method, `${route}${suffix}`, body)).status).toBe(403);
        expect((await api.request("bob", method, `${route}${suffix}`, body)).status).toBe(404);
      }
      expect((await api.request("bob", "GET", route)).status).toBe(404);
      expect((await api.request(null, "GET", route)).status).toBe(401);
      expect(calls).toEqual([]);
    } finally {
      await api.dispose();
    }
  });

  it("binds every callback to the stored server and preserves tool visibility and metadata", async () => {
    const { api, calls } = await fixture();
    try {
      const info = await api.request("alice", "GET", `${route}/tool-info?name=refresh`);
      expect(info.status).toBe(200);
      expect(await info.json()).toMatchObject({
        callable: true,
        readOnly: true,
        title: "Refresh",
        tool: { name: "refresh" },
      });
      const result = await api.request("alice", "POST", `${route}/call-tool`, {
        name: "refresh",
        arguments: { count: 3 },
        server: "some-other-server",
      });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        structuredContent: { count: 3 },
        _meta: { revision: 2 },
      });
      expect(calls).toContainEqual({ server: "charts", tool: "refresh", arguments: { count: 3 } });
      const hidden = await api.request("alice", "POST", `${route}/call-tool`, {
        name: "hidden",
        arguments: {},
      });
      expect(hidden.status).toBe(409);
      expect(await hidden.json()).toEqual({ _tag: "McpAppError", reason: "tool-not-callable" });
      expect(
        calls.some(
          (call) =>
            typeof call === "object" && call !== null && "tool" in call && call.tool === "hidden",
        ),
      ).toBe(false);
      const resource = await api.request(
        "alice",
        "GET",
        `${route}/resource?uri=ui%3A%2F%2Fcharts%2Fdata`,
      );
      expect(resource.status).toBe(200);
      expect(calls).toContainEqual({ server: "charts", uri: "ui://charts/data" });
      const otherSession = route.replace(shared.session, ids("private-alice").session);
      const before = calls.length;
      expect(
        (await api.request("alice", "GET", `${otherSession}/tool-info?name=refresh`)).status,
      ).toBe(409);
      expect(calls).toHaveLength(before);
    } finally {
      await api.dispose();
    }
  });

  it("keeps context on the displayed fork, authorizing its controller and refusing unrelated conversations", async () => {
    const { api, contexts } = await fixture();
    try {
      const displayed = CAROL_SESSION_IN_SHARED_A;
      const content = [{ type: "text", text: "fork selection" }];
      // Carol can see Alice's original, and controls her own displayed fork.
      expect(
        (
          await api.request("carol", "PUT", `${route}/context`, {
            conversationSessionId: displayed,
            content,
          })
        ).status,
      ).toBe(200);
      expect(contexts.get(`${displayed}:${itemId}`)).toBe("fork selection");
      expect(contexts.has(`${shared.session}:${itemId}`)).toBe(false);
      expect(
        (
          await api.request("alice", "PUT", `${route}/context`, {
            conversationSessionId: displayed,
            content,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api.request("alice", "PUT", `${route}/context`, {
            conversationSessionId: ids("private-alice").session,
            content,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await api.request("bob", "PUT", `${route}/context`, {
            conversationSessionId: ids("shared-b").session,
            content,
          })
        ).status,
      ).toBe(404);
      expect(contexts.size).toBe(1);
    } finally {
      await api.dispose();
    }
  });

  it("replaces and clears context while stopped, rejecting unsupported blocks and oversized UTF-8", async () => {
    const { api, contexts, stop } = await fixture();
    try {
      stop();
      expect((await api.request("alice", "GET", route)).status).toBe(200);
      const stopped = await api.request("alice", "GET", `${route}/tool-info?name=refresh`);
      expect(stopped.status).toBe(409);
      expect(await stopped.json()).toMatchObject({ reason: "session-stopped" });
      expect(
        (
          await api.request("alice", "PUT", `${route}/context`, {
            content: [{ type: "text", text: "one" }],
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await api.request("alice", "PUT", `${route}/context`, {
            content: [{ type: "text", text: "two" }],
            structuredContent: { selected: 2 },
          })
        ).status,
      ).toBe(200);
      expect([...contexts.values()]).toEqual(['two\n{"selected":2}']);
      expect(
        (
          await api.request("alice", "PUT", `${route}/context`, {
            content: [{ type: "image", data: "no" }],
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await api.request("alice", "PUT", `${route}/context`, {
            content: [{ type: "text", text: "é".repeat(8193) }],
          })
        ).status,
      ).toBe(409);
      expect([...contexts.values()]).toEqual(['two\n{"selected":2}']);
      expect((await api.request("alice", "PUT", `${route}/context`, {})).status).toBe(200);
      expect(contexts.size).toBe(0);
    } finally {
      await api.dispose();
    }
  });
});
