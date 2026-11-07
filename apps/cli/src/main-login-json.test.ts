import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend, waitFor } = mainTestFixtures();
const opened = {
  deviceCode: "private-device-sentinel",
  code: "ABCDEFGH",
  verifyPath: "/authorize?code=ABCDEFGH",
  expiresAt: "2099-01-01T00:00:00Z",
  expiresIn: 600,
  intervalSeconds: 1,
};

describe("JSON browser sign-in without a terminal", spawning, () => {
  it("emits authorization before approval, then saves the token privately and emits identity", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-login-json-"));
    let approved = false;
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/cli/auth") return json(response, opened);
      if (request.url === "/api/organization")
        return json(response, { organization: { id: "org", name: "Mira's organization" } });
      json(
        response,
        approved
          ? {
              status: "approved",
              token: "private-token-sentinel",
              user: { id: "mira", email: "mira@example.invalid", name: "Mira" },
              device: { id: "device", name: "shell" },
            }
          : { status: "pending" },
      );
    });
    try {
      const cli = startCli(fake.url, ["login", "--url", fake.url, "--json"], {
        XDG_CONFIG_HOME: home,
      });
      await waitFor(() => cli.stdout().includes('"event":"authorize"'));
      expect(cli.stdout().trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        event: "authorize",
        code: "ABCDEFGH",
        url: `${fake.url}/authorize?code=ABCDEFGH`,
      });
      approved = true;
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      const lines = cli
        .stdout()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines[1]).toEqual({
        v: 1,
        event: "signed-in",
        account: { id: "mira", email: "mira@example.invalid", name: "Mira" },
        organization: { id: "org", name: "Mira's organization" },
      });
      expect(cli.stdout() + cli.stderr()).not.toContain("private-");
      const config = path.join(home, "mend", "cli.json");
      expect(JSON.parse(fs.readFileSync(config, "utf8"))).toMatchObject({
        token: "private-token-sentinel",
        deviceId: "device",
      });
      expect(fs.statSync(config).mode & 0o777).toBe(0o600);
    } finally {
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([403, 410])(
    "reports refusal %i without response bodies or credentials",
    async (status) => {
      const fake = await startFakeMend((request, response) => {
        if (request.url === "/api/cli/auth") return json(response, opened);
        response.writeHead(status).end('{"token":"private-token-sentinel"}');
      });
      try {
        const cli = startCli(fake.url, ["login", "--json"]);
        expect(await cli.exited).toEqual({ kind: "exit", code: 1 });
        const last = JSON.parse(cli.stdout().trim().split("\n").at(-1) ?? "{}");
        expect(last).toMatchObject({
          v: 1,
          status: "failed",
          error: {
            code: status === 403 ? "authorize_denied" : "authorize_expired",
            fix: expect.stringContaining("login"),
          },
        });
        expect(cli.stdout() + cli.stderr()).not.toContain("private-");
      } finally {
        await fake.close();
      }
    },
  );

  it("returns timeout 124 even when the authorization server never answers", async () => {
    const fake = await startFakeMend((_request, _response) => {});
    try {
      const cli = startCli(fake.url, ["login", "--json", "--timeout", ".05s"]);
      expect(await cli.exited).toEqual({ kind: "exit", code: 124 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "timeout",
        error: { code: "timeout" },
      });
    } finally {
      await fake.close();
    }
  });
});
