import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Launches, type RetryAnswer, type RetryOffer } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import {
  sessionModel,
  transitions,
  type LaunchAttempt,
  type WindowModel,
} from "./session-model.js";
import { Notifier } from "./session-surfaces.js";
import { pendingRequest, requestWait } from "./test-requests.js";
import { commands, fake, window } from "./test-vscode.js";
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

const read = (
  session: Session,
  launches: ReadonlyMap<string, LaunchAttempt> = new Map(),
  waits: Parameters<typeof sessionModel>[0]["waits"] = new Map([
    ["s", requestWait(pendingRequest({ createdAt: new Date().toISOString() }))],
  ]),
): WindowModel =>
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
    waits,
    landings: new Map(),
    launches,
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

const launches = {
  offer: async () => ({ kind: "none" as const }),
  relaunch: async () => ({ kind: "held" as const }),
};

const prompts = { chose: vi.fn(async () => {}) };

describe("two windows, each focused when its own read lands (B4)", () => {
  it("toasts one conversation's request once, with its answer on the toast", async () => {
    const shared = await directory();
    const store = {
      showing: () => new Set<string>(),
      model: () => read(waiting),
      error: () => null,
    };
    const change = waitStarts();
    window.showInformationMessage.mockClear();
    for (const notifier of [
      new Notifier(store, new ToastClaims(shared), launches, prompts),
      new Notifier(store, new ToastClaims(shared), launches, prompts),
    ])
      notifier.changed(change);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      "add-rate-limit asks: run pnpm db:migrate?",
      "Allow",
      "Deny",
      "More…",
    );
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
    const notifier = new Notifier(store, new ToastClaims(shared), launches, prompts);
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
    new Notifier(store, here.claims, launches, prompts).changed(change);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    fake.focus(false);
    here.letGo();
    await vi.waitFor(() => expect(here.release).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await readdir(shared)).toEqual([]));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
    fake.focus(true);
    new Notifier(store, new ToastClaims(shared), launches, prompts).changed(change);
    await vi.waitFor(() => expect(window.showInformationMessage).toHaveBeenCalledTimes(1));
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      "add-rate-limit asks: run pnpm db:migrate?",
      "Allow",
      "Deny",
      "More…",
    );
  });

  it("shows nothing for a wait that ended, or a session she opened, meanwhile", async () => {
    fake.reset();
    window.showInformationMessage.mockClear();
    let model = read(waiting);
    let showing = new Set<string>();
    const store = { showing: () => showing, model: () => model, error: () => null };
    const ended = heldClaims(new ToastClaims(await directory()));
    new Notifier(store, ended.claims, launches, prompts).changed(waitStarts());
    model = read({ ...waiting, status: "running" });
    ended.letGo();
    await vi.waitFor(() => expect(ended.release).toHaveBeenCalledTimes(1));
    model = read(waiting);
    const opened = heldClaims(new ToastClaims(await directory()));
    new Notifier(store, opened.claims, launches, prompts).changed(waitStarts());
    showing = new Set(["s"]);
    opened.letGo();
    await vi.waitFor(() => expect(opened.release).toHaveBeenCalledTimes(1));
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });
});

const offering = (offer: RetryOffer, answer: RetryAnswer = { kind: "sent" }) => ({
  offer: vi.fn(async () => offer),
  relaunch: vi.fn(async (_sessionId: string, _settledAt: string | null) => answer),
});

