import { WORKTREE_STAMP } from "@mend/sessions";
import { Effect } from "effect";
import { afterAll, beforeAll, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

let api: TenancyApi;
const project = ids("private-alice").project;
const reads: string[] = [];
beforeAll(async () => {
  api = await createTenancyApi(
    {},
    {
      implement: {
        reads: {
          readDefaultBranchFile: (_id, path) => {
            reads.push(path);
            return Effect.succeed({
              value:
                path === "README.md"
                  ? {
                      bytes: new TextEncoder().encode("# Default branch\n"),
                      size: 17,
                      binary: false,
                      truncated: false,
                    }
                  : null,
              stamp: WORKTREE_STAMP,
            });
          },
        },
      },
    },
  );
});
afterAll(async () => {
  await api?.dispose();
});
it("reads the default branch before any session exists and respects visibility", async () => {
  const response = await api.request(
    "alice",
    "GET",
    `/api/projects/${project}/contents?path=README.md`,
  );
  expect(response.status).toBe(200);
  expect((await response.json()).file.contents).toBe("# Default branch\n");
  const absent = await api.request(
    "alice",
    "GET",
    `/api/projects/${project}/contents?path=t3.json`,
  );
  expect(absent.status).toBe(200);
  expect((await absent.json()).file).toBeNull();
  const before = reads.length;
  expect(
    (await api.request("carol", "GET", `/api/projects/${project}/contents?path=README.md`)).status,
  ).toBe(404);
  expect(reads.length).toBe(before);
  expect(
    (await api.request("alice", "GET", `/api/projects/${project}/contents?path=../secret`)).status,
  ).toBe(422);
  expect(reads.length).toBe(before);
});
