import { describe, expect, it } from "vitest";

import {
  LAUNCH_BOOTING,
  LAUNCH_PREPARING,
  LAUNCH_WAITING_SAVING,
  launchPhaseOf,
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
});
