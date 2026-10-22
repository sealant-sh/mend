// Bundles are pinned by header and object count, not bytes, which vary with the local git and zlib
// build. Regenerate the golden: MEND_WRITE_HANDOFF_GOLDEN=1 pnpm --filter @mend/local-git test handoff-parity
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { captureCheckout, type LeftOut } from "../src/handoff.ts";
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

const bundleFacts = (bytes: Buffer) => {
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

const refusalOf = (outcome: { readonly _tag: "refused"; readonly message: string } | Cancelled) => {
  if (outcome._tag === "cancelled") throw new Error("nothing cancelled this cut");
  return { record: { refused: withoutGitsWords(outcome.message) }, bundle: null };
};

type Cancelled = { readonly _tag: "cancelled" };

// The golden predates the ignored-env reason, and names those files env as the cut then did.
const asRecorded = (out: LeftOut) =>
  out.reason === "ignored-env" ? { ...out, reason: "env" } : out;

const cutOf = (w: HandoffWorld, checkout: string) => {
  const captured = captureCheckout({
    checkout,
    defaultBranch: "main",
    machine: "dana-mbp",
    maxFileBytes: w.fileBytes,
    envFiles: "exclude",
    cutAt: CUT,
    scratchParent: fs.mkdtempSync(path.join(w.root, "scratch-")),
    runtime: { env: w.hostileEnv },
  });
  if (captured._tag !== "captured") return refusalOf(captured);
  const packed = captured.capture.pack();
  if (packed._tag !== "packed") return refusalOf(packed);
  expect(captured.capture.pack(), "packed twice").toEqual(packed);
  const bundle = fs.readFileSync(packed.bundlePath);
  captured.capture.dispose();
  const { defaultBranch: _, envFiles: __, ...summary } = captured.capture.summary;
  return {
    record: { ...summary, leftOut: summary.leftOut.map(asRecorded), bundle: bundleFacts(bundle) },
    bundle,
  };
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
    const checkout = scenario(w);
    const cut = cutOf(w, checkout);
    if (WRITING) written[name] = cut.record;
    else expect(cut.record).toEqual(golden[name]);
    if (cut.bundle !== null) {
      expect(cutOf(w, checkout).bundle?.equals(cut.bundle), "a second capture's bundle").toBe(true);
    }
  });

  it("has a golden entry for every scenario and no other", () => {
    if (WRITING) return;
    expect(Object.keys(golden)).toEqual(SCENARIOS.map(([name]) => name));
  });
});
