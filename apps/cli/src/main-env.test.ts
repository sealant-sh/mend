import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();

const codexWords =
  "OPENAI_API_KEY is a Codex login, and Mend no longer takes it as a project secret. This one was stored before; rename or remove it, and connect your Codex login in Settings → Connected accounts.";

const secret = (name: string) => ({
  id: `secret-${name}`,
  projectId: "project-web",
  name,
  revision: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

describe("mend env show", spawning, () => {
  it("lists a secret stored under a provider login name with words to rename or remove it", async () => {
    const fake = await startFakeMend((request, response) => {
      switch (request.url) {
        case "/api/projects":
          json(response, [
            {
              id: "project-web",
              name: "web",
              originUrl: null,
              storePath: "/store/web",
              defaultBranch: "main",
              gitAuthMode: "mend-key",
            },
          ]);
          return;
        case "/api/projects/project-web/environment":
          json(response, { revision: 0, variables: [] });
          return;
        case "/api/projects/project-web/secrets":
          json(response, {
            revision: 2,
            secrets: [secret("OPENAI_API_KEY"), secret("STRIPE_API_KEY")],
          });
          return;
        case "/api/projects/project-web/cluster-bindings":
          json(response, {
            revision: 0,
            bindings: [],
            serviceAccount: null,
            clusterCapable: false,
          });
          return;
        default:
          response.statusCode = 404;
          response.end();
      }
    });
    try {
      const cli = startCli(fake.url, ["env", "show", "--project", "web"]);
      const exit = await cli.exited;
      expect(exit.code, cli.stderr()).toBe(0);
      expect(cli.stdout()).toBe(
        [
          "web · configuration r0 · secrets r2 · cluster r0",
          "  OPENAI_API_KEY  secret · value set, never shown",
          `                  ${codexWords}`,
          "  STRIPE_API_KEY  secret · value set, never shown",
          "",
        ].join("\n"),
      );
    } finally {
      await fake.close();
    }
  });
});
