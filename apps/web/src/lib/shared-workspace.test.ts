import {
  retirementStopLines,
  WorkspaceRetirement,
  WorkspaceRetirementStop,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { refusedWith } from "./refusal-fixture.ts";
import { replaceRefusalWords, retirementView } from "./shared-workspace.ts";

const names = (id: string) => (id === "alice" ? "Alice" : null);
const checkedAt = new Date("2026-10-08T12:05:00Z");

const retirement = (
  fields: Partial<ConstructorParameters<typeof WorkspaceRetirement>[0]> = {},
): WorkspaceRetirement =>
  new WorkspaceRetirement({
    state: "marked",
    preRelease: true,
    launcher: "alice",
    stops: [
      new WorkspaceRetirementStop({ kind: "terminal", label: "claude — fix login" }),
      new WorkspaceRetirementStop({ kind: "service", label: "web on :3000" }),
      new WorkspaceRetirementStop({ kind: "process", label: "python (pid 31)" }),
    ],
    reason: null,
    checkedAt,
    fingerprint: "fp-1",
    canReplace: true,
    ...fields,
  });

describe("the retirement view", () => {
  it("names the launcher and lists, as evidence, what was checked and what would stop", () => {
    const view = retirementView(retirement(), names, []);
    expect(view.line).toBe(
      "This workspace started before Mend 0.36 and shares one home · it takes only Alice's sessions and turns until it is replaced",
    );
    expect(view.stops).toEqual(retirementStopLines(retirement()));
    expect(view.stops[0]).toContain("Checked at 12:05 UTC");
    expect(view.stops).toContain("process Mend did not start · python (pid 31)");
    expect(view.canReplace).toBe(true);
  });

  it("shows everyone else the evidence, with a process's kind only, and no action", () => {
    const reader = retirementView(
      retirement({
        canReplace: false,
        stops: [
          new WorkspaceRetirementStop({ kind: "process", label: "" }),
          new WorkspaceRetirementStop({ kind: "container", label: "" }),
        ],
      }),
      names,
      [],
    );
    expect(reader.canReplace).toBe(false);
    expect(reader.stops).toContain("process Mend did not start");
    expect(reader.stops.join("\n")).not.toContain("pid");
  });

  it("offers nothing while it is being replaced", () => {
    const retiring = retirementView(retirement({ state: "retiring" }), names, []);
    expect(retiring.canReplace).toBe(false);
    expect(retiring.stops).toEqual([]);
    expect(retiring.line).toContain("Replacing this workspace");
  });

  it("takes the launcher's name from the live people when the roster lacks it", () => {
    const view = retirementView(
      retirement({ launcher: "erin", reason: "a shell is open" }),
      names,
      [{ accountId: "erin", name: "Erin" }],
    );
    expect(view.line).toContain("Erin's sessions");
    expect(view.line.endsWith(" · a shell is open")).toBe(true);
  });
});

describe("a refused replacement", () => {
  it("is said in the server's words, or plainly when it has none", () => {
    const words =
      "What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.";
    expect(replaceRefusalWords(refusedWith("WorkspaceReplaceRefused", words))).toBe(words);
    expect(replaceRefusalWords(new Error(""))).toBe("The workspace was not replaced.");
  });
});
