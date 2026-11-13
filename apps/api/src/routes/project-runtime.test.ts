import { type SessionRuntime, SessionRuntimeOffer, Sha } from "@mend/domain";
import { Project } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import {
  type HarnessUser,
  makeProject,
  organizationIdOf,
} from "../../test/support/tenancy-harness.ts";

const adoptingApi = (options: {
  readonly sessionRuntime?: SessionRuntime;
  readonly sessionRuntimes?: SessionRuntimeOffer;
  readonly organizationRuntimes?: ReadonlyMap<string, SessionRuntime>;
}) =>
  createTenancyApi(
    {},
    {
      ...options,
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

describe("adopted projects' runtime defaults", () => {
  /**
   * SLNT-794: on a server that offers both, the adopting organization's choice decides: a project
   * adopted in an organization on Boat starts on Ubuntu, one in another organization does not.
   */
  it("follows the adopting organization's choice on a server that offers both", async () => {
    const api = await adoptingApi({
      sessionRuntimes: new SessionRuntimeOffer({ offered: ["docker", "boat"], default: "docker" }),
      organizationRuntimes: new Map([[organizationIdOf("A"), "boat"]]),
    });
    try {
      const adopt = async (user: HarnessUser, name: string) => {
        const response = await api.request(user, "POST", "/api/projects", {
          name,
          source: "https://example.com/repo.git",
        });
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(200);
        return body;
      };
      await expect(adopt("alice", "on-boat")).resolves.toMatchObject({
        workspaceImage: { mode: "family", os: "ubuntu" },
      });
      await expect(adopt("bob", "on-docker")).resolves.toMatchObject({ workspaceImage: null });
    } finally {
      await api.dispose();
    }
  });

  for (const runtime of ["docker", "boat"] as const) {
    it(`uses ${runtime === "boat" ? "Ubuntu" : "the inherited environment"} on ${runtime}`, async () => {
      const api = await adoptingApi({ sessionRuntime: runtime });
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
              ? { mode: "family", os: "ubuntu", services: { docker: true } }
              : null,
        });
      } finally {
        await api.dispose();
      }
    });
  }
});
