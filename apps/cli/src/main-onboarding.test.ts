import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { project, json, spawning, startCli, startFakeMend } = mainTestFixtures();

describe("agent onboarding through a non-TTY shell", spawning, () => {
  it.each([
    { args: ["server", "setup", "--json"], code: "needs_input" },
    { args: ["connect", "claude", "--json"], code: "needs_input" },
    { args: ["connect", "codex", "--json"], code: "needs_input" },
    { args: ["adopt", "--json", "--unknown"], code: "usage" },
    { args: ["doctor", "--json", "--bundle"], code: "usage" },
    { args: ["server", "setup", "--json", "--yes", "--timeout", "wrong"], code: "usage" },
  ])("$args returns usage without a prompt or a server request", async ({ args, code }) => {
    const requests: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(500).end();
    });
    try {
      const cli = startCli(fake.url, args);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 2 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "usage",
        error: { code, message: expect.any(String), fix: expect.any(String) },
      });
      expect(requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("returns a project receipt and never starts an optional setup session", async () => {
    const requests: Array<string> = [];
    const fake = await startFakeMend((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      json(response, { ...project, gitAuthMode: "mend-key", token: "must-not-print" });
    });
    try {
      const cli = startCli(fake.url, ["adopt", "https://github.com/acme/repo.git", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toEqual({
        v: 1,
        status: "done",
        data: {
          project: {
            id: project.id,
            name: project.name,
            defaultBranch: "main",
            gitAuthMode: "mend-key",
          },
        },
      });
      expect(requests).toEqual(["POST /api/projects"]);
      expect(cli.stdout()).not.toContain("must-not-print");
    } finally {
      await fake.close();
    }
  });

  it("uploads a piped credential while omitting it and arbitrary metadata from output", async () => {
    const secret = "fixture-private-value-not-a-known-token-shape";
    let received = "";
    const fake = await startFakeMend((request, response) => {
      void (async () => {
        for await (const chunk of request) received += String(chunk);
        json(response, {
          id: "account",
          provider: "claude",
          name: "work",
          status: "active",
          metadata: { secret },
        });
      })();
    });
    try {
      const cli = startCli(
        fake.url,
        ["connect", "claude", "--from-stdin", "--json"],
        {},
        undefined,
        secret,
      );
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(received)).toMatchObject({ provider: "claude", secret });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { account: { id: "account", name: "work", status: "active" } },
      });
      expect(cli.stdout() + cli.stderr()).not.toContain(secret);
    } finally {
      await fake.close();
    }
  });

  it("does not repeat a rejected upload's response body", async () => {
    const secret = "fixture-upload-secret";
    const fake = await startFakeMend((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: secret }));
    });
    try {
      const cli = startCli(
        fake.url,
        ["connect", "claude", "--from-stdin", "--json"],
        {},
        undefined,
        secret,
      );
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "failed",
        error: { code: "request_refused", fix: expect.any(String) },
      });
      expect(cli.stdout() + cli.stderr()).not.toContain(secret);
    } finally {
      await fake.close();
    }
  });

  it("reports pi's login separately from its saved profile and refuses an unchosen default", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/me/pi-profile") return json(response, { profile: { revision: 2 } });
      json(response, {
        accounts: [
          { id: "c1", provider: "claude", name: "work", isDefault: false, status: "active" },
          { id: "c2", provider: "claude", name: "home", isDefault: false, status: "active" },
          { id: "x", provider: "codex", name: "chosen", isDefault: true, status: "active" },
        ],
      });
    });
    try {
      const cli = startCli(fake.url, ["connect", "status", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 4 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "not_ready",
        data: {
          providers: [
            { provider: "claude", connected: false, selection: "unchosen" },
            { provider: "codex", connected: true },
            { provider: "pi", connected: true, profileSaved: true },
          ],
        },
      });
    } finally {
      await fake.close();
    }
  });

  it("reports Git observations and only the public deploy key when push is unfinished", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") return json(response, [project]);
      if (request.url === "/api/keys/git")
        return json(response, {
          publicKey: "ssh-ed25519 PUBLIC",
          fingerprint: "SHA256:public",
          privateKey: "must-not-print",
        });
      json(response, {
        read: { state: "ok", method: "ls-remote", detail: "Refs readable." },
        push: { state: "failed", method: "push-dry-run", detail: "Dry-run refused." },
        observedAt: "2026-11-04T00:00:00Z",
      });
    });
    try {
      const cli = startCli(fake.url, ["git", "check", "--project", project.id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 4 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "not_ready",
        data: {
          deployKey: { publicKey: "ssh-ed25519 PUBLIC" },
          observedAt: "2026-11-04T00:00:00Z",
        },
      });
      expect(cli.stdout()).not.toContain("must-not-print");
    } finally {
      await fake.close();
    }
  });

  it("reports todo doctor items as unfinished instead of ready", async () => {
    const cli = startCli("http://127.0.0.1:9", ["doctor", "--json"]);
    expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 4 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      v: 1,
      status: "not_ready",
      data: { items: expect.any(Array) },
      error: { code: "not_ready" },
    });
  });

  it("reports corrupt configuration without exposing its contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-agent-config-"));
    fs.mkdirSync(path.join(root, "mend"));
    fs.writeFileSync(path.join(root, "mend", "cli.json"), "private-sentinel invalid JSON");
    try {
      const cli = startCli("http://127.0.0.1:9", ["connect", "status", "--json"], {
        XDG_CONFIG_HOME: root,
      });
      expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        error: { code: "config_unreadable" },
      });
      expect(cli.stdout() + cli.stderr()).not.toContain("private-sentinel");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
