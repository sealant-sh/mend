import { PullRequestStepError, type PullRequestWorkspaceTarget } from "@mend/landing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";

describe("project rename over HTTP", () => {
  it("renames a manageable project and refuses hidden projects, collisions and invalid names", async () => {
    const api = await createTenancyApi();
    try {
      const own = [...api.world.projects.values()].find((p) => p.name === "private-carol")?.id;
      if (own === undefined) throw new Error("fixture project missing");
      const renamed = await api.request("carol", "POST", `/api/projects/${own}/name`, {
        name: "renamed",
      });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id: own, name: "renamed" });
      const shared = [...api.world.projects.values()].find((p) => p.name === "shared-a")?.id;
      if (shared === undefined) throw new Error("fixture shared project missing");
      expect(
        (await api.request("carol", "POST", `/api/projects/${shared}/name`, { name: "stolen" }))
          .status,
      ).toBe(404);
      expect(
        (await api.request("bob", "POST", `/api/projects/${own}/name`, { name: "stolen" })).status,
      ).toBe(404);
      const duplicate = await api.request("carol", "POST", `/api/projects/${own}/name`, {
        name: "shared-a",
      });
      expect(duplicate.status).toBe(422);
      expect(
        (await api.request("carol", "POST", `/api/projects/${own}/name`, { name: "../bad" }))
          .status,
      ).toBe(422);
      expect(api.world.projects.get(own)?.name).toBe("renamed");
      const hiddenOwner = await api.request("alice", "POST", `/api/projects/${own}/name`, {
        name: "owner-renamed",
      });
      expect(hiddenOwner.status).toBe(404);
      const ownerRename = await api.request("alice", "POST", `/api/projects/${shared}/name`, {
        name: "owner-renamed",
      });
      expect(ownerRename.status).toBe(200);
      expect(await ownerRename.json()).toMatchObject({ id: shared, name: "owner-renamed" });
    } finally {
      await api.dispose();
    }
  });
});

describe("GitHub project lookup over HTTP", () => {
  it("uses each caller's connected workspace login and refuses malformed input before starting one", async () => {
    const targets: PullRequestWorkspaceTarget[] = [];
    const argv: ReadonlyArray<string>[] = [];
    let unavailable = false;
    const api = await createTenancyApi(
      {},
      {
        implement: {
          githubWorkspaces: {
            within: (target, use) => {
              targets.push(target);
              return unavailable
                ? Effect.fail(
                    new PullRequestStepError({
                      message: "No GitHub login connected for this person.",
                    }),
                  )
                : use({
                    kind: "short-lived",
                    supportsAttachments: false,
                    exec: (command) => {
                      argv.push(command);
                      return Effect.succeed({
                        exitCode: 0,
                        stderr: "",
                        stdout: JSON.stringify({
                          nameWithOwner: "alice/repo",
                          url: "https://github.com/alice/repo",
                          sshUrl: "git@github.com:alice/repo.git",
                          visibility: target.ownerUserId === "alice" ? "PRIVATE" : "PUBLIC",
                        }),
                      });
                    },
                  });
            },
          },
        },
      },
    );
    try {
      for (const user of ["alice", "carol"] as const) {
        const response = await api.request(user, "POST", "/api/github/repository", {
          repository: "https://github.com/alice/repo.git",
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          provider: "github",
          nameWithOwner: "alice/repo",
          cloneUrl:
            user === "alice" ? "git@github.com:alice/repo.git" : "https://github.com/alice/repo",
        });
      }
      expect(targets).toEqual([
        { ownerUserId: "alice", sessionId: null },
        { ownerUserId: "carol", sessionId: null },
      ]);
      expect(
        argv.every(
          (command) =>
            command.slice(-5).join(" ") ===
            "gh repo view alice/repo --json=nameWithOwner,url,sshUrl,visibility",
        ),
      ).toBe(true);
      expect(
        (await api.request("carol", "POST", "/api/github/repository", { repository: "--help" }))
          .status,
      ).toBe(422);
      expect(targets).toHaveLength(2);
      unavailable = true;
      const refused = await api.request("carol", "POST", "/api/github/repository", {
        repository: "alice/repo",
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        message: "No GitHub login connected for this person.",
      });
      expect(api.world.calls.some((call) => call.startsWith("gh."))).toBe(false);
    } finally {
      await api.dispose();
    }
  });
});
