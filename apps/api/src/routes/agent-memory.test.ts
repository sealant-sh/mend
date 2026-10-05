import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const file = (contents: string) => ({
  path: ".claude/projects/-workspace-repo/memory/notes.md",
  encoding: "utf8",
  contents,
});

const nothing = {
  added: [],
  unchanged: [],
  updated: [],
  merged: [],
  keptStored: [],
  removedInMend: [],
  conflicting: [],
  skipped: [],
};

/** `mend memory import` and its plan (docs/adr/0009, decision 4). */
describe("agent memory import", () => {
  let api: TenancyApi;
  const imports: Array<{ readonly files: number; readonly dryRun: boolean }> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        agentMemory: {
          importFiles: (input) =>
            Effect.sync(() => {
              imports.push({ files: input.files.length, dryRun: input.dryRun });
              return nothing;
            }),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  // Review round 1, finding 6: two files at one path were both planned against the same store,
  // the second overwriting the first, and reported as two adds.
  it("refuses a path named twice with 400, on the import and its plan, and plans nothing", async () => {
    for (const suffix of ["", "/plan"]) {
      const refused = await api.request(
        "alice",
        "POST",
        `/api/projects/${ids("shared-a").project}/memory/import${suffix}`,
        { files: [file("a"), file("b")] },
      );
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        _tag: "AgentMemoryImportInvalid",
        paths: [".claude/projects/-workspace-repo/memory/notes.md"],
      });
    }
    expect(imports).toEqual([]);
  });

  it("passes the plan through as a dry run", async () => {
    const planned = await api.request(
      "alice",
      "POST",
      `/api/projects/${ids("shared-a").project}/memory/import/plan`,
      { files: [file("a")], source: { id: "machine:/code/app", label: "laptop" } },
    );
    expect(planned.status).toBe(200);
    expect(await planned.json()).toEqual(nothing);
    expect(imports).toEqual([{ files: 1, dryRun: true }]);
  });
});
