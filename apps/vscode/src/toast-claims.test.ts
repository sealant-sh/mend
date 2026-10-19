import { mkdtemp, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sessionModel, type WindowModel } from "./session-model.js";
import { Notifier } from "./session-surfaces.js";
import { window } from "./test-vscode.js";
import { TOAST_CLAIM_TTL_MS, ToastClaims } from "./toast-claims.js";
import type { Session } from "./types.js";

vi.mock("vscode", () => import("./test-vscode.js"));

const directory = () => mkdtemp(join(tmpdir(), "mend-toasts-"));

describe("ToastClaims", () => {
  it("gives one key to one window, however many claim it at once", async () => {
    const shared = await directory();
    const windows = Array.from({ length: 8 }, () => new ToastClaims(shared));
    const claimed = await Promise.all(windows.map((one) => one.claim("s:wait:r1")));
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(await windows[0]?.claim("s:wait:r2")).toBe(true);
  });

  it("forgets claims past a day", async () => {
    const shared = await directory();
    await new ToastClaims(shared).claim("old");
    const stale = (Date.now() - TOAST_CLAIM_TTL_MS - 60_000) / 1000;
    await utimes(join(shared, "old"), stale, stale);
    expect(await new ToastClaims(shared).claim("new")).toBe(true);
    expect((await readdir(shared)).toSorted()).toEqual(["new"]);
  });
});

const waiting: Session = {
  id: "s",
  projectId: "p1",
  harness: "claude",
  model: null,
  label: "add-rate-limit",
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "waiting",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-19T08:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
};

describe("two windows, each focused when its own read lands (B4)", () => {
  it("toasts one wait once", async () => {
    const read = (session: Session): WindowModel =>
      sessionModel({
        projects: [],
        details: [
          {
            project: {
              id: "p1",
              name: "newsroom-api",
              originUrl: null,
              storePath: "/store",
              defaultBranch: "main",
            },
            sessions: [session],
          },
        ],
        viewer: "dana",
        members: [],
        waits: new Map([
          [
            "s",
            {
              key: "r1",
              words: "run pnpm db:migrate?",
              since: waiting.createdAt,
              via: "conversation",
            },
          ],
        ]),
        landings: new Map(),
        lastSeen: { baseline: waiting.createdAt, sessions: {} },
        connection: { state: "connecting" },
        window: { kind: "local" },
        now: new Date(),
      });
    const shared = await directory();
    const store = { showing: () => new Set<string>(), model: () => null, error: () => null };
    const change = { prev: read({ ...waiting, status: "running" }), next: read(waiting) };
    window.showInformationMessage.mockClear();
    for (const notifier of [
      new Notifier(store, new ToastClaims(shared)),
      new Notifier(store, new ToastClaims(shared)),
    ])
      notifier.changed(change);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
  });
});
