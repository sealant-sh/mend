import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures, type HttpHandler } from "./main-test-fixtures.ts";

const { startCli, startFakeMend, json, project, session, spawning } = mainTestFixtures();
const codex = {
  id: "codex-login",
  provider: "codex",
  name: "default",
  isDefault: true,
  status: "active",
  metadata: {},
};
const server =
  (accounts: ReadonlyArray<unknown> = [codex], push = true): HttpHandler =>
  (request, response) => {
    if (request.url === "/api/health") json(response, { status: "ok", version: "fixture" });
    else if (request.url === "/api/projects") json(response, [project]);
    else if (request.url === "/api/sealant/connection")
      json(response, { status: "connected", baseUrl: "http://fake-platform", detail: null });
    else if (request.url === "/api/me/sealant") json(response, { accounts });
    else if (request.url === `/api/projects/${project.id}/git/check`)
      json(response, {
        read: { state: "ok", detail: "read succeeded" },
        push: {
          state: push ? "ok" : "failed",
          detail: push ? "push succeeded" : "ssh: Could not resolve hostname git.example.test",
        },
        observedAt: "2026-11-04T00:00:00Z",
      });
    else if (request.url === "/api/keys/git")
      json(response, { publicKey: null, fingerprint: null });
    else response.writeHead(404).end();
  };

describe("remote agent readiness", spawning, () => {
  it.each([null, "codex", "pi"])(
    "accepts a server Codex login with no local credentials, harness %s",
    async (harness) => {
      const fake = await startFakeMend(server());
      try {
        const cli = startCli(
          fake.url,
          [
            "doctor",
            "--project",
            project.id,
            ...(harness === null ? [] : ["--harness", harness]),
            "--json",
          ],
          { MEND_TOKEN: "fake-mend-login" },
        );
        expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
        const result = JSON.parse(cli.stdout());
        expect(result).toMatchObject({ v: 1, status: "done" });
        expect(result.data.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: "codex", state: "ok" }),
            expect.objectContaining({ id: "claude", state: "info", fix: "mend connect claude" }),
            expect.objectContaining({ id: "github", state: "info" }),
            expect.objectContaining({ id: "claude_cli", state: "info" }),
            expect.objectContaining({ id: "codex_cli", state: "info" }),
            expect.objectContaining({ id: "git", state: "ok" }),
          ]),
        );
        expect(cli.stderr()).toBe("");
        expect(cli.stdout()).not.toContain("fake-mend-login");
      } finally {
        await fake.close();
      }
    },
  );

  it.each(["claude", null])(
    "requires the chosen server login, or at least one when unspecified, %s",
    async (harness) => {
      const fake = await startFakeMend(server(harness === null ? [] : [codex]));
      try {
        const cli = startCli(
          fake.url,
          [
            "doctor",
            "--project",
            project.id,
            ...(harness === null ? [] : ["--harness", harness]),
            "--json",
          ],
          { MEND_TOKEN: "fake-mend-login" },
        );
        expect(await cli.exited).toEqual({ kind: "exit", code: 4 });
        expect(JSON.parse(cli.stdout())).toMatchObject({
          v: 1,
          status: "not_ready",
          items: expect.arrayContaining([
            expect.objectContaining({
              id: harness ?? "harness",
              state: "todo",
              fix: expect.stringContaining("connect"),
            }),
          ]),
        });
        expect(cli.stderr()).toBe("");
      } finally {
        await fake.close();
      }
    },
  );

  it("keeps the Git transport reason and its DNS fix as a blocker", async () => {
    const fake = await startFakeMend(server([codex], false));
    try {
      const cli = startCli(
        fake.url,
        ["doctor", "--harness", "codex", "--project", project.id, "--json"],
        { MEND_TOKEN: "fake-mend-login" },
      );
      expect(await cli.exited).toEqual({ kind: "exit", code: 4 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "not_ready",
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "git_push",
            state: "failed",
            detail: expect.stringContaining("Could not resolve"),
            fix: expect.stringContaining("DNS"),
          }),
        ]),
      });
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });
});

describe("agent lists and local commands", spawning, () => {
  it("uses v1 for populated sessions and for an unknown project", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") json(response, [project]);
      else if (request.url === "/api/sessions") json(response, [session]);
      else response.writeHead(404).end();
    });
    try {
      const list = startCli(fake.url, ["sessions", "--json"]);
      expect(await list.exited).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(list.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { sessions: [expect.objectContaining({ id: session.id })] },
      });
      const unknown = startCli(fake.url, ["sessions", "--project", "missing", "--json"]);
      expect(await unknown.exited).toEqual({ kind: "exit", code: 2 });
      expect(JSON.parse(unknown.stdout())).toMatchObject({
        v: 1,
        status: "usage",
        error: { code: "project_not_found" },
      });
      expect(list.stderr() + unknown.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("forgets the local sign-in even when server revocation fails, and reports both", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-agent-logout-"));
    const config = path.join(home, "mend", "cli.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    const fake = await startFakeMend((_request, response) => response.writeHead(503).end());
    fs.writeFileSync(
      config,
      JSON.stringify({ url: fake.url, token: "fake-private-token", deviceId: "fake-device" }),
    );
    try {
      const cli = startCli(fake.url, ["logout", "--json"], { XDG_CONFIG_HOME: home });
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "failed",
        data: { signedOut: true, revocation: "unconfirmed" },
        error: { fix: expect.stringContaining("Settings > Devices") },
      });
      expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({
        token: null,
        deviceId: null,
      });
      expect(cli.stdout() + cli.stderr()).not.toContain("fake-private-token");
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
