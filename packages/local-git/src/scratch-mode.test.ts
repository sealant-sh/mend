import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { countedCheckout, handoffWorlds } from "../test/testing.ts";
import { captureCheckout, preflightIssue } from "./handoff.ts";

const opened = vi.hoisted(() => ({ parent: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    mkdtempSync: (prefix: string) => {
      const dir = real.mkdtempSync(prefix);
      if (path.dirname(dir) === opened.parent) real.chmodSync(dir, 0o750);
      return dir;
    },
  };
});

const world = handoffWorlds();

describe("a capture's directory, made readable by others where mkdtemp ignores its mode", () => {
  it("is refused and removed, by a capture and a preflight", () => {
    const w = world();
    const checkout = countedCheckout(w);
    opened.parent = fs.mkdtempSync(path.join(w.root, "scratch-"));
    const refusal = {
      _tag: "refused",
      message: `the directory a handoff made under ${opened.parent} was readable by others · nothing was created`,
      why: { reason: "scratch-exposed", parent: opened.parent },
    };
    const runtime = { env: w.hostileEnv };
    expect(
      captureCheckout({
        checkout,
        defaultBranch: "main",
        machine: "dana-mbp",
        maxFileBytes: w.fileBytes,
        envFiles: "exclude",
        cutAt: new Date("2026-10-18T07:42:05.000Z"),
        scratchParent: opened.parent,
        runtime,
      }),
    ).toEqual(refusal);
    expect(fs.readdirSync(opened.parent)).toEqual([]);
    expect(preflightIssue({ checkout, scratchParent: opened.parent, runtime })).toEqual(refusal);
    expect(fs.readdirSync(opened.parent)).toEqual([]);
  });
});
