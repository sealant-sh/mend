// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdoptionProgressDto } from "./api.ts";

const adoptProject = vi.fn();
vi.mock("./api.ts", () => ({ adoptProject: (...args: Array<unknown>) => adoptProject(...args) }));

const { outcomeOf, parseAttempt, progressWords, startAdoption } = await import("./adoptions.ts");
const { readDraft } = await import("./drafts.ts");

const progress = (fields: Partial<AdoptionProgressDto>): AdoptionProgressDto => ({
  id: "a-1",
  name: "mend",
  source: "https://github.com/sealant-sh/mend",
  state: "running",
  phase: "cloning",
  git: null,
  projectId: null,
  failure: null,
  gitSaid: null,
  startedAt: new Date("2026-11-02T10:00:00.000Z"),
  updatedAt: new Date("2026-11-02T10:00:05.000Z"),
  ...fields,
});

const stored = () => parseAttempt(readDraft("adoption"));

const deps = (gitSaid: string | null = null) => ({
  refreshProjects: vi.fn(async () => undefined),
  readProgress: vi.fn(async () => progress({ state: "failed", gitSaid })),
});

beforeEach(() => {
  sessionStorage.clear();
  adoptProject.mockReset();
});

describe("an adoption's progress, in words", () => {
  it("says git's step, its count and what has arrived, as git reports them", () => {
    expect(
      progressWords(
        progress({
          git: {
            step: "Receiving objects",
            remote: false,
            percent: 45,
            done: 72,
            total: 160,
            received: "1.20 MiB",
            rate: "2.00 MiB/s",
          },
        }),
      ),
    ).toBe("receiving objects 45% · 72 of 160 · 1.20 MiB at 2.00 MiB/s");
    expect(
      progressWords(
        progress({
          git: {
            step: "Enumerating objects",
            remote: true,
            percent: null,
            done: 160,
            total: null,
            received: null,
            rate: null,
          },
        }),
      ),
    ).toBe("server · enumerating objects · 160");
  });

  it("says Mend's own phase around the clone", () => {
    expect(progressWords(undefined)).toBe("starting");
    expect(progressWords(progress({ phase: "preparing" }))).toBe("preparing git access");
    expect(progressWords(progress({ phase: "checking" }))).toBe("checking the repository");
    expect(progressWords(progress({ phase: "recording" }))).toBe("recording the project");
  });
});

describe("the tab's adoption", () => {
  it("is kept while the clone runs, so a closed dialog finds it again, and settles on the answer", async () => {
    const held: { resolve: (project: { readonly id: string }) => void } = {
      resolve: () => undefined,
    };
    adoptProject.mockReturnValue(
      new Promise<{ readonly id: string }>((resolve) => {
        held.resolve = resolve;
      }),
    );
    const done = startAdoption(deps(), {
      name: "mend",
      source: "https://github.com/sealant-sh/mend",
      auth: "mend-key",
      visibility: "private",
    });
    expect(stored()).toMatchObject({ name: "mend", outcome: { _tag: "Running" } });
    const [, , , , adoptionId] = adoptProject.mock.calls[0] ?? [];
    expect(adoptionId).toBe(stored()?.id);
    held.resolve({ id: "p-mend" });
    await done;
    expect(stored()?.outcome).toEqual({ _tag: "Adopted", projectId: "p-mend" });
  });

  it("keeps Mend's sentence and git's own words when the clone fails", async () => {
    adoptProject.mockRejectedValue(new Error("The repository was not found."));
    await startAdoption(deps("fatal: repository 'https://github.com/sealant-sh/nope/' not found"), {
      name: "nope",
      source: "https://github.com/sealant-sh/nope",
      auth: "mend-key",
      visibility: "private",
    });
    expect(stored()?.outcome).toEqual({
      _tag: "Failed",
      message: "The repository was not found.",
      gitSaid: "fatal: repository 'https://github.com/sealant-sh/nope/' not found",
    });
  });

  it("ends an adoption this tab no longer waits on as the server read says", () => {
    const running = {
      id: "a-1",
      name: "mend",
      source: "https://github.com/sealant-sh/mend",
      startedAt: 0,
      outcome: { _tag: "Running" },
    } as const;
    expect(outcomeOf(running, progress({ state: "adopted", projectId: "p-mend" }), false)).toEqual({
      _tag: "Adopted",
      projectId: "p-mend",
    });
    expect(
      outcomeOf(
        running,
        progress({ state: "failed", failure: "Permission denied.", gitSaid: "fatal: x" }),
        false,
      ),
    ).toEqual({ _tag: "Failed", message: "Permission denied.", gitSaid: "fatal: x" });
    expect(outcomeOf(running, undefined, true)._tag).toBe("Failed");
    expect(outcomeOf(running, progress({}), false)._tag).toBe("Running");
  });
});
