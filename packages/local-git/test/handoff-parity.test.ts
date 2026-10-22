// Bundles are pinned by header and object count, not bytes, which vary with the local git and zlib
// build. Regenerate the golden: MEND_WRITE_HANDOFF_GOLDEN=1 pnpm --filter @mend/local-git test handoff-parity
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { snapshotCheckout } from "../src/handoff.ts";
import {
  committedEnvCheckout,
  conflictedNewsroomCheckout,
  countedCheckout,
  detachedCheckout,
  detachedNewsroomCheckout,
  dirToFileCheckout,
  evilMergeCheckout,
  fetchedPartialClone,
  type HandoffWorld,
  handoffWorlds,
  hiddenEditsCheckout,
  hiddenNewsroomCheckout,
  ignoredEnvCheckout,
  linkedWorktree,
  mergedMainCheckout,
  mixedCheckout,
  newsroomCheckout,
  noOriginMainCheckout,
  nonUtf8Checkout,
  nothingFetchedCheckout,
  otherDefaultCheckout,
  partialClone,
  danglingOriginHeadCheckout,
  replacedCheckout,
  SAME_TICKS,
  sameTickCheckout,
  signedCheckout,
  sparseIndexCheckout,
  unbornCheckout,
  unmergedCheckout,
  unsetDefaultCheckout,
} from "./testing.ts";

const GOLDEN = path.join(import.meta.dirname, "handoff-parity.golden.json");
const WRITING = process.env["MEND_WRITE_HANDOFF_GOLDEN"] === "1";
const CUT = new Date("2026-10-18T07:42:05.000Z");
const ORIGIN = "https://github.com/acme/newsroom-api.git";

const SCENARIOS: ReadonlyArray<readonly [string, (w: HandoffWorld) => string]> = [
  ["mixed", (w) => mixedCheckout(w).checkout],
  ["counted", countedCheckout],
  ["committed-env", (w) => committedEnvCheckout(w).checkout],
  ["detached", detachedCheckout],
  ["linked-worktree", (w) => linkedWorktree(w).linked],
  ["no-origin-main", noOriginMainCheckout],
  ["unmerged", unmergedCheckout],
  ["non-utf8", (w) => nonUtf8Checkout(w).checkout],
  ...SAME_TICKS.map(
    ([name, tick]) =>
      [`same-tick ${name}`, (w: HandoffWorld) => sameTickCheckout(w, tick)] as const,
  ),
  ["dir-to-file", dirToFileCheckout],
  ["hidden-edits", hiddenEditsCheckout],
  ["partial-clone", partialClone],
  ["fetched-partial-clone", fetchedPartialClone],
  ["replaced", (w) => replacedCheckout(w).checkout],
  ["signed", (w) => signedCheckout(w).checkout],
  ["sparse-index", (w) => sparseIndexCheckout(w)],
  ["evil-merge", (w) => evilMergeCheckout(w).checkout],
  ["ignored-env", ignoredEnvCheckout],
  ["merged-main", (w) => mergedMainCheckout(w).checkout],
  ["newsroom", (w) => newsroomCheckout(w, ORIGIN)],
  ["hidden-newsroom", (w) => hiddenNewsroomCheckout(w, ORIGIN)],
  ["detached-newsroom", (w) => detachedNewsroomCheckout(w, ORIGIN)],
  ["unborn", (w) => unbornCheckout(w, ORIGIN)],
  ["conflicted-newsroom", (w) => conflictedNewsroomCheckout(w, ORIGIN)],
  ["nothing-fetched", (w) => nothingFetchedCheckout(w, ORIGIN)],
  ["other-default", (w) => otherDefaultCheckout(w, ORIGIN)],
  ["renamed-default", (w) => danglingOriginHeadCheckout(w, ORIGIN)],
  ["unset-default", (w) => unsetDefaultCheckout(w, ORIGIN)],
];

const bundleFacts = (file: string) => {
  const bytes = fs.readFileSync(file);
  const end = bytes.indexOf("\n\n");
  const header = bytes.subarray(0, end).toString().split("\n").slice(1);
  const pack = bytes.subarray(end + 2);
  expect(pack.subarray(0, 4).toString()).toBe("PACK");
  return {
    prerequisites: header.filter((line) => line.startsWith("-")).toSorted(),
    refs: header.filter((line) => !line.startsWith("-") && !line.startsWith("@")).toSorted(),
    objects: pack.readUInt32BE(8),
  };
};

const withoutGitsWords = (message: string): string =>
  message.replace(
    / · git said: .+ · nothing was created$/u,
    " · git said: … · nothing was created",
  );

const world = handoffWorlds();

const cutOf = (w: HandoffWorld, checkout: string) => {
  const outcome = snapshotCheckout({
    checkout,
    defaultBranch: "main",
    machine: "dana-mbp",
    maxFileBytes: w.fileBytes,
    scratch: fs.mkdtempSync(path.join(w.root, "scratch-")),
    cutAt: CUT,
    env: w.hostileEnv,
  });
  if (outcome._tag === "refused") return { refused: withoutGitsWords(outcome.message) };
  const { bundlePath, bundleBytes: _, ...summary } = outcome.snapshot;
  return { ...summary, bundle: bundleFacts(bundlePath) };
};

const golden: Readonly<Record<string, unknown>> = WRITING
  ? {}
  : JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
const written: Record<string, unknown> = {};

afterAll(() => {
  if (WRITING) fs.writeFileSync(GOLDEN, `${JSON.stringify(written, null, 2)}\n`);
});

describe("a handoff cut", () => {
  it.each(SCENARIOS)("yields what it always has: %s", (name, scenario) => {
    const w = world();
    const cut = cutOf(w, scenario(w));
    if (WRITING) written[name] = cut;
    else expect(cut).toEqual(golden[name]);
  });

  it("has a golden entry for every scenario and no other", () => {
    if (WRITING) return;
    expect(Object.keys(golden)).toEqual(SCENARIOS.map(([name]) => name));
  });
});
