import { REMOVED_PROJECT_WORK_REFUSED } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();

const ALREADY = "api was already purged on 2026-10-30. Nothing is left to delete.";

describe("mend projects against a removed or purged project", spawning, () => {
  it("prints the server's words for a purge already done and exits 0", async () => {
    const requests: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      if (request.url?.startsWith("/api/") === true)
        requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url === "/api/removed-projects/p1/purge")
        json(response, { id: "p1", purged: true, alreadyPurged: true, message: ALREADY });
      else response.writeHead(404).end();
    });
    try {
      const cli = startCli(fake.url, ["projects", "purge", "p1", "--confirm", "api"]);
      const { code } = await cli.exited;
      expect({ code, stdout: cli.stdout(), requests }).toEqual({
        code: 0,
        stdout: `${ALREADY}\n`,
        requests: ["POST /api/removed-projects/p1/purge"],
      });
    } finally {
      await fake.close();
    }
  });

  it("prints the words that say to restore a removed project, and fails", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.method === "DELETE" && request.url === "/api/projects/p1") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ _tag: "RemovalInProgress", message: REMOVED_PROJECT_WORK_REFUSED }),
        );
      } else response.writeHead(404).end();
    });
    try {
      const cli = startCli(fake.url, ["projects", "rm", "p1"]);
      const { code } = await cli.exited;
      expect({ code, stderr: cli.stderr() }).toEqual({
        code: 1,
        stderr: `mend: ${REMOVED_PROJECT_WORK_REFUSED}\n`,
      });
    } finally {
      await fake.close();
    }
  });
});
