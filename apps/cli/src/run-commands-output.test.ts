import { once } from "node:events";
import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  project,
  session,
  command,
  ended,
  logPage,
  startFake,
  spawnCli,
  runCli,
  launchRoutes,
  chunkOf,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("review of mend#610", spawning, () => {
  it("delivers every byte of 4 MiB of output to a slow reader, then exits with the code", async () => {
    const pages = 256;
    let logsDone = false;
    const secondPage = Promise.withResolvers<void>();
    const fake = await startFake(
      launchRoutes(
        () => ({ session, currentAgent: logsDone ? ended(0) : command, processes: [command] }),
        (from) => {
          const index = Number(from);
          if (index === 1) secondPage.resolve();
          if (index >= pages) {
            logsDone = true;
            return logPage(String(pages), "exited");
          }
          return {
            ...logPage(String(index + 1), index + 1 < pages ? "running" : "exited"),
            chunks: [{ sequence: from, dataBase64: chunkOf(index).toString("base64") }],
          };
        },
      ),
    );
    const child = spawnCli(fake.url, ["run", "--project", project.name, "--", "generate"]);
    // Nothing is read until the CLI has asked for its second page: the pipe is full meanwhile.
    child.stdout.pause();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = once(child, "close");
    try {
      await secondPage.promise;
      // Then a slow reader, 20 ms a read: the CLI must wait for it, however long it takes. (It
      // paces the reader; nothing here measures the CLI.)
      const received: Array<Buffer> = [];
      child.stdout.on("data", (chunk: Buffer) => {
        received.push(chunk);
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 20);
      });
      child.stdout.resume();
      const [code] = await closed;
      const output = Buffer.concat(received);
      expect(output.length, stderr).toBe(pages * 16 * 1024);
      expect(
        output.equals(Buffer.concat(Array.from({ length: pages }, (_, i) => chunkOf(i)))),
      ).toBe(true);
      expect(code, stderr).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("fails the run when output could not be delivered, and says the command's own code", async () => {
    let failed = false;
    const fake = await startFake((route, request, response) => {
      if (route.startsWith(`GET /api/processes/${command.id}/logs?from=1&`)) {
        failed = true;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "record store unavailable" }));
        return;
      }
      launchRoutes(
        () => ({ session, currentAgent: failed ? ended(0) : command, processes: [command] }),
        () => logPage("1", "running", "first page\n"),
      )(route, request, response);
    });
    try {
      const result = await runCli(fake.url, ["run", "--project", project.name, "--", "make"]);
      expect(result.stdout).toBe("first page\n");
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("exited · code 0 · recorded");
      expect(result.stderr).toContain("output not delivered · record store unavailable");
    } finally {
      await fake.close();
    }
  });
});
