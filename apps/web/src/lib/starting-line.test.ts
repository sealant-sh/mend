import {
  launchBuildingWords,
  LAUNCH_BOOTING,
  LAUNCH_PREPARING,
  LAUNCH_QUEUED,
  LAUNCH_WAITING_SAVING,
  launchPhaseOf,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { startingLine } from "./starting-line.ts";

describe("the starting line", () => {
  it("says the session is getting ready, and nothing more for the usual steps", () => {
    expect(startingLine(null)).toBe("Getting the session ready");
    expect(startingLine(launchPhaseOf(LAUNCH_BOOTING))).toBe("Getting the session ready");
    expect(startingLine(launchPhaseOf(LAUNCH_PREPARING))).toBe("Getting the session ready");
  });

  it("says what a long wait waits for, in plain words", () => {
    expect(startingLine(launchPhaseOf(LAUNCH_QUEUED))).toBe(
      "Getting the session ready · waiting for a free machine",
    );
    expect(startingLine(launchPhaseOf(launchBuildingWords({ step: 3, steps: 12 })))).toBe(
      "Getting the session ready · building the workspace image, step 3 of 12",
    );
    expect(startingLine(launchPhaseOf(launchBuildingWords({ step: 3 })))).toBe(
      "Getting the session ready · building the workspace image, step 3",
    );
    expect(startingLine(launchPhaseOf(LAUNCH_WAITING_SAVING))).toBe(
      "Getting the session ready · the previous session in this worktree is saving",
    );
  });
});
