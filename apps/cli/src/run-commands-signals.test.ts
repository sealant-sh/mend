import { once } from "node:events";
import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  project,
  sessionId,
  session,
  command,
  json,
  logPage,
  startFake,
  launchRoutes,
  MODES,
  python,
  onPty,
  expectTerminalPutBack,
  stuckReaderRun,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("review of mend#610", spawning, () => {
  it("a stuck reader cannot hold a signal off: SIGINT exits 130 within the flush grace", async () => {
    const { fake, child, stuck, stderr } = await stuckReaderRun();
    try {
      await stuck;
      child.kill("SIGINT");
      const [code] = await once(child, "close");
      expect(code, stderr()).toBe(130);
      expect(stderr()).toContain("stopped watching · the command keeps running");
      expect(stderr()).toMatch(/mend stop [0-9a-z-]{8} ends it/);
      expect(stderr()).toContain("output may be incomplete");
    } finally {
      child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("a second signal exits at once, whatever the reader does", async () => {
    const { fake, child, stuck, stderr } = await stuckReaderRun();
    try {
      await stuck;
      child.kill("SIGINT");
      while (!stderr().includes("stopped watching")) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      child.kill("SIGTERM");
      const [code] = await once(child, "close");
      expect(code, stderr()).toBe(143);
      expect(stderr()).not.toContain("output may be incomplete");
    } finally {
      child.kill("SIGKILL");
      await fake.close();
    }
  });

  it.skipIf(!python)(
    "puts a terminal back when Ctrl+C stops watching output that set its modes",
    async () => {
      const fake = await startFake(
        launchRoutes(
          () => ({ session, currentAgent: command, processes: [command] }),
          (from) => (from === "0" ? logPage("1", "running", MODES) : logPage("1", "running")),
        ),
      );
      try {
        const { code, terminal } = await onPty(fake.url, [
          "run",
          "--project",
          project.name,
          "--",
          "top",
        ]);
        expect(code, terminal).toBe("130");
        expectTerminalPutBack(terminal);
        expect(terminal).toContain("stopped watching · the command keeps running");
      } finally {
        await fake.close();
      }
    },
  );

  it.skipIf(!python)(
    "puts a terminal back when Ctrl+C stops a plain mend logs mid-read",
    async () => {
      const fake = await startFake((route, _request, response) => {
        if (route === `GET /api/sessions/${sessionId}`) {
          json(response, { session, currentAgent: command, processes: [command] });
        } else if (route.startsWith(`GET /api/processes/${command.id}/logs?from=0&`)) {
          json(response, logPage("1", "running", MODES));
        } else if (route.startsWith(`GET /api/processes/${command.id}/logs?from=1&`)) {
          // The next page never comes: the read is in flight when Ctrl+C arrives.
          response.writeHead(200, { "content-type": "application/json" });
        } else response.writeHead(404).end();
      });
      try {
        const { code, terminal } = await onPty(fake.url, ["logs", sessionId]);
        expect(code, terminal).toBe("130");
        expectTerminalPutBack(terminal);
      } finally {
        await fake.close();
      }
    },
  );
});
