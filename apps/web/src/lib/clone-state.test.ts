import { describe, expect, it } from "vitest";

import { parseAttempt } from "#/lib/adoptions";
import type { AdoptionProgressDto } from "#/lib/api";
import { cloneDetail, cloneStateOf, cloneWords } from "#/lib/clone-state";
import { refusedWith } from "#/lib/refusal-fixture";

const startedAt = new Date("2026-11-18T10:00:00Z");
const progress = (fields: Partial<AdoptionProgressDto>): AdoptionProgressDto => ({
  id: "4c4b1f8e-5a8e-4f63-9e55-7d7a4c4e2b10",
  name: "ledger",
  source: "git@github.com:northwind/ledger.git",
  state: "running",
  phase: "cloning",
  git: null,
  projectId: null,
  failure: null,
  gitSaid: null,
  startedAt,
  updatedAt: new Date("2026-11-18T10:00:03Z"),
  ...fields,
});
const noRequest = { pending: false, project: undefined, error: null };

describe("where a clone stands", () => {
  it("follows the server's read of it", () => {
    expect(cloneStateOf({ data: progress({}), failed: false }, noRequest)._tag).toBe("Cloning");
    expect(
      cloneStateOf(
        { data: progress({ state: "adopted", projectId: "p-1" }), failed: false },
        noRequest,
      ),
    ).toEqual({ _tag: "Added", projectId: "p-1" });
    expect(
      cloneStateOf(
        {
          data: progress({
            state: "failed",
            failure: "GitHub didn't accept Mend's key for this repository.",
            gitSaid: "ERROR: Repository not found.",
          }),
          failed: false,
        },
        noRequest,
      ),
    ).toEqual({
      _tag: "Failed",
      message: "GitHub didn't accept Mend's key for this repository.",
      gitSaid: "ERROR: Repository not found.",
      startedAt,
      endedAt: new Date("2026-11-18T10:00:03Z"),
    });
  });

  it("is still cloning while its first read is on the way, or the request runs and the server doesn't know it yet", () => {
    expect(cloneStateOf({ data: undefined, failed: false }, noRequest)._tag).toBe("Cloning");
    expect(
      cloneStateOf({ data: undefined, failed: true }, { ...noRequest, pending: true })._tag,
    ).toBe("Cloning");
  });

  it("takes the request's own answer when the server no longer knows the clone", () => {
    expect(
      cloneStateOf(
        { data: undefined, failed: true },
        {
          ...noRequest,
          error: refusedWith("StoreFailure", 'A project named "ledger" already exists.'),
        },
      ),
    ).toMatchObject({ _tag: "Failed", message: 'A project named "ledger" already exists.' });
  });

  it("is gone when the server forgot it and this tab didn't start it", () => {
    expect(cloneStateOf({ data: undefined, failed: true }, noRequest)).toEqual({ _tag: "Gone" });
  });

  it("says how far it got in plain words", () => {
    expect(cloneWords(null)).toBe("Starting");
    expect(cloneWords(progress({ phase: "preparing" }))).toBe("Getting Git access ready");
    expect(
      cloneWords(
        progress({
          git: {
            step: "Receiving objects",
            remote: false,
            percent: 42,
            done: 420,
            total: 1000,
            received: "1.20 MiB",
            rate: null,
          },
        }),
      ),
    ).toBe("Receiving objects · 1.20 MiB");
  });
});

describe("the line under a running clone's bar", () => {
  const git = {
    step: "Receiving objects",
    remote: false,
    percent: 64,
    done: 18_240,
    total: 28_500,
    received: "41.20 MiB",
    rate: "6.20 MiB/s",
  };

  it("gives git's step with its count, and what arrived at what speed", () => {
    expect(cloneDetail(progress({ git }))).toEqual({
      step: "Receiving objects: 18,240 of 28,500 (64%)",
      transfer: "41.20 MiB at 6.20 MiB/s",
    });
  });

  it("drops what git hasn't said", () => {
    expect(
      cloneDetail(progress({ git: { ...git, total: null, percent: null, rate: null } })),
    ).toEqual({ step: "Receiving objects", transfer: "41.20 MiB" });
  });

  it("names Mend's own step before git reports, and after it", () => {
    expect(cloneDetail(null)).toEqual({ step: "Starting", transfer: null });
    expect(cloneDetail(progress({ phase: "checking", git }))).toEqual({
      step: "Checking the repository",
      transfer: null,
    });
  });
});

describe("the clone this browser keeps", () => {
  it("reads one kept before Projects wrote its address", () => {
    expect(parseAttempt(JSON.stringify({ id: "k-1", name: "godot", startedAt: 1 }))).toEqual({
      id: "k-1",
      name: "godot",
      startedAt: 1,
      source: null,
      visibility: null,
    });
  });

  it("reads the address and visibility it was asked for", () => {
    expect(
      parseAttempt(
        JSON.stringify({
          id: "k-2",
          name: "ledger",
          startedAt: 2,
          source: "https://github.com/northwind/ledger",
          visibility: "shared",
        }),
      ),
    ).toEqual({
      id: "k-2",
      name: "ledger",
      startedAt: 2,
      source: "https://github.com/northwind/ledger",
      visibility: "shared",
    });
  });
});
