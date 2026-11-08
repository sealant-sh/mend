import { type PullRequestWorkspaceTarget } from "@mend/landing";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

// Ordinary trigger: a person presses Merge in T3's PR panel. Reads never merge, and the
// explicit mutation must use that person's account, even on another person's shared project.
const PROJECT = ids("shared-a").project;
const ROOT = `/api/projects/${PROJECT}/pull-requests/42`;
let api: TenancyApi | undefined;
afterEach(async () => {
  await api?.dispose();
  api = undefined;
});

const state = {
  viewer: { login: "Carol" },
  repository: {
    viewerPermission: "WRITE",
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: true,
    pullRequest: {
      id: "PR_42",
      state: "OPEN",
      isDraft: false,
      headRefOid: "a".repeat(40),
      isMergeQueueEnabled: false,
    },
  },
};

const scene = async (
  options: {
    readonly data?: unknown;
    readonly failure?: boolean;
    readonly message?: string;
  } = {},
) => {
  const targets: Array<PullRequestWorkspaceTarget> = [];
  const calls: Array<ReadonlyArray<string>> = [];
  api = await createTenancyApi(
    {},
    {
      implement: {
        githubWorkspaces: {
          within: (target, use) => {
            targets.push(target);
            return use({
              kind: "short-lived",
              supportsAttachments: true,
              exec: (argv) => {
                calls.push(argv);
                const query = argv.find((arg) => arg.startsWith("query=")) ?? "";
                const data = query.includes("mutation")
                  ? query.includes("enablePullRequestAutoMerge")
                    ? { enablePullRequestAutoMerge: { pullRequest: { id: "PR_42" } } }
                    : { mergePullRequest: { pullRequest: { id: "PR_42" } } }
                  : query.includes("viewerMergeBodyText")
                    ? {
                        repository: {
                          pullRequest: {
                            viewerMergeBodyText: options.message,
                            headRefOid: "a".repeat(40),
                            isMergeQueueEnabled: false,
                          },
                        },
                      }
                    : (options.data ?? state);
                return Effect.succeed({
                  exitCode: options.failure ? 1 : 0,
                  stdout: JSON.stringify({ data }),
                  stderr: options.failure ? "private upstream detail" : "",
                });
              },
            });
          },
        },
      },
    },
  );
  const instance = api;
  return {
    api: instance,
    targets,
    calls,
    merge: (body: Readonly<Record<string, unknown>> = {}) =>
      instance.request("carol", "POST", `${ROOT}/merge`, { repository: "acme/app", ...body }),
  };
};

describe("an explicit pull request merge", () => {
  it("reports GitHub methods and the viewer's rights without merging", async () => {
    const world = await scene();
    const response = await world.api.request(
      "carol",
      "GET",
      `${ROOT}/merge-access?repository=acme/app`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      viewer: "Carol",
      canMerge: true,
      mergeMethods: ["merge", "squash", "rebase"],
    });
    expect(world.targets).toEqual([{ ownerUserId: "carol", sessionId: null }]);
    expect(world.calls).toHaveLength(1);
  });

  it.each(["merge", "squash", "rebase"])(
    "merges with the selected %s method as the caller",
    async (method) => {
      const world = await scene();
      const response = await world.merge({ method, expectedAccountId: "carol" });
      expect(response.status).toBe(204);
      expect(world.targets).toEqual([{ ownerUserId: "carol", sessionId: null }]);
      expect(world.calls).toHaveLength(2);
      expect(world.calls[1]).toContain(`method=${method.toUpperCase()}`);
      expect(world.calls[1]).toContain("id=PR_42");
      expect(world.calls[1]?.join(" ")).toContain("mergePullRequest");
      expect(world.api.world.calls.filter((call) => call.startsWith("engine."))).toEqual([]);
    },
  );

  it("uses the native auto-merge mutation when GitHub requires its merge queue", async () => {
    const world = await scene({
      data: {
        ...state,
        repository: {
          ...state.repository,
          pullRequest: { ...state.repository.pullRequest, isMergeQueueEnabled: true },
        },
      },
    });
    expect((await world.merge()).status).toBe(204);
    expect(world.calls[1]?.join(" ")).toContain("enablePullRequestAutoMerge");
  });

  it.each([
    [
      "read-only viewer",
      { ...state, repository: { ...state.repository, viewerPermission: "READ" } },
      {},
    ],
    [
      "disabled method",
      { ...state, repository: { ...state.repository, squashMergeAllowed: false } },
      { method: "squash" },
    ],
    ["changed account", state, { expectedAccountId: "alice" }],
    [
      "closed PR",
      {
        ...state,
        repository: {
          ...state.repository,
          pullRequest: { ...state.repository.pullRequest, state: "CLOSED" },
        },
      },
      {},
    ],
    [
      "draft PR",
      {
        ...state,
        repository: {
          ...state.repository,
          pullRequest: { ...state.repository.pullRequest, isDraft: true },
        },
      },
      {},
    ],
  ])("refuses %s before a mutation", async (_label, data, body) => {
    const world = await scene({ data });
    expect((await world.merge(body)).status).toBe(422);
    expect(world.calls).toHaveLength(1);
  });

  it("honours the native credit setting without removing quoted examples", async () => {
    const world = await scene({
      message:
        "Change\n\n```\nCo-authored-by: Claude <claude@anthropic.com>\n```\n\nCo-authored-by: Claude <claude@anthropic.com>\n",
    });
    expect((await world.merge({ method: "squash", removeAgentCredits: true })).status).toBe(204);
    expect(world.calls).toHaveLength(3);
    expect(world.calls[2]).toContain(
      "body=Change\n\n```\nCo-authored-by: Claude <claude@anthropic.com>\n```",
    );
    expect(world.calls[2]).toContain(`head=${"a".repeat(40)}`);
  });

  it("hides an inaccessible project before contacting GitHub", async () => {
    const world = await scene();
    const response = await world.api.request("dave", "POST", `${ROOT}/merge`, {
      repository: "acme/app",
    });
    expect(response.status).toBe(404);
    expect(world.targets).toEqual([]);
  });

  it("returns a plain refusal when GitHub fails, without leaking its streams", async () => {
    const world = await scene({ failure: true });
    const response = await world.merge();
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain("private upstream detail");
    expect(world.calls).toHaveLength(1);
  });
});
