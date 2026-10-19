import { describe, expect, it, vi } from "vitest";

import type { Project, Session, SessionDetail } from "../types.js";
import { ReviewClient } from "./review-client.js";
import { ReviewMemory } from "./review-memory.js";
import { ReviewStore } from "./review-store.js";

vi.mock("vscode", () => import("../test-vscode.js"));

const project: Project = {
  id: "p1",
  name: "api",
  originUrl: null,
  storePath: "/store/api",
  defaultBranch: "main",
};

const session: Session = {
  id: "s1",
  projectId: "p1",
  harness: "claude",
  model: null,
  label: null,
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
};

const noChange: SessionDetail = { session, processes: [], currentAgent: null, changeId: null };

const storeReading = (detail: Promise<SessionDetail>): ReviewStore => {
  const kept = new Map<string, unknown>();
  return new ReviewStore(
    {
      sessionDetail: async () => detail,
      connection: async () => ({ url: "http://mend.test", token: "t" }),
    },
    new ReviewClient(async () => ({ url: "http://mend.test", token: "t" })),
    new ReviewMemory({
      get: (key) => kept.get(key),
      update: async (key, value) => {
        kept.set(key, value);
      },
    }),
  );
};

describe("ReviewStore.forget", () => {
  it("drops what the section showed", async () => {
    const store = storeReading(Promise.resolve(noChange));
    store.follow(project, session);
    await vi.waitFor(() => expect(store.state().kind).toBe("empty"));
    store.forget();
    expect(store.state()).toEqual({ kind: "idle" });
  });

  it("keeps a read that lands after it from drawing the session again", async () => {
    const held = Promise.withResolvers<SessionDetail>();
    const store = storeReading(held.promise);
    store.follow(project, session);
    expect(store.state().kind).toBe("reading");
    store.forget();
    held.resolve(noChange);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state()).toEqual({ kind: "idle" });
  });

  it("lets the same session be followed again afterwards", async () => {
    const store = storeReading(Promise.resolve(noChange));
    store.follow(project, session);
    await vi.waitFor(() => expect(store.state().kind).toBe("empty"));
    store.forget();
    store.follow(project, session);
    expect(store.state().kind).toBe("reading");
  });
});
