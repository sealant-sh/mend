import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import type { WorktreeRemovalRefusal } from "@mend/domain/workbench";
import { QueryClient } from "@tanstack/react-query";
import { serialize } from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeWorktree, type WorktreeDto } from "#/lib/api";
import { makeTrpcProxy } from "#/lib/trpc";
import { worktreeMenu } from "#/lib/workbench-menus";

/**
 * The refusal → remove-anyway flow against the real tRPC client: the menu's removal never carries
 * force, a StoreFailure reaches the page as the server's words, and only the page's second step
 * sends `force: true`.
 */

const WORDS =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

const worktree: WorktreeDto = {
  id: WorktreeId.make("worktree-1"),
  projectId: ProjectId.make("project-1"),
  name: "fix-login",
  directory: "/store/worktrees/fix-login",
  branch: "mend/fix-login",
  baseRef: "main",
  baseSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const clients: QueryClient[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients) client.clear();
  clients.length = 0;
});

/** An inert endpoint: every `worktrees.remove` without force is refused in the server's words. */
const fixture = () => {
  const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
  const queryClient = new QueryClient();
  clients.push(queryClient);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.split("/trpc/")[1];
    if (path !== "worktrees.remove") throw new Error(`Unexpected procedure: ${path ?? "?"}`);
    const body: unknown = await request.json();
    requests.push({ path, body });
    const forced =
      typeof body === "object" &&
      body !== null &&
      "0" in body &&
      typeof body[0] === "object" &&
      body[0] !== null &&
      "json" in body[0] &&
      typeof body[0].json === "object" &&
      body[0].json !== null &&
      "force" in body[0].json &&
      body[0].json.force === true;
    if (!forced) {
      return Response.json([
        {
          error: serialize({
            message: WORDS,
            code: -32022,
            data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422, tag: "StoreFailure" },
          }),
        },
      ]);
    }
    return Response.json([{ result: { data: serialize({ removed: true, leftover: null }) } }]);
  });
  return {
    requests,
    navigate: async (): Promise<void> => undefined,
    context: { queryClient, trpc: makeTrpcProxy(queryClient) },
  };
};

const removeEntry = (menu: ReturnType<typeof worktreeMenu>) => {
  const entry = menu.entries.find(
    (candidate) => candidate !== "separator" && candidate.label === "Remove worktree…",
  );
  if (entry === undefined || entry === "separator") throw new Error("Remove entry missing");
  return entry;
};

describe("worktree removal from the menu", () => {
  it("asks without force, and hands the page the server's words when refused", async () => {
    const f = fixture();
    const refusals: WorktreeRemovalRefusal[] = [];
    const entry = removeEntry(
      worktreeMenu(worktree, [], undefined, f.navigate, f.context, (refusal) =>
        refusals.push(refusal),
      ),
    );
    expect(entry.confirm).toContain("Really remove worktree fix-login?");
    entry.onSelect();
    await vi.waitFor(() => expect(refusals).toHaveLength(1));
    expect(f.requests).toEqual([
      { path: "worktrees.remove", body: { 0: { json: { id: worktree.id } } } },
    ]);
    expect(refusals[0]?.words).toBe(WORDS);
    expect(refusals[0]?.forceable).toBe(true);
    expect(refusals[0]?.unlanded?.files).toBe(10);
    expect(refusals[0]?.unlanded?.named.map((file) => file.path)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
    ]);
  });

  it("stays silent toward the page when no one listens, as before", async () => {
    const f = fixture();
    removeEntry(worktreeMenu(worktree, [], undefined, f.navigate, f.context)).onSelect();
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  });

  it("the second step is the same endpoint with force, and only then", async () => {
    const f = fixture();
    const report = await removeWorktree(worktree.id, true);
    expect(report).toEqual({ removed: true, leftover: null });
    expect(f.requests).toEqual([
      { path: "worktrees.remove", body: { 0: { json: { id: worktree.id, force: true } } } },
    ]);
    // A plain removal keeps no force key at all: the server's default is the refusal.
    await expect(removeWorktree(worktree.id)).rejects.toThrow(WORDS);
    expect(f.requests[1]?.body).toEqual({ 0: { json: { id: worktree.id } } });
  });
});
