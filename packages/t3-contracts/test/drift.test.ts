import { describe, expect, it } from "vitest";

import { driftOf, hasDrift, newestNightly, parseLsTree, reportOf } from "../scripts/drift-lib.ts";
import { localOf } from "../scripts/sources.ts";

/** The drift job (docs/adr/0012, phase 4): what changed upstream since the pin, by blob id. */

describe("the newest nightly", () => {
  it("orders by version, then date, then build, and ignores other tags", () => {
    expect(
      newestNightly([
        "v0.0.46-nightly.20261003.2623",
        "v0.0.46-nightly.20261009.2886",
        "v0.0.46-nightly.20261009.2885",
        "v0.0.45-nightly.20261231.9999",
        "v0.1.0",
        "nightly-latest",
      ]),
    ).toBe("v0.0.46-nightly.20261009.2886");
    expect(newestNightly(["v0.0.47-nightly.20261001.1", "v0.0.46-nightly.20261009.2886"])).toBe(
      "v0.0.47-nightly.20261001.1",
    );
    expect(newestNightly(["v1.0.0"])).toBeNull();
  });
});

describe("drift", () => {
  const pinned = {
    "src/a.ts": { upstream: "packages/contracts/src/a.ts", blob: "aaa" },
    "src/b.ts": { upstream: "packages/contracts/src/b.ts", blob: "bbb" },
    LICENSE: { upstream: "LICENSE", blob: "lll" },
  };

  it("says which pinned files changed, which are new upstream and which are gone", () => {
    const upstream = parseLsTree(
      [
        "100644 blob aaa\tpackages/contracts/src/a.ts",
        "100644 blob ccc\tpackages/contracts/src/c.ts",
        "100644 blob LLL\tLICENSE",
        "040000 tree ttt\tpackages/contracts/src/nested",
      ].join("\n"),
    );
    const drift = driftOf(pinned, upstream);
    expect(drift.changed).toEqual([{ local: "LICENSE", upstream: "LICENSE" }]);
    expect(drift.added).toEqual([{ local: "src/c.ts", upstream: "packages/contracts/src/c.ts" }]);
    expect(drift.removed).toEqual([{ local: "src/b.ts", upstream: "packages/contracts/src/b.ts" }]);
    expect(hasDrift(drift)).toBe(true);
    const report = reportOf({ pinnedTag: "v-pin", tag: "v-new", commit: "abc", drift });
    expect(report).toContain("changed its contracts since the pin, v-pin");
    expect(report).toContain("pnpm --filter @mend/t3-contracts sync --tag v-new");
  });

  it("is quiet when every file is the pin's", () => {
    const upstream = Object.values(pinned).map((file) => ({
      upstream: file.upstream,
      blob: file.blob,
    }));
    const drift = driftOf(pinned, upstream);
    expect(hasDrift(drift)).toBe(false);
    expect(reportOf({ pinnedTag: "v-pin", tag: "v-pin", commit: "abc", drift })).toBe(
      "t3code v-pin (abc) has the same contract files as the pin, v-pin.\n",
    );
  });

  it("maps upstream files to where sync puts them, and nothing outside the sources", () => {
    expect(localOf("packages/contracts/src/x/y.ts")).toBe("src/x/y.ts");
    expect(localOf("packages/shared/src/keybindings.ts")).toBe("shared/keybindings.ts");
    expect(localOf("packages/contracts/srcish/z.ts")).toBeNull();
    expect(localOf("apps/web/src/main.ts")).toBeNull();
  });
});
