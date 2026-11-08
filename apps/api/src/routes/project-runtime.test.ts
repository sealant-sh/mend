import { Sha } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { makeProject } from "../../test/support/tenancy-harness.ts";

describe("adopted projects' runtime defaults", () => {
  for (const runtime of ["docker", "boat"] as const) {
    it(`uses ${runtime === "boat" ? "Ubuntu" : "the inherited environment"} on ${runtime}`, async () => {
      const api = await createTenancyApi(
        {},
        {
          sessionRuntime: runtime,
          implement: {
            store: {
              adopt: () =>
                Effect.succeed({
                  storePath: "/owned/probe/repo.git",
                  defaultBranch: "main",
                  headSha: Sha.make("a".repeat(40)),
                }),
            },
            gitAccess: { mode: () => Effect.succeed(null) },
            projects: {
              create: (input) => Effect.succeed(new Project({ ...makeProject(input), ...input })),
            },
          },
        },
      );
      try {
        const response = await api.request("alice", "POST", "/api/projects", {
          name: `runtime-${runtime}`,
          source: "https://example.com/repo.git",
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body).toMatchObject({
          workspaceImage:
            runtime === "boat"
              ? { mode: "family", os: "ubuntu", services: { docker: false } }
              : null,
        });
      } finally {
        await api.dispose();
      }
    });
  }
});
