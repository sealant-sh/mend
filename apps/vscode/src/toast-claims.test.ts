import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { sessionModel, type WindowModel } from "./session-model.js";
import { Notifier } from "./session-surfaces.js";
import { fake, window } from "./test-vscode.js";
import { TOAST_CLAIM_TTL_MS, ToastClaims } from "./toast-claims.js";
import type { Session } from "./types.js";

vi.mock("vscode", () => import("./test-vscode.js"));

const directory = () => mkdtemp(join(tmpdir(), "mend-toasts-"));
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("ToastClaims", () => {
  it("gives one key to one window, however many claim it at once", async () => {
    const shared = await directory();
    const at = iso(Date.now());
    const windows = Array.from({ length: 8 }, () => new ToastClaims(shared));
    const claimed = await Promise.all(windows.map((one) => one.claim("s:wait:r1", at)));
    expect(claimed.filter(Boolean)).toHaveLength(1);
    expect(await windows[0]?.claim("s:wait:r2", at)).toBe(true);
  });

  it("lets exactly one window claim a wait while other windows sweep expired claims", async () => {
    const shared = await directory();
    // Every file is new on disk but this clock is a week and a day ahead, so whatever a sweep
    // judged by a file's age, not its name, would remove the fresh claims mid-race.
    const clock = Date.now() + 8 * DAY;
    const won = new Map<string, number>();
    for (let round = 0; round < 25; round += 1) {
      const earlier = new ToastClaims(shared, () => clock - 8 * DAY);
      await earlier.claim(`old:${round}`, iso(clock - 8 * DAY - 1_000));
      // This round's wait, and the last round's again: a window that saw it late claims it now.
      const keys = [`s:wait:${round}`, `s:wait:${Math.max(0, round - 1)}`];
      const claimants = Array.from({ length: 8 }, (_, index) => ({
        key: keys[index % 2] ?? "",
        claims: new ToastClaims(shared, () => clock),
      }));
      const claimed = await Promise.all(
        claimants.map(async ({ key, claims }) => ({
          key,
          won: await claims.claim(key, iso(clock - 1_000)),
        })),
      );
      for (const { key, won: one } of claimed) if (one) won.set(key, (won.get(key) ?? 0) + 1);
    }
    expect([...won.values()]).toEqual(Array.from({ length: 25 }, () => 1));
    const left = await readdir(shared);
    expect(left.filter((name) => name.includes("old"))).toEqual([]);
    expect(left).toHaveLength(25);
  });

  it("claims no wait past the expiry, so a claim the sweep removed is never made again", async () => {
    const shared = await directory();
    const now = Date.now();
    const claims = new ToastClaims(shared, () => now);
    expect(await claims.claim("s:wait:old", iso(now - TOAST_CLAIM_TTL_MS - 1))).toBe(false);
    expect(await claims.claim("s:wait:when", "not a time")).toBe(false);
    expect(await readdir(shared)).toEqual([]);
  });

  it("does not trust a claim it made as the wait expired: a sweep may have just freed the name", async () => {
    const shared = await directory();
    const began = Date.now() - TOAST_CLAIM_TTL_MS + 1;
    const times = [began + TOAST_CLAIM_TTL_MS - 1];
    const claims = new ToastClaims(shared, () => times.shift() ?? began + TOAST_CLAIM_TTL_MS);
    expect(await claims.claim("s:wait:r1", iso(began))).toBe(false);
  });

  it("gives a released key to the next window that claims it", async () => {
    const shared = await directory();
    const at = iso(Date.now());
    const first = new ToastClaims(shared);
    expect(await first.claim("s:wait:r1", at)).toBe(true);
    expect(await new ToastClaims(shared).claim("s:wait:r1", at)).toBe(false);
    await first.release("s:wait:r1", at);
    expect(await new ToastClaims(shared).claim("s:wait:r1", at)).toBe(true);
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
          since: new Date().toISOString(),
          via: "conversation",
        },
      ],
    ]),
    landings: new Map(),
    refusals: new Map(),
    lastSeen: { baseline: waiting.createdAt, sessions: {} },
    connection: { state: "connecting" },
    window: { kind: "local" },
    now: new Date(),
  });

const waitStarts = () => ({ prev: read({ ...waiting, status: "running" }), next: read(waiting) });

/** A window's claims whose answer is held until the test lets it through. */
const heldClaims = (claims: ToastClaims) => {
  const gate = Promise.withResolvers<void>();
  const release = vi.fn((key: string, at: string) => claims.release(key, at));
  return {
    claims: {
      claim: async (key: string, at: string) => {
        const won = await claims.claim(key, at);
        await gate.promise;
        return won;
      },
      release,
    },
    release,
    letGo: () => gate.resolve(),
  };
};

const launches = { has: () => false, relaunch: async () => {} };

describe("two windows, each focused when its own read lands (B4)", () => {
  it("toasts one wait once", async () => {
    const shared = await directory();
    const store = {
      showing: () => new Set<string>(),
      model: () => read(waiting),
      error: () => null,
    };
    const change = waitStarts();
    window.showInformationMessage.mockClear();
    for (const notifier of [
      new Notifier(store, new ToastClaims(shared), launches),
      new Notifier(store, new ToastClaims(shared), launches),
    ])
      notifier.changed(change);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
  });
});

describe("a wait the store saw end", () => {
  it("removes its claim", async () => {
    fake.reset();
    const shared = await directory();
    const store = {
      showing: () => new Set<string>(),
      model: () => read(waiting),
      error: () => null,
    };
    const notifier = new Notifier(store, new ToastClaims(shared), launches);
    const { prev, next } = waitStarts();
    notifier.changed({ prev, next });
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    notifier.changed({ prev: next, next: prev });
    await vi.waitFor(async () => expect(await readdir(shared)).toEqual([]));
  });
});

describe("what changed while a window claimed its toast", () => {
  it("shows nothing once she looked away, and gives the claim to a window she is in", async () => {
    fake.reset();
    const shared = await directory();
    const store = {
      showing: () => new Set<string>(),
      model: () => read(waiting),
      error: () => null,
    };
    const change = waitStarts();
    window.showInformationMessage.mockClear();
    const here = heldClaims(new ToastClaims(shared));
    new Notifier(store, here.claims, launches).changed(change);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    fake.focus(false);
    here.letGo();
    await vi.waitFor(() => expect(here.release).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await readdir(shared)).toEqual([]));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    fake.focus(true);
    new Notifier(store, new ToastClaims(shared), launches).changed(change);
    await vi.waitFor(() => expect(window.showInformationMessage).toHaveBeenCalledTimes(1));
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("add-rate-limit is waiting"),
      "Answer",
    );
  });

  it("shows nothing for a wait that ended, or a session she opened, meanwhile", async () => {
    fake.reset();
    window.showInformationMessage.mockClear();
    let model = read(waiting);
    let showing = new Set<string>();
    const store = { showing: () => showing, model: () => model, error: () => null };
    const ended = heldClaims(new ToastClaims(await directory()));
    new Notifier(store, ended.claims, launches).changed(waitStarts());
    model = read({ ...waiting, status: "running" });
    ended.letGo();
    await vi.waitFor(() => expect(ended.release).toHaveBeenCalledTimes(1));
    model = read(waiting);
    const opened = heldClaims(new ToastClaims(await directory()));
    new Notifier(store, opened.claims, launches).changed(waitStarts());
    showing = new Set(["s"]);
    opened.letGo();
    await vi.waitFor(() => expect(opened.release).toHaveBeenCalledTimes(1));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });
});
