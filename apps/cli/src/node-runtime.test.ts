import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { isSqliteExperimentalWarning, nodeVersionIssue } from "./node-runtime.ts";

describe("nodeVersionIssue", () => {
  it("takes Node 22.13 and newer", () => {
    for (const version of ["v22.13.0", "v22.23.3", "v24.0.0", "v26.4.0", "26.10.1"]) {
      expect(nodeVersionIssue(version), version).toBeNull();
    }
  });

  it("refuses an older Node with one plain line (fresh install 2026-10-10)", () => {
    expect(nodeVersionIssue("v22.12.0")).toBe(
      "Node.js 22.13 or newer is required; this is v22.12.0. Upgrade Node.js, then run it again.",
    );
    expect(nodeVersionIssue("v20.18.1")).toContain("this is v20.18.1");
    expect(nodeVersionIssue("v18.19.1")).toContain("22.13 or newer");
  });

  it("matches engines.node in package.json", async () => {
    const { default: manifest } = await import("../package.json", { with: { type: "json" } });
    expect(manifest.engines.node).toBe(">=22.13.0");
  });
});

describe("the SQLite ExperimentalWarning", () => {
  it("is the only warning dropped", () => {
    const sqlite = new Error("SQLite is an experimental feature and might change at any time");
    sqlite.name = "ExperimentalWarning";
    expect(isSqliteExperimentalWarning(sqlite)).toBe(true);
    const other = new Error("WASI is an experimental feature and might change at any time");
    other.name = "ExperimentalWarning";
    expect(isSqliteExperimentalWarning(other)).toBe(false);
    const deprecation = new Error("SQLite something");
    deprecation.name = "DeprecationWarning";
    expect(isSqliteExperimentalWarning(deprecation)).toBe(false);
  });

  it("is not printed by a process that quiets it, and other warnings still are", () => {
    const entry = new URL("./node-runtime.ts", import.meta.url).pathname;
    const script = [
      `const { quietSqliteWarning } = await import(${JSON.stringify(entry)});`,
      "quietSqliteWarning();",
      'process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");',
      'process.emitWarning("something else", "ExperimentalWarning");',
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("SQLite");
    expect(result.stderr).toContain("something else");
  });
});
