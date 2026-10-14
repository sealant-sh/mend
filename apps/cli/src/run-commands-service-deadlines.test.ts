import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const { spawning, compileCache, sessionId, session, json, startFake, runCli, stall, serviceView } =
  runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("--json and --wait", spawning, () => {
  it("mend service run --wait counts its deadline from the first request, the session lookup", async () => {
    const lookup = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") stall(response);
      else response.writeHead(404).end();
    });
    const recipes = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `GET /api/sessions/${sessionId}/recipes`) stall(response);
      else response.writeHead(404).end();
    });
    try {
      const env = { MEND_SERVICE_WAIT_MS: "500" };
      const explicit = await runCli(
        lookup.url,
        ["service", "run", sessionId.slice(0, 8), "--port", "3000", "--wait", "--", "pnpm", "dev"],
        env,
      );
      expect(explicit.code, explicit.stderr).toBe(124);
      expect(lookup.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
      const declared = await runCli(
        recipes.url,
        ["service", "run", sessionId.slice(0, 8), "web", "--wait"],
        env,
      );
      expect(declared.code, declared.stderr).toBe(124);
      expect(recipes.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
    } finally {
      await lookup.close();
      await recipes.close();
    }
  });

  it("mend service run --wait against a remote server returns once it answered, with no tunnel", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === "GET /api/services?all=1") json(response, []);
      else if (route === `POST /api/sessions/${sessionId}/services/run`) {
        json(response, serviceView("reachable"));
      } else response.writeHead(404).end();
    }, "127.0.0.2");
    try {
      const result = await runCli(fake.url, [
        "service",
        "run",
        sessionId.slice(0, 8),
        "--port",
        "3000",
        "--wait",
        "--",
        "pnpm",
        "dev",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain("connect: mend service connect web");
      expect(fake.routes.some((route) => route.includes("upgrade"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait refuses a recipe with no command, before anything starts", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `GET /api/sessions/${sessionId}/recipes`) {
        json(response, [
          {
            name: "web",
            command: null,
            port: 3000,
            protocol: "tcp",
            browserScheme: "http",
            shadowedBy: null,
          },
        ]);
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, [
        "service",
        "run",
        sessionId.slice(0, 8),
        "web",
        "--wait",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "--wait needs a command Mend starts: web declares only a port",
      );
      expect(fake.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait gives up on a start the server never answers, with 124", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === "GET /api/services?all=1") json(response, []);
      else if (route === `POST /api/sessions/${sessionId}/services/run`) {
        // An answer that starts and never finishes: headers, then nothing.
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(
        fake.url,
        ["service", "run", sessionId.slice(0, 8), "--port", "3000", "--wait", "--", "pnpm", "dev"],
        { MEND_SERVICE_WAIT_MS: "1000" },
      );
      expect(result.code, result.stderr).toBe(124);
      expect(result.stderr).toContain(
        "pnpm · still starting after 1 s · :3000 has not answered · the start request has not returned · the Service keeps starting",
      );
    } finally {
      await fake.close();
    }
  });
});
