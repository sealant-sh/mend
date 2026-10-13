import * as http from "node:http";

import { captureBehindReason, captureCaughtUp, captureSaved } from "@mend/domain/workbench";
import { Sealant } from "@sealant/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCaptureReport } from "../src/capture-runtime.ts";

/** Exercise the installed public SDK over HTTP before applying Mend's landing barrier. */

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
  snapFailingSinceUnixMs: Date.parse("2026-09-28T06:54:14Z"),
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
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) return reject(error);
      resolve();
    }),
  );
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
  it("preserves unreadable paths and snapshot failures through the installed SDK", async () => {
    const returned = await flushThroughSdk(CARRIED);
    expect(returned).toMatchObject(CARRIED);
    const reading = readCaptureReport(returned);
    expect(reading).toMatchObject({
      pending: 0,
      unreadable: 1,
      unreadablePaths: ["tree/app.ts"],
      snapError: "unreadable current source file",
      snapFailingSince: new Date("2026-09-28T06:54:14Z"),
    });
    expect(captureCaughtUp(reading)).toBe(false);
    expect(captureSaved(reading)).toBe(false);
    expect(captureBehindReason(reading)).toBe("unreadable");
  });

  it("preserves clean snapshot health and permits the landing barrier", async () => {
    const returned = await flushThroughSdk(CLEAN_NO_ERROR);
    expect(returned).toMatchObject(CLEAN_NO_ERROR);
    const reading = readCaptureReport(returned);
    expect(reading).toMatchObject({ unreadable: 0, unreadablePaths: [], snapError: null });
    expect(captureCaughtUp(reading)).toBe(true);
    expect(captureBehindReason(reading)).toBeNull();
    // A healthy status without a final completion claim still does not prove a saved final.
    expect(captureSaved(reading)).toBe(false);
  });

  it("refuses a legacy answer that omits snapshot health", async () => {
    const returned = await flushThroughSdk({
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
    });
    const reading = readCaptureReport(returned);
    expect(reading.unreadable).toBeNull();
    expect(captureBehindReason(reading)).toBe("snapshot health not reported");
    expect(captureCaughtUp(reading)).toBe(false);
    expect(captureSaved(reading)).toBe(false);
  });
});

// An empty queue cannot hide a capture step that exceeded its bound.
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

  it("preserves overdue timing through the installed SDK and holds both barriers", async () => {
    const returned = await flushThroughSdk({ ...OVERDUE, complete: true });
    expect(returned).toMatchObject({ overdue: OVERDUE.overdue, complete: true });
    const reading = readCaptureReport(returned);
    expect(reading.overdue).toEqual({
      step: "small snap › git cat-file --batch-check",
      startedAt: new Date("2026-09-28T06:54:14Z"),
      runningMs: 1_020_000,
      boundMs: 120_000,
    });
    expect(captureBehindReason(reading)).toBe("capture step overdue");
    expect(captureCaughtUp(reading)).toBe(false);
    expect(captureSaved(reading)).toBe(false);
  });
});
