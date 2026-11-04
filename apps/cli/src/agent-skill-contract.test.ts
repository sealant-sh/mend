import { describe, expect, it } from "vitest";

import {
  commandSuites,
  mentioned,
  personOnly,
  registry,
  skill,
  skillCommands,
  uncoveredCommands,
} from "./agent-skill-contract-test-fixtures.ts";

describe("the bundled skill's executed JSON v1 contract", () => {
  it("extracts fenced and inline commands, including unknown commands and subcommands", () => {
    expect(
      skillCommands(
        "```sh\nmend resource future db --json\nmend future SESSION --json\n```\nUse `mend projects image PROJECT --json` and `mend help COMMAND --json`; a person runs `mend attach SESSION`.",
      ),
    ).toEqual(["attach", "future", "help", "projects image", "resource future"]);
  });

  it("requires an executable success/error pair or an explicit person-only explanation for every command", () => {
    expect(mentioned.length).toBeGreaterThan(0);
    expect(
      uncoveredCommands(skill),
      "Add actual subprocess success/error scenarios for every new skill command",
    ).toEqual([]);
    expect([...personOnly.keys()]).toEqual(["attach"]);
    for (const name of mentioned) {
      const entry = registry.get(name);
      if (entry === undefined) {
        expect(personOnly.get(name)).toEqual(expect.any(String));
      } else {
        expect(entry.success.length, `${name} needs success observations`).toBeGreaterThan(0);
        expect(entry.error.length, `${name} needs error observations`).toBeGreaterThan(0);
      }
    }
  });

  it("assigns every executable command to exactly one bounded suite", () => {
    const assigned = Object.values(commandSuites).flat();
    expect(assigned.toSorted()).toEqual([...registry.keys()].toSorted());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it.each([
    "`mend uncovered SESSION --json`",
    "```sh\nmend uncovered SESSION --json\n```",
    "~~~sh\nmend uncovered SESSION --json\n~~~",
    "`mend help COMMAND --json && mend uncovered SESSION --json`",
    "Run mend uncovered SESSION --json.",
    "`mend resource uncovered db --json`",
  ])("rejects a newly documented command without scenarios in %s", (addition) => {
    expect(uncoveredCommands(`${skill}\n${addition}`)).toHaveLength(1);
  });
});