describe("a launch she sent that the server refused (flow 3)", () => {
  const starting: Session = { ...waiting, status: "starting" };
  const refusedAt = iso(Date.now() - 1_000);
  const refusal = {
    line: "launch refused · Claude is not connected",
    at: refusedAt,
    confirmed: true,
  };
  const settledAt = iso(Date.now() - 2_000);
  const refused = () => ({
    prev: read(starting, new Map([["s", { n: 1, after: null, refusal: null }]])),
    next: read(starting, new Map([["s", { n: 1, after: null, refusal }]])),
  });

  it("claims its toast by when it was refused, and offers Retry while its row is on screen", async () => {
    fake.reset();
    const shared = await directory();
    const change = refused();
    const store = { showing: () => new Set(["s"]), model: () => change.next, error: () => null };
    new Notifier(
      store,
      new ToastClaims(shared),
      offering({ kind: "retry", read: starting }),
      prompts,
    ).changed(change);
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledTimes(1));
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      "add-rate-limit · launch refused · Claude is not connected",
      "Retry",
    );
    expect(await readdir(shared)).toEqual([
      `${Date.parse(refusedAt)}.${encodeURIComponent("s:launchRefused:1")}`,
    ]);
  });

  it("names the failure its toast said on Retry, and no failure for a refusal never settled", async () => {
    fake.reset();
    const failed: Session = { ...waiting, status: "failed", settledAt };
    const sent = new Map([["s", { n: 1, after: null, refusal: null }]]);
    const settledChange = { prev: read(starting, sent), next: read(failed, sent) };
    const settled = offering({ kind: "retry", read: failed });
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    new Notifier(
      { showing: () => new Set<string>(), model: () => settledChange.next, error: () => null },
      new ToastClaims(await directory()),
      settled,
      prompts,
    ).changed(settledChange);
    await vi.waitFor(() => expect(settled.relaunch).toHaveBeenCalledWith("s", settledAt));
    const refusedChange = refused();
    const unsettled = offering({ kind: "retry", read: starting });
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    new Notifier(
      { showing: () => new Set<string>(), model: () => refusedChange.next, error: () => null },
      new ToastClaims(await directory()),
      unsettled,
      prompts,
    ).changed(refusedChange);
    await vi.waitFor(() => expect(unsettled.relaunch).toHaveBeenCalledWith("s", null));
  });

  it("says how the session reads now when Mend says it moved on, and sends nothing more", async () => {
    fake.reset();
    const failed: Session = { ...waiting, status: "failed", settledAt };
    const sent = new Map([["s", { n: 1, after: null, refusal: null }]]);
    const change = { prev: read(starting, sent), next: read(failed, sent) };
    const running: Session = { ...waiting, status: "running", summary: "reading src/auth" };
    const movedOn = offering(
      { kind: "retry", read: failed },
      {
        kind: "movedOn",
        read: running,
        said: "the session moved on · it reads running · nothing launched",
      },
    );
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    new Notifier(
      { showing: () => new Set<string>(), model: () => change.next, error: () => null },
      new ToastClaims(await directory()),
      movedOn,
      prompts,
    ).changed(change);
    await vi.waitFor(() =>
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "add-rate-limit moved on · running · reading src/auth · nothing launched",
      ),
    );
    expect(movedOn.relaunch).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry of its own for a failure after Mend refused its Retry: another client launched that", async () => {
    const later = iso(Date.now() - 500);
    const failedAgain: Session = {
      ...waiting,
      status: "failed",
      settledAt: later,
      summary: "exited with code 143",
    };
    let now: Session = { ...waiting, status: "failed", settledAt };
    const attempts = new Map<string, LaunchAttempt>();
    const sender = new Launches(
      {
        launchSession: async (_, body) => {
          if (body.expected !== undefined)
            throw new MendApiError(
              "the session moved on · it reads failed · nothing launched",
              409,
              "SessionMovedOn",
            );
        },
        sessionDetail: async () => ({ session: now, processes: [], currentAgent: null }),
      },
      {
        attempted: (sessionId, attempt) => attempts.set(sessionId, attempt),
        forget: (sessionId) => attempts.delete(sessionId),
      },
    );
    await sender.launch("s", { mode: "pty", prompt: "add rate limiting" });
    // The store drops a launch once the session runs: another client launched it here.
    attempts.delete("s");
    const running = read({ ...waiting, status: "running" }, new Map(attempts));
    now = failedAgain;
    expect(await sender.relaunch("s", settledAt)).toMatchObject({ kind: "movedOn" });
    const notified = transitions(running, read(failedAgain, new Map(attempts)), {
      focused: true,
      showing: new Set(),
      raised: new Set(),
    });
    expect(notified.map((one) => one.kind)).toEqual(["finished"]);
  });

  it("offers Open, not a second launch, when Mend says an agent is already running", async () => {
    fake.reset();
    const change = refused();
    const running: Session = { ...waiting, status: "running", summary: "reading src/auth" };
    const agentLive = offering(
      { kind: "retry", read: starting },
      { kind: "agentLive", read: running, said: "the session's agent is live · nothing restarted" },
    );
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    window.showInformationMessage.mockResolvedValueOnce("Open");
    new Notifier(
      { showing: () => new Set<string>(), model: () => change.next, error: () => null },
      new ToastClaims(await directory()),
      agentLive,
      prompts,
    ).changed(change);
    await vi.waitFor(() => expect(commands.executeCommand).toHaveBeenCalledWith("mend.open", "s"));
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      "add-rate-limit · an agent is already running · nothing launched",
      "Open",
    );
    expect(agentLive.relaunch).toHaveBeenCalledTimes(1);
  });

  it("says an agent already ran in the session, as information with Open, when Mend refuses Retry over an agent that ran", async () => {
    fake.reset();
    const change = refused();
    const idle: Session = { ...waiting, status: "idle" };
    const alreadyRan = offering(
      { kind: "retry", read: starting },
      {
        kind: "alreadyRan",
        read: idle,
        said: "an agent already ran in this session · it reads idle · nothing launched again",
      },
    );
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    window.showInformationMessage.mockResolvedValueOnce("Open");
    new Notifier(
      { showing: () => new Set<string>(), model: () => change.next, error: () => null },
      new ToastClaims(await directory()),
      alreadyRan,
      prompts,
    ).changed(change);
    await vi.waitFor(() => expect(commands.executeCommand).toHaveBeenCalledWith("mend.open", "s"));
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      "add-rate-limit · an agent already ran in this session · nothing launched again",
      "Open",
    );
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(alreadyRan.relaunch).toHaveBeenCalledTimes(1);
  });

  it("shows a launch Mend never answered with no Retry, from a server that does not say it refuses one once an agent ran", async () => {
    fake.reset();
    const idle: Session = { ...waiting, status: "idle" };
    const attempts = new Map<string, LaunchAttempt>();
    const sender = new Launches(
      {
        launchSession: async () => {
          throw new MendApiError(
            "Mend could not do that. Try again; the server log has the detail.",
            504,
          );
        },
        sessionDetail: async () => ({
          session: idle,
          processes: [],
          currentAgent: null,
          launchAdmission: null,
        }),
      },
      {
        attempted: (sessionId, attempt) => attempts.set(sessionId, attempt),
        forget: (sessionId) => attempts.delete(sessionId),
      },
    );
    await sender.launch("s", { mode: "pty", prompt: "add rate limiting" });
    const change = {
      prev: read(idle, new Map([["s", { n: 1, after: null, refusal: null }]]), new Map()),
      next: read(idle, attempts, new Map()),
    };
    new Notifier(
      { showing: () => new Set<string>(), model: () => change.next, error: () => null },
      new ToastClaims(await directory()),
      sender,
      prompts,
    ).changed(change);
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledTimes(1));
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      "add-rate-limit · launch not confirmed · Mend did not answer · check the session",
    );
  });

  it("gives its claim back and shows nothing when the read before Retry says it moved", async () => {
    fake.reset();
    const shared = await directory();
    const change = refused();
    const store = { showing: () => new Set<string>(), model: () => change.next, error: () => null };
    const moved = offering({ kind: "moved", read: starting });
    new Notifier(store, new ToastClaims(shared), moved, prompts).changed(change);
    await vi.waitFor(() => expect(moved.offer).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await readdir(shared)).toEqual([]));
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("still offers Retry, once, for a failure read before its launch was answered", async () => {
    fake.reset();
    const shared = await directory();
    const failed: Session = { ...waiting, status: "failed", settledAt };
    const answer = Promise.withResolvers<void>();
    const attempts = new Map<string, LaunchAttempt>();
    const sender = new Launches(
      {
        launchSession: async () => {
          await answer.promise;
          throw new MendApiError("Connect Claude to start a session here.", 422, "StoreFailure");
        },
        sessionDetail: async () => ({ session: failed, processes: [], currentAgent: null }),
      },
      {
        attempted: (sessionId, attempt) => attempts.set(sessionId, attempt),
        forget: (sessionId) => attempts.delete(sessionId),
      },
    );
    const sent = sender.launch("s", { mode: "pty", prompt: "add rate limiting" });
    const early = {
      prev: read(starting, new Map(attempts)),
      next: read(failed, new Map(attempts)),
    };
    const store = { showing: () => new Set<string>(), model: () => early.next, error: () => null };
    const notifier = new Notifier(store, new ToastClaims(shared), sender, prompts);
    notifier.changed(early);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    answer.resolve();
    await sent;
    notifier.changed({ prev: early.next, next: read(failed, new Map(attempts)) });
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.any(String), "Retry");
    expect(await readdir(shared)).toEqual([
      `${Date.parse(settledAt)}.${encodeURIComponent(`s:launchFailed:${settledAt}`)}`,
    ]);
  });

  it("toasts one failure the server settled once across two windows, the launching one included", async () => {
    fake.reset();
    const shared = await directory();
    const failed: Session = { ...waiting, status: "failed", settledAt };
    const sent = new Map([["s", { n: 1, after: null, refusal: null }]]);
    const launching = { prev: read(starting, sent), next: read(failed, sent) };
    const other = { prev: read(starting), next: read(failed) };
    const here = new Notifier(
      { showing: () => new Set<string>(), model: () => launching.next, error: () => null },
      new ToastClaims(shared),
      offering({ kind: "retry", read: failed }),
      prompts,
    );
    const there = new Notifier(
      { showing: () => new Set<string>(), model: () => other.next, error: () => null },
      new ToastClaims(shared),
      offering({ kind: "none" }),
      prompts,
    );
    here.changed(launching);
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledTimes(1));
    there.changed(other);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(await readdir(shared)).toHaveLength(1);
  });

  it("shows no Retry and gives its claim back when she looked away while the launch was answered", async () => {
    fake.reset();
    window.showErrorMessage.mockClear();
    const shared = await directory();
    const failed: Session = { ...waiting, status: "failed", settledAt };
    const answer = Promise.withResolvers<void>();
    const attempts = new Map<string, LaunchAttempt>();
    const sender = new Launches(
      {
        launchSession: async () => {
          await answer.promise;
          throw new MendApiError("Connect Claude to start a session here.", 422, "StoreFailure");
        },
        sessionDetail: async () => ({ session: failed, processes: [], currentAgent: null }),
      },
      {
        attempted: (sessionId, attempt) => attempts.set(sessionId, attempt),
        forget: (sessionId) => attempts.delete(sessionId),
      },
    );
    const sent = sender.launch("s", { mode: "pty", prompt: "add rate limiting" });
    const early = {
      prev: read(starting, new Map(attempts)),
      next: read(failed, new Map(attempts)),
    };
    const claims = new ToastClaims(shared);
    const release = vi.fn((key: string, at: string) => claims.release(key, at));
    const offer = vi.spyOn(sender, "offer");
    new Notifier(
      { showing: () => new Set<string>(), model: () => early.next, error: () => null },
      { claim: (key, at) => claims.claim(key, at), release },
      sender,
      prompts,
    ).changed(early);
    await vi.waitFor(() => expect(offer).toHaveBeenCalledTimes(1));
    fake.focus(false);
    answer.resolve();
    await sent;
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await readdir(shared)).toEqual([]));
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    fake.focus(true);
  });

  it("toasts a refusal whose confirming read failed once, by the settlement, across two windows", async () => {
    fake.reset();
    window.showErrorMessage.mockClear();
    const shared = await directory();
    const failed: Session = { ...waiting, status: "failed", settledAt };
    const attempts = new Map<string, LaunchAttempt>();
    await new Launches(
      {
        launchSession: async () => {
          throw new MendApiError("Connect Claude to start a session here.", 422, "StoreFailure");
        },
        sessionDetail: async () => {
          throw new MendApiError("Cannot reach Mend at http://localhost:3100.", null);
        },
      },
      {
        attempted: (sessionId, attempt) => attempts.set(sessionId, attempt),
        forget: (sessionId) => attempts.delete(sessionId),
      },
    ).launch("s", { mode: "pty", prompt: "add rate limiting" });
    const sent = new Map([["s", { n: 1, after: null, refusal: null }]]);
    const unconfirmed = { prev: read(starting, sent), next: read(starting, attempts) };
    const settled = { prev: unconfirmed.next, next: read(failed, attempts) };
    const other = { prev: read(starting), next: read(failed) };
    let model = unconfirmed.next;
    const here = new Notifier(
      { showing: () => new Set<string>(), model: () => model, error: () => null },
      new ToastClaims(shared),
      offering({ kind: "retry", read: failed }),
      prompts,
    );
    const there = new Notifier(
      { showing: () => new Set<string>(), model: () => other.next, error: () => null },
      new ToastClaims(shared),
      offering({ kind: "none" }),
      prompts,
    );
    here.changed(unconfirmed);
    await new Promise((resolve) => setTimeout(resolve, 50));
    model = settled.next;
    here.changed(settled);
    await vi.waitFor(() => expect(window.showErrorMessage).toHaveBeenCalledTimes(1));
    there.changed(other);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect(await readdir(shared)).toEqual([
      `${Date.parse(settledAt)}.${encodeURIComponent(`s:launchFailed:${settledAt}`)}`,
    ]);
  });

  it("gives its claim back and reads nothing once she looked away while it claimed", async () => {
    fake.reset();
    const shared = await directory();
    const change = refused();
    const store = { showing: () => new Set<string>(), model: () => change.next, error: () => null };
    const held = heldClaims(new ToastClaims(shared));
    const retry = offering({ kind: "retry", read: starting });
    new Notifier(store, held.claims, retry, prompts).changed(change);
    await vi.waitFor(async () => expect(await readdir(shared)).toHaveLength(1));
    fake.focus(false);
    held.letGo();
    await vi.waitFor(() => expect(held.release).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(await readdir(shared)).toEqual([]));
    expect(retry.offer).not.toHaveBeenCalled();
    expect(window.showErrorMessage).not.toHaveBeenCalled();
    fake.focus(true);
  });
});
