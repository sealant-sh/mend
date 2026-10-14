import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  sessionId,
  session,
  command,
  json,
  logPage,
  startFake,
  entrypoint,
  cliEnv,
  runCli,
  attemptId,
  serviceAttempt,
  serviceView,
  otherAttempt,
  services,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("a Service's process id", spawning, () => {
  it("mend service list prints the current attempt's process id, in JSON too", async () => {
    const fake = await startFake((route, _request, response) => {
      if (!services(route, response)) response.writeHead(404).end();
    });
    try {
      const table = await runCli(fake.url, ["service", "list"]);
      expect(table.code, table.stderr).toBe(0);
      expect(table.stdout).toContain("service service- · process 9f8e7d6c");
      const listed = await runCli(fake.url, ["service", "list", "--json"]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual({
        version: 1,
        services: [
          {
            id: "service-1",
            name: "web",
            sessionId,
            processId: attemptId,
            status: "reachable",
            workspacePort: 3000,
            protocol: "tcp",
            hostPort: null,
            authority: null,
            browserUrl: null,
          },
        ],
      });
    } finally {
      await fake.close();
    }
  });

  it("mend logs --service and --process <service> read the current attempt's record", async () => {
    const fake = await startFake((route, _request, response) => {
      if (services(route, response)) return;
      if (route === `GET /api/sessions/${sessionId}`) {
        json(response, { session, currentAgent: command, processes: [command] });
      } else if (route.startsWith(`GET /api/processes/${attemptId}/logs?from=0&`)) {
        json(response, {
          ...logPage("1", "running", "listening on :3000\n"),
          processId: attemptId,
        });
      } else if (route.startsWith(`GET /api/processes/${attemptId}/logs?from=1&`)) {
        json(response, { ...logPage("1", "running"), processId: attemptId });
      } else response.writeHead(404).end();
    });
    try {
      const byName = await runCli(fake.url, ["logs", "--service", "web"]);
      expect(byName.code, byName.stderr).toBe(0);
      expect(byName.stdout).toBe("listening on :3000\n");
      const byServiceId = await runCli(fake.url, ["logs", sessionId, "--process", "service-1"]);
      expect(byServiceId.code, byServiceId.stderr).toBe(0);
      expect(byServiceId.stdout).toBe("listening on :3000\n");
    } finally {
      await fake.close();
    }
  });

  it("mend logs takes a Service by its full id before one named like that id, and refuses a name two carry", async () => {
    const fullId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const wanted = {
      ...serviceView("reachable"),
      service: { ...serviceView("reachable").service, id: fullId, name: "wanted" },
    };
    const impostorView = serviceView("reachable", [serviceAttempt(otherAttempt)]);
    const impostor = {
      ...impostorView,
      service: {
        ...impostorView.service,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: fullId,
      },
    };
    const twinView = serviceView("reachable", [serviceAttempt(otherAttempt)]);
    const twin = { ...twinView, service: { ...twinView.service, id: "service-2" } };
    let listed: ReadonlyArray<unknown> = [impostor, wanted];
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/services?all=1") json(response, listed);
      else if (route === `GET /api/sessions/${sessionId}`) {
        json(response, { session, currentAgent: command, processes: [command] });
      } else if (route.startsWith("GET /api/processes/")) {
        const processId = route.includes(attemptId) ? attemptId : otherAttempt;
        const text = processId === attemptId ? "wanted\n" : "wrong-process\n";
        const first = route.includes("logs?from=0&");
        json(response, { ...logPage("1", "exited", ...(first ? [text] : [])), processId });
      } else response.writeHead(404).end();
    });
    try {
      const byService = await runCli(fake.url, ["logs", "--service", fullId]);
      expect(byService.code, byService.stderr).toBe(0);
      expect(byService.stdout).toBe("wanted\n");
      const byProcess = await runCli(fake.url, ["logs", sessionId, "--process", fullId]);
      expect(byProcess.code, byProcess.stderr).toBe(0);
      expect(byProcess.stdout).toBe("wanted\n");

      listed = [serviceView("reachable"), twin];
      const ambiguous = await runCli(fake.url, ["logs", "--service", "web"]);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toContain(
        '"web" names 2 Services · name one by its id: service-1 (session 0c9f7e1a), service-2 (session 0c9f7e1a)',
      );
      expect(fake.routes.some((route) => route.includes(`/processes/${otherAttempt}/`))).toBe(
        false,
      );
    } finally {
      await fake.close();
    }
  });

  it("a reader that closes the pipe early (| head -1) ends mend quietly, exit 0, for any command", async () => {
    // Far more than a pipe holds: head takes one line and closes, and mend's next write meets
    // EPIPE.
    const many = Array.from({ length: 3000 }, (_, index) => {
      const view = serviceView("reachable");
      return {
        ...view,
        service: { ...view.service, id: `service-${index}`, name: `web-${index}` },
      };
    });
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/services") json(response, many);
      else response.writeHead(404).end();
    });
    try {
      for (const args of [
        ["service", "list"],
        ["service", "list", "--json"],
      ]) {
        const child = spawn(
          "bash",
          [
            "-c",
            'set -o pipefail; "$0" --experimental-strip-types "$1" "${@:2}" | head -1 >/dev/null',
            process.execPath,
            entrypoint,
            ...args,
          ],
          { env: cliEnv(fake.url), stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir() },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const [code] = await once(child, "close");
        expect({ args, code, stderr }).toEqual({ args, code: 0, stderr: "" });
      }
    } finally {
      await fake.close();
    }
  });

  it("mend logs --service refuses a Service with no attempt yet", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/services?all=1") json(response, [serviceView("reachable", [])]);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["logs", "--service", "web"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Service web has no attempt yet");
      expect(fake.routes.some((route) => route.includes("/processes/"))).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
