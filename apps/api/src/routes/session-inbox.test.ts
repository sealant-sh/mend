import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

interface InboxRowWire {
  readonly session: { readonly id: string; readonly projectId: string };
  readonly projectName: string;
  readonly title: string;
  readonly annotation: { readonly changeId: string | null } | null;
  readonly ask: { readonly kind: string; readonly subject: string | null } | null;
}

/**
 * The Sessions inbox's one read (`GET /api/session-inbox`): every session the caller can see,
 * across every project, from Mend's own rows. It never reads per project, never reads a worktree
 * or a workspace and never runs git, so it stays one statement per table however many projects a
 * person has. The world here answers only the batched reads: any other read dies, and the exact
 * list of reads is the contract.
 */
describe("the sessions inbox read", () => {
  let api: TenancyApi | null = null;
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  const open = async () => {
    api = await createTenancyApi({}, { implement: { engine: { launchUnderWay: () => false } } });
    return api;
  };

  it("lists the sessions of every project the caller can see, with why one waits", async () => {
    const world = await open();
    const response = await world.request("alice", "GET", "/api/session-inbox");
    expect(response.status).toBe(200);
    const rows: ReadonlyArray<InboxRowWire> = await response.json();
    // Alice's organization's shared project and her own private one; never carol's private
    // project or another organization's.
    expect(new Set(rows.map((row) => row.session.projectId))).toEqual(
      new Set([ids("private-alice").project, ids("shared-a").project]),
    );
    expect(rows.map((row) => row.session.id)).toContain(ids("shared-a").session);
    const shared = rows.find((row) => row.session.id === ids("shared-a").session);
    expect(shared?.projectName).toBe("shared-a");
    expect(shared?.annotation?.changeId).toBe(ids("shared-a").change);
    // The world's pending request is a command approval titled "Run tests".
    expect(shared?.ask).toEqual({ kind: "command", subject: "Run tests" });
  });

  it("reads each table once for every project together, and nothing per project or from git", async () => {
    const world = await open();
    world.world.calls.length = 0;
    const response = await world.request("alice", "GET", "/api/session-inbox");
    expect(response.status).toBe(200);
    // The engine's launch-in-flight check is the process's own memory, not a read.
    const reads = world.world.calls.filter((call) => call !== "engine.launchUnderWay");
    expect(reads.toSorted()).toEqual(
      [
        "changes.annotationsForProjects",
        "conversation.oldestPendingRequests",
        "processes.listForSessions",
        "services.liveCountsForSessions",
        "sessions.listForProjects",
        "worktrees.listForProjects",
      ].toSorted(),
    );
  });

  it("answers an account that can see no project with no rows and no reads past the projects", async () => {
    const world = await open();
    world.world.calls.length = 0;
    const response = await world.request("dave", "GET", "/api/session-inbox");
    expect([200, 403, 404]).toContain(response.status);
    if (response.status === 200) expect(await response.json()).toEqual([]);
    expect(world.world.calls.filter((call) => call.startsWith("resourceStatus"))).toEqual([]);
  });

  it("reads one row again as the list reads it, and refuses a session the caller cannot see", async () => {
    const world = await open();
    const listed: ReadonlyArray<InboxRowWire> = await (
      await world.request("alice", "GET", "/api/session-inbox")
    ).json();
    world.world.calls.length = 0;
    const response = await world.request(
      "alice",
      "GET",
      `/api/sessions/${ids("shared-a").session}/inbox-row`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      listed.find((row) => row.session.id === ids("shared-a").session),
    );
    expect(world.world.calls.some((call) => call.startsWith("resourceStatus"))).toBe(false);
    const hidden = await world.request(
      "alice",
      "GET",
      `/api/sessions/${ids("private-carol").session}/inbox-row`,
    );
    expect(hidden.status).toBe(404);
  });
});

/**
 * Lists of sessions word resource lines from Mend's rows: reading every worktree's `mend.toml`
 * there restored a capture, or exec'd into a live workspace, once per worktree, which is what made
 * a project's page and the inbox slow. One session's own view still reads the file.
 */
describe("resource lines in lists of sessions", () => {
  let api: TenancyApi | null = null;
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  const fileReads = (calls: ReadonlyArray<string>) =>
    calls.filter((call) => call.startsWith("reads.") || call.startsWith("tables."));

  it("never reads a worktree's files for the project view, the active list or a detail without them", async () => {
    api = await createTenancyApi({}, { implement: { engine: { launchUnderWay: () => false } } });
    const reads: Record<string, ReadonlyArray<string>> = {};
    for (const path of [
      `/api/projects/${ids("shared-a").project}`,
      "/api/sessions",
      `/api/sessions/${ids("shared-a").session}?resources=omit`,
    ]) {
      api.world.calls.length = 0;
      await api.request("alice", "GET", path);
      reads[path] = fileReads(api.world.calls);
    }
    expect(Object.values(reads).flat()).toEqual([]);
  });

  it("reads them for one session's own resource lines", async () => {
    api = await createTenancyApi({}, { implement: { engine: { launchUnderWay: () => false } } });
    api.world.calls.length = 0;
    const response = await api.request(
      "alice",
      "GET",
      `/api/sessions/${ids("shared-a").session}/resource-status`,
    );
    expect(response.status).toBe(200);
    expect(fileReads(api.world.calls)).toEqual(["reads.readFile", "reads.readFile"]);
  });
});
