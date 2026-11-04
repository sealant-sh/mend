import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();

describe("actionable JSON refusals", spawning, () => {
  it.each([
    ["StoreFailure", 'A project named "mend" already exists.', "project_name_taken", "--name"],
    [
      "StoreFailure",
      "Could not clone origin: Permission denied (publickey).",
      "clone_failed",
      "deploy key",
    ],
    [
      "SourceRefused",
      "This source host is not allowed by the instance policy.",
      "SourceRefused",
      "source",
    ],
  ])("preserves the safe cause and recovery for %s %s", async (tag, message, code, fix) => {
    const fake = await startFakeMend((_req, res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          _tag: tag,
          message,
          token: "private-server-sentinel",
          details: "private-server-sentinel",
        }),
      );
    });
    try {
      const cli = startCli(fake.url, ["adopt", "git@github.com:acme/mend.git", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 1 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "failed",
        error: { code, message, fix: expect.stringContaining(fix) },
      });
      expect(cli.stdout() + cli.stderr()).not.toContain("private-server-sentinel");
    } finally {
      await fake.close();
    }
  });

  it("names an explicit unknown project rather than suggesting the same flag", async () => {
    const fake = await startFakeMend((_req, res) => json(res, []));
    try {
      const cli = startCli(fake.url, ["git", "check", "--project", "missing", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 2 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        error: {
          code: "project_not_found",
          message: expect.stringContaining("missing"),
          fix: expect.stringContaining("mend projects"),
        },
      });
    } finally {
      await fake.close();
    }
  });

  it("preserves a transport reason and gives network recovery without promising a key fix", async () => {
    const fake = await startFakeMend((req, res) => {
      if (req.url === "/api/projects") return json(res, [{ id: "project", name: "mend" }]);
      if (req.url === "/api/keys/git")
        return json(res, { publicKey: "ssh-ed25519 public", fingerprint: "SHA256:public" });
      json(res, {
        read: {
          state: "failed",
          detail:
            "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
        },
        push: { state: "failed", detail: "Git access check timed out after 60 seconds." },
        observedAt: "now",
      });
    });
    try {
      const cli = startCli(fake.url, ["git", "check", "--project", "mend", "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 4 });
      const result = JSON.parse(cli.stdout());
      expect(result.items[0].detail).toContain("Could not resolve hostname");
      expect(result.items[0].fix).toContain("DNS");
      expect(result.items[1].fix).toContain("timeout");
      expect(result.items.map((item: { fix: string }) => item.fix).join(" ")).not.toContain(
        "deploy key",
      );
    } finally {
      await fake.close();
    }
  });
});
