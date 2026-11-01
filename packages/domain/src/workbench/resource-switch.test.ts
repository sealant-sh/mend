import { describe, expect, it } from "vitest";

import { changedResourceEnvNames, resourceSwitchMessage } from "./resource-switch.ts";

const input = {
  name: "db",
  from: "project",
  to: "worktree",
  changed: ["MEND_DB_URL", "MEND_DB_DATABASE"],
  services: [],
} as const;
const changed =
  "@db switched from project to worktree. Changed: MEND_DB_URL, MEND_DB_DATABASE. Your already-running processes, including your own shell, still have the old values. Run mend resource env to print the current values, or restart the process to receive them. Printing values does not update your shell.";
describe("resource switches", () => {
  it("reports values changed and observed Service restarts exactly", () => {
    expect(resourceSwitchMessage(input)).toBe(changed);
    expect(
      resourceSwitchMessage({ ...input, services: [{ name: "web", kind: "restarted" }] }),
    ).toBe(`${changed} Mend restarted this worktree's Services with the current values.`);
    expect(
      resourceSwitchMessage({
        ...input,
        services: [
          { name: "web", kind: "restarted" },
          { name: "api", kind: "failed", message: "port is held" },
        ],
      }),
    ).toBe(
      `${changed} Mend restarted web with the current values. api did not restart: port is held.`,
    );
    expect(
      resourceSwitchMessage({
        ...input,
        services: [{ name: "api", kind: "failed", message: "port is held" }],
      }),
    ).toBe(`${changed} api did not restart: port is held.`);
  });
  it("explains a switch with the same env names and values", () => {
    expect(resourceSwitchMessage({ ...input, name: "cache", changed: [] })).toBe(
      "@cache switched from project to worktree. No MEND_* value changed: the same names now reach this worktree's own container.",
    );
    expect(
      resourceSwitchMessage({
        ...input,
        name: "cache",
        from: "worktree",
        to: "project",
        changed: [],
      }),
    ).toBe(
      "@cache switched from worktree to project. No MEND_* value changed: the same names now reach the project's container.",
    );
  });
  it("counts added and removed names in env order", () => {
    expect(
      changedResourceEnvNames(
        { MEND_DB_DATABASE: "app", MEND_DB_HOST: "db", MEND_DB_URL: "old", MEND_DB_EXTRA: "gone" },
        {
          MEND_DB_URL: "new",
          MEND_DB_HOST: "db",
          MEND_DB_USER: "postgres",
          MEND_DB_DATABASE: "own",
        },
      ),
    ).toEqual(["MEND_DB_URL", "MEND_DB_USER", "MEND_DB_DATABASE", "MEND_DB_EXTRA"]);
  });
  it("keeps declared URL-like exports after the standard fields", () => {
    expect(
      changedResourceEnvNames(
        { MEND_DB_URL: "old", MEND_DB_SMTP_URL: "old" },
        { MEND_DB_URL: "new", MEND_DB_SMTP_URL: "new", MEND_DB_DATABASE: "own" },
        "MEND_DB_",
      ),
    ).toEqual(["MEND_DB_URL", "MEND_DB_DATABASE", "MEND_DB_SMTP_URL"]);
  });
});
