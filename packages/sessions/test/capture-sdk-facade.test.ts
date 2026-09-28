import * as http from "node:http";

import { captureBehindReason, captureCaughtUp, captureSaved } from "@mend/domain/workbench";
import { Sealant } from "@sealant/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCaptureReport } from "../src/capture-runtime.ts";

/**
 * The installed `@sealant/sdk` facade between the daemon's answer and Mend's landing barrier
 * (review 2026-09-28 #16, cross-repo decision 9). The engine's tests hand `readCaptureReport` the
 * daemon's own fields; the SDK Mend pins rebuilds `capture.flush()`'s answer field by field and
 * may drop every snapshot-health field on the way. This drives the real facade over real HTTP
 * against a control plane that answers what a current sealantd reports, and holds that an answer
 * that lost its health reads not caught up — never a clean snapshot.
 */

const now = new Date().toISOString();
const DETAILS = {
  workspaceId: "ws-1",
  name: "ws-1",
  ownerUserId: "owner",
  status: "ready",
  createdAt: now,
  updatedAt: now,
};

/** A current sealantd's flush answer, as Core relays it: an empty queue, one path carried. */
const CARRIED = {
  epoch: 2,
  worktreeId: "wt",
  pending: 0,
  stagedBytes: 0,
  uploadedObjects: 1,
  uploadedBytes: 9,
  registered: 1,
  fenced: false,
  paused: false,
  refused: [],
  unreadable: 1,
  carried: 1,
  unreadablePaths: ["tree/app.ts"],
  lastSnapError: "unreadable current source file",
  snapFailingSinceUnixMs: Date.now(),
};

/** The same daemon when every path read. */
const CLEAN = { ...CARRIED, unreadable: 0, carried: 0, unreadablePaths: [] };
const { lastSnapError: _error, snapFailingSinceUnixMs: _since, ...CLEAN_NO_ERROR } = CLEAN;

let answer: object = CARRIED;
const server = http.createServer((request, response) => {
  const url = request.url ?? "";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(url.includes("/capture/") ? answer : DETAILS));
});
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});
afterAll(() => {
  server.close();
});

const flushThroughSdk = async (body: object) => {
  answer = body;
  const sealant = new Sealant({ baseUrl, ownerUserId: "owner" });
  try {
    const workspace = await sealant.workspaces.get("ws-1");
    return await workspace.capture.flush();
  } finally {
    await sealant.close();
  }
};

describe("the pinned SDK facade and the landing barrier", () => {
  it("reads a carried unreadable path as not caught up, whatever the facade kept of it", async () => {
    expect(captureCaughtUp(readCaptureReport({ ...CARRIED }))).toBe(false);
    const returned = await flushThroughSdk(CARRIED);
    const reading = readCaptureReport(returned);
    expect(reading.pending).toBe(0);
    expect(captureCaughtUp(reading)).toBe(false);
    // SDK 0.37.2 dropped the health fields; a facade that forwards them (0.38.0) reads the path.
    expect(["unreadable", "snapshot health not reported"]).toContain(captureBehindReason(reading));
  });

  it("reads a clean answer as caught up only when the facade carries its health", async () => {
    const returned = await flushThroughSdk(CLEAN_NO_ERROR);
    const reading = readCaptureReport(returned);
    const forwarded = "unreadable" in returned;
    expect(captureCaughtUp(reading)).toBe(forwarded);
    if (!forwarded) expect(captureBehindReason(reading)).toBe("snapshot health not reported");
  });
});

// e2e8 F1: a capture deadlocked for 17 minutes while every status read `running · 0 pending`.
// sealantd reports a step past its bound as `overdue` (status report field 31). Mend reads it
// wherever it is in the answer; whether it reaches Mend is Core's projection and SDK
// (PLATFORM-FEEDBACK.md, "A capture step past its bound").
describe("a capture step past its bound", () => {
  const OVERDUE = {
    ...CLEAN_NO_ERROR,
    overdue: {
      step: "small snap › git cat-file --batch-check",
      startedUnixMs: Date.parse("2026-09-28T06:54:14Z"),
      runningMs: 1_020_000,
      boundMs: 120_000,
    },
  };

  it("is read from the answer, and holds the landing barrier and any save", () => {
    // A final flush that says complete while a step is still overdue is still not saved.
    const completed = { ...OVERDUE, complete: true };
    const reading = readCaptureReport(completed);
    expect(reading.overdue).toEqual({
      step: "small snap › git cat-file --batch-check",
      startedAt: new Date("2026-09-28T06:54:14Z"),
      runningMs: 1_020_000,
      boundMs: 120_000,
    });
    expect(captureCaughtUp(reading)).toBe(false);
    expect(captureSaved(reading)).toBe(false);
    // An answer without one reads none.
    expect(readCaptureReport({ ...CLEAN_NO_ERROR }).overdue).toBeNull();
  });

  it("through the pinned SDK facade: forwarded, it is read; dropped, it reads none (a platform gap)", async () => {
    const returned = await flushThroughSdk(OVERDUE);
    const reading = readCaptureReport(returned);
    if ("overdue" in returned) {
      expect(reading.overdue?.step).toBe("small snap › git cat-file --batch-check");
    } else {
      expect(reading.overdue).toBeNull();
    }
  });
});
