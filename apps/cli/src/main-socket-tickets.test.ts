import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { project, session, json, spawning, startCli, startFakeMend } = mainTestFixtures();

describe("socket ticket support discovery", spawning, () => {
  it.each([
    "http-error",
    "malformed",
    "null",
    "array",
    "empty-object",
    "disconnect",
    "modern",
    "legacy",
  ])("mint 404 with %s health only permits an observed legacy socket", async (kind) => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      auth: string | undefined;
    }> = [];
    const fake = await startFakeMend(
      (request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
        });
        if (request.url?.startsWith("/api/sessions?retained") === true) json(response, [session]);
        else if (request.url === "/api/projects") json(response, [project]);
        else if (request.url === "/api/upgrade-tickets") response.writeHead(404).end();
        else if (request.url === "/api/health") {
          if (kind === "disconnect") request.socket.destroy();
          else if (kind === "http-error") response.writeHead(502).end();
          else if (kind === "malformed") response.writeHead(200).end("not JSON");
          else
            json(
              response,
              kind === "legacy"
                ? { status: "ok" }
                : kind === "modern"
                  ? { status: "ok", upgradeTickets: true }
                  : kind === "null"
                    ? null
                    : kind === "array"
                      ? []
                      : {},
            );
        } else response.writeHead(404).end();
      },
      "end",
      false,
    );
    const token = "synthetic-discovery-token";
    const cli = startCli(fake.url, ["attach"], { MEND_TOKEN: token });
    try {
      const exit = await cli.exited;
      expect(requests.filter((r) => r.url === "/api/upgrade-tickets")).toEqual([
        { method: "POST", url: "/api/upgrade-tickets", auth: `Bearer ${token}` },
      ]);
      expect(requests.filter((r) => r.url === "/api/health")).toEqual([
        { method: "GET", url: "/api/health", auth: undefined },
      ]);
      expect(cli.stdout() + cli.stderr()).not.toContain(token);
      if (kind === "legacy") {
        expect(exit.code, cli.stderr()).toBe(0);
        expect(fake.upgradeUrls()).toEqual([
          `/api/tty?session=${session.id}&from=0&token=${token}`,
        ]);
        expect(cli.stderr()).toContain("predates upgrade tickets");
      } else {
        expect(exit.code, cli.stdout() + cli.stderr()).toBe(1);
        expect(fake.upgradeUrls()).toEqual([]);
        expect(cli.stderr()).not.toContain("predates upgrade tickets");
      }
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  });
});
