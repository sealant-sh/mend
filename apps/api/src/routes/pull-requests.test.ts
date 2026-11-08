import { Effect } from "effect";
import { expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

it("checks project visibility before GitHub access and forwards the actual caller, including a shared-project reader", async () => {
  const calls: Array<ReadonlyArray<unknown>> = [];
  const api = await createTenancyApi(
    {},
    {
      implement: {
        pullRequests: {
          detail: (caller, repository, number) =>
            Effect.sync(() => {
              calls.push([caller, repository, number]);
              return {
                viewer: caller,
                pullRequest: {
                  number,
                  title: "Observed PR",
                  body: "",
                  url: `https://github.com/acme/api/pull/${number}`,
                  author: null,
                  headBranch: "feature",
                  baseBranch: "main",
                  headSha: "abc123",
                  headRepository: "acme/api",
                  state: "open",
                  isDraft: false,
                  additions: 0,
                  deletions: 0,
                  changedFiles: 0,
                  createdAt: "2026-11-07T00:00:00Z",
                  updatedAt: "2026-11-07T00:00:00Z",
                  closedAt: null,
                  mergedAt: null,
                  mergeability: "unknown",
                  reviewDecision: null,
                  labels: [],
                  checks: [],
                  viewerCanUpdate: false,
                  observedAt: 0,
                },
              };
            }),
        },
      },
    },
  );
  try {
    const path = `/api/projects/${ids("shared-a").project}/pull-requests/123?repository=acme/api`;
    const shared = await api.request("carol", "GET", path);
    expect(shared.status).toBe(200);
    expect(calls).toEqual([["carol", "acme/api", 123]]);
    calls.length = 0;
    expect((await api.request("bob", "GET", path)).status).toBe(404);
    expect((await api.request(null, "GET", path)).status).toBe(401);
    expect(calls).toEqual([]);
    expect(
      (
        await api.request(
          "carol",
          "GET",
          `/api/projects/${ids("private-alice").project}/pull-requests/123?repository=acme/api`,
        )
      ).status,
    ).toBe(404);
    expect(calls).toEqual([]);
  } finally {
    await api.dispose();
  }
});
