import { describe, expect, it } from "vitest";

import {
  LAUNCH_BOOTING,
  LAUNCH_PREPARING,
  LAUNCH_QUEUED,
  LAUNCH_WAITING_SAVING,
  launchBuildingWords,
  launchPhaseOf,
  leaseWaitWords,
  withoutLaunchPhase,
} from "./launch-phase.ts";

describe("launch phase words", () => {
  it("reads the phase at the end of a summary, and what stands in front of it", () => {
    expect(launchPhaseOf(LAUNCH_BOOTING)).toEqual({ kind: "booting", words: "booting" });
    expect(launchPhaseOf(`dotfiles not applied · ${LAUNCH_PREPARING}`)).toEqual({
      kind: "preparing",
      words: LAUNCH_PREPARING,
    });
    expect(launchPhaseOf(LAUNCH_WAITING_SAVING)?.kind).toBe("waiting-previous");
    expect(withoutLaunchPhase(`dotfiles not applied · ${LAUNCH_BOOTING}`)).toBe(
      "dotfiles not applied",
    );
    expect(withoutLaunchPhase(LAUNCH_PREPARING)).toBeNull();
    expect(launchPhaseOf("launch failed: Workspace reached failed")).toBeNull();
    expect(launchPhaseOf(null)).toBeNull();
  });

  it("still reads the words stored before the preparing phase was renamed", () => {
    const legacy = "building the workspace image (first launch after an update, ~8 min)";
    expect(launchPhaseOf(legacy)?.kind).toBe("preparing");
    expect(withoutLaunchPhase(`a · ${legacy}`)).toBe("a");
  });

  it("never claims an image build: the platform reports none", () => {
    expect(LAUNCH_PREPARING).not.toContain("building the workspace image");
    expect(LAUNCH_PREPARING).toContain("no runtime yet");
  });

  it("says what a live holder's lookup observed, never 'not answering' for a 404 under a live lease", () => {
    const notFound = leaseWaitWords({
      kind: "unreachable",
      lookup: { kind: "failed", status: 404, code: "WorkspaceNotFoundError" },
    });
    expect(notFound).toBe(
      "waiting · the previous session in this worktree renews its lease, but the platform did not find its workspace (404)",
    );
    expect(
      leaseWaitWords({ kind: "unreachable", lookup: { kind: "not-live", state: "stopped" } }),
    ).toBe(
      "waiting · the previous session in this worktree renews its lease, but the platform reports its workspace stopped",
    );
    expect(
      leaseWaitWords({
        kind: "unreachable",
        lookup: { kind: "failed", status: 503, code: "control_plane_unavailable" },
      }),
    ).toBe("waiting · the previous session in this worktree is not answering");
    expect(leaseWaitWords({ kind: "unreachable" })).toBe(
      "waiting · the previous session in this worktree is not answering",
    );
    // Every one of them still reads as the waiting phase.
    expect(launchPhaseOf(notFound)?.kind).toBe("waiting-previous");
  });
});

describe("Core's launch phase on the line (sealant#342)", () => {
  it("says the build's step when the builder reports one", () => {
    expect(launchBuildingWords({ step: 3, steps: 12 })).toBe(
      "building the workspace image · step 3/12",
    );
    expect(launchBuildingWords({ step: 3 })).toBe("building the workspace image · step 3");
    expect(launchBuildingWords(null)).toBe("building the workspace image");
  });

  it("reads queued and building back, and takes the words off once the agent runs", () => {
    expect(launchPhaseOf(LAUNCH_QUEUED)).toEqual({ kind: "queued", words: LAUNCH_QUEUED });
    const building = launchBuildingWords({ step: 3, steps: 12 });
    expect(launchPhaseOf(`dotfiles not applied · ${building}`)).toEqual({
      kind: "building",
      words: building,
    });
    expect(withoutLaunchPhase(`dotfiles not applied · ${building}`)).toBe("dotfiles not applied");
    // What older servers said still reads as preparing.
    expect(
      launchPhaseOf("building the workspace image (first launch after an update, ~8 min)")?.kind,
    ).toBe("preparing");
  });
});
