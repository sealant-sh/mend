import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpAppSnapshot } from "@mend/domain/workbench";

/** The slice-1 HTTP contract, with retained documents and live-connection refusals. */
export class FakeMcpApps {
  readonly apps = new Map<string, McpAppSnapshot>();
  readonly parents = new Map<string, string>();
  readonly contexts = new Map<string, unknown>();
  readonly calls: Array<{
    path: string;
    method: string;
    body: unknown;
    authorization: string | undefined;
  }> = [];
  stopped = false;
  status: number | null = null;

  async route(
    request: IncomingMessage,
    response: ServerResponse,
    body: () => Promise<unknown>,
    accepted: boolean,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://fake");
    const match =
      /^\/api\/sessions\/([^/]+)\/mcp-apps(?:\/([^/]+)(?:\/(tool-info|call-tool|resource|context))?)?$/.exec(
        url.pathname,
      );
    if (match === null) return false;
    const sessionId = decodeURIComponent(match[1] ?? "");
    const itemId = decodeURIComponent(match[2] ?? "");
    const action = match[3];
    const payload =
      request.method === "PUT" || request.method === "POST" ? await body() : undefined;
    this.calls.push({
      path: url.pathname + url.search,
      method: request.method ?? "GET",
      body: payload,
      authorization: request.headers.authorization,
    });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(value === undefined ? "" : JSON.stringify(value));
      return true;
    };
    if (!accepted || this.status === 401) return json(401, { _tag: "Unauthorized" });
    if (this.status !== null)
      return json(this.status, { _tag: "McpAppError", reason: "request-failed" });
    if (itemId === "") {
      const ancestors = new Set<string>();
      let current: string | undefined = sessionId;
      while (current !== undefined && !ancestors.has(current)) {
        ancestors.add(current);
        current = this.parents.get(current);
      }
      return json(
        200,
        [...this.apps.values()]
          .filter((app) => ancestors.has(app.sessionId))
          .map(({ html: _html, ...ref }) => ref),
      );
    }
    const app = this.apps.get(itemId);
    if (app?.sessionId !== sessionId)
      return json(409, { _tag: "McpAppError", reason: "not-an-app" });
    if (action === undefined) return json(200, app);
    if (action === "context") {
      this.contexts.set(sessionId + ":" + itemId, payload);
      return json(200, undefined);
    }
    if (this.stopped) return json(409, { _tag: "McpAppError", reason: "session-stopped" });
    if (action === "tool-info")
      return json(200, {
        callable: url.searchParams.get("name") !== "hidden",
        readOnly: true,
        title: "Refresh",
        tool: { name: "refresh" },
      });
    if (action === "call-tool")
      return json(200, {
        content: [{ type: "text", text: "refreshed" }],
        structuredContent: { selected: 3 },
        _meta: { revision: 2 },
      });
    return json(200, { contents: [{ uri: url.searchParams.get("uri"), text: "fresh data" }] });
  }
}

/** Native fork evidence returned by Mend, including an MCP row with no text summary. */
export const mcpForkEvidence = (turnId: string, itemId: string) => {
  const at = new Date().toISOString();
  const selection = { harness: "codex", model: null, effort: null, interactionMode: "default" };
  const operation = {
    id: "mcp-fork-op",
    organizationId: "org-1",
    actorId: "user-1",
    commandId: "mcp-fork",
    intentDigest: "a".repeat(64),
    request: {
      sourceSessionId: "session-1",
      at: { kind: "turn", turnId },
      title: null,
      clientTarget: "displayed-fork",
      clientSource: "session-1",
    },
    intent: {
      kind: "fork",
      projectId: "project-1",
      title: "Chart fork",
      sourceBoundaryId: "mcp-boundary",
      childSessionId: "child-session",
      childWorktreeId: "child-worktree",
    },
    progress: { kind: "awaitingNative" },
    createdAt: at,
    updatedAt: at,
  };
  const boundary = {
    id: "mcp-boundary",
    sessionId: "session-1",
    revision: 0,
    anchor: { kind: "turn", turnId },
    checkpointId: "mcp-checkpoint",
    checkpointSha: "b".repeat(40),
    nativeSeedId: "mcp-seed",
    selection,
    gitHead: "a".repeat(40),
    reviewBase: { sha: "a".repeat(40), ref: "main" },
    repositorySeed: null,
    observedAt: at,
    nativeObservedAt: at,
    record: { runId: "source-run", seq: "20" },
  };
  return {
    operation,
    source: { observations: [{ kind: "ready", boundary }], fork: null },
    child: {
      observations: [],
      fork: {
        operation,
        provenance: {
          childSessionId: "child-session",
          sourceSessionId: "session-1",
          rootSessionId: "session-1",
          sourceBoundaryId: "mcp-boundary",
          sourceTurnId: turnId,
          sourceCheckpointId: "mcp-checkpoint",
          sourceNativeSeedId: "mcp-seed",
          inheritedViewDigest: "b".repeat(64),
          requestedBy: "user-1",
          requestedAt: at,
        },
        history: [
          {
            sourceSessionId: "session-1",
            sourceTurnId: turnId,
            ordinal: 0,
            author: "owner",
            input: "Show a chart",
            status: "completed",
            selection,
            createdAt: at,
            endedAt: at,
            items: [
              {
                id: itemId,
                kind: "tool-call",
                status: "completed",
                title: "charts.show",
                text: null,
              },
            ],
          },
        ],
      },
    },
  };
};
