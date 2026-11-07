import { PullRequestReadFailed } from "@mend/api-contracts";
import { PullRequestWorkspaces } from "@mend/landing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectPullRequests, ProjectPullRequestsLive } from "./project-pull-requests.ts";

const pr = {
  number: 123,
  title: "Fix login",
  body: "Observed change",
  url: "https://github.com/acme/api/pull/123",
  author: { login: "ada", avatarUrl: "https://example.test/ada.png" },
  headRefName: "fix-login",
  baseRefName: "main",
  headRefOid: "abc123",
  headRepository: { nameWithOwner: "ada/api" },
  state: "MERGED",
  isDraft: false,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-07T00:00:00Z",
  closedAt: "2026-11-07T00:00:00Z",
  mergedAt: "2026-11-07T00:00:00Z",
  mergeable: "UNKNOWN",
  reviewDecision: "APPROVED",
  viewerCanUpdate: false,
  labels: { nodes: [{ name: "bug", color: "ff0000" }] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "test",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  detailsUrl: "https://example.test/test",
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "PENDING",
                  description: "Building",
                  targetUrl: null,
                },
              ],
            },
          },
        },
      },
    ],
  },
};

describe("caller-owned PR reads", () => {
  it("reads only the caller's identity without searching repositories", async () => {
    const targets: Array<unknown> = [];
    const commands: Array<ReadonlyArray<string>> = [];
    const workspaces = Layer.succeed(PullRequestWorkspaces, {
      within: (target, use) => {
        targets.push(target);
        return use({
          kind: "short-lived",
          supportsAttachments: false,
          exec: (argv) => {
            commands.push(argv);
            return Effect.succeed({
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({ data: { viewer: { login: "ada" } } }),
            });
          },
        });
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProjectPullRequests).identity("ada-account");
      }).pipe(Effect.provide(ProjectPullRequestsLive.pipe(Layer.provide(workspaces)))),
    );
    expect(result).toEqual({ viewer: "ada" });
    expect(targets).toEqual([{ ownerUserId: "ada-account", sessionId: null }]);
    expect(commands).toEqual([["gh", "api", "graphql", "-f", "query=query { viewer { login } }"]]);
  });

  it("uses the caller's isolated workspace, decodes checks and keeps the host page cursor", async () => {
    const targets: Array<unknown> = [];
    const commands: Array<ReadonlyArray<string>> = [];
    const workspaces = Layer.succeed(PullRequestWorkspaces, {
      within: (target, use) => {
        targets.push(target);
        return use({
          kind: "short-lived",
          supportsAttachments: false,
          exec: (argv) => {
            commands.push(argv);
            return Effect.succeed({
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                data: {
                  viewer: { login: "ada" },
                  search: {
                    nodes: [pr],
                    pageInfo: { hasNextPage: true, endCursor: "next-page" },
                  },
                },
              }),
            });
          },
        });
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProjectPullRequests).list("ada-account", "acme/api", {
          query: "is:open",
          limit: 20,
          cursor: null,
        });
      }).pipe(Effect.provide(ProjectPullRequestsLive.pipe(Layer.provide(workspaces)))),
    );
    expect(targets).toEqual([{ ownerUserId: "ada-account", sessionId: null }]);
    expect(commands[0]?.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(commands[0]).toContain("search=repo:acme/api is:pr is:open");
    expect(result.cursor).toBe("next-page");
    expect(result.entries[0]).toMatchObject({
      state: "merged",
      headRepository: "ada/api",
      checks: [
        { name: "test", status: "success" },
        { name: "deploy", status: "pending" },
      ],
    });
  });

  it("reports malformed host responses as a typed read failure", async () => {
    const workspaces = Layer.succeed(PullRequestWorkspaces, {
      within: (_target, use) =>
        use({
          kind: "short-lived",
          supportsAttachments: false,
          exec: () => Effect.succeed({ exitCode: 0, stdout: "{}", stderr: "" }),
        }),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProjectPullRequests)
          .detail("ada-account", "acme/api", 123)
          .pipe(Effect.flip);
      }).pipe(Effect.provide(ProjectPullRequestsLive.pipe(Layer.provide(workspaces)))),
    );
    expect(result).toBeInstanceOf(PullRequestReadFailed);
  });

  it("refuses a truncated check result rather than reporting that every check passed", async () => {
    const workspaces = Layer.succeed(PullRequestWorkspaces, {
      within: (_target, use) =>
        use({
          kind: "short-lived",
          supportsAttachments: false,
          exec: () =>
            Effect.succeed({
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                data: {
                  viewer: { login: "ada" },
                  repository: {
                    pullRequest: {
                      ...pr,
                      commits: {
                        nodes: [
                          {
                            commit: {
                              statusCheckRollup: {
                                contexts: {
                                  nodes: [],
                                  pageInfo: { hasNextPage: true },
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
        }),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* ProjectPullRequests)
          .detail("ada-account", "acme/api", 123)
          .pipe(Effect.flip);
      }).pipe(Effect.provide(ProjectPullRequestsLive.pipe(Layer.provide(workspaces)))),
    );
    expect(result).toBeInstanceOf(PullRequestReadFailed);
    expect(result.message).toContain("more than 100 checks or labels");
  });
});
