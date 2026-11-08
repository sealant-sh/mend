import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { accessKeysCommand, parseExpiry } from "./access-keys.ts";
import { flagRefusal } from "./flag-gate.ts";
import { renderGroup } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const SECRET = "mak_k9_Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA";

const ciBot = {
  id: "k1",
  name: "ci-bot",
  organizationId: "org",
  createdAt: "2026-10-30T10:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
};
const slackBot = {
  id: "k2",
  name: "slack-bot",
  organizationId: "org",
  createdAt: "2026-09-01T10:00:00.000Z",
  lastUsedAt: "2026-11-07T09:00:00.000Z",
  expiresAt: "2026-11-01T00:00:00.000Z",
};

interface Sent {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
}

/** The command against a fake server: `answer` gets each call, and throws to refuse it. */
const run = async (args: ReadonlyArray<string>, answer: (sent: Sent) => unknown = () => null) => {
  const sent: Array<Sent> = [];
  let stdout = "";
  let stderr = "";
  const api: ApiCall = async (method, route, body) => {
    const call = { method, route, body };
    sent.push(call);
    const reply: unknown = answer(call);
    return JSON.parse(JSON.stringify(reply ?? null));
  };
  const code = await accessKeysCommand(args, {
    connect: () => ({ url: "https://mend.example/", api }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    now: () => NOW,
  });
  return { code, sent, stdout, stderr };
};

const refused = (status: number, tag: string, message: string) => () => {
  throw new MendRequestError("http", message, status, { call: "", tag });
};

describe("mend access-keys list", () => {
  it("prints one aligned row per key, never for a key that was not used, expired once past", async () => {
    const { code, stdout, sent } = await run([], () => [ciBot, slackBot]);
    expect(code).toBe(0);
    expect(sent).toEqual([{ method: "GET", route: "/me/access-keys", body: undefined }]);
    expect(stdout.split("\n")).toEqual([
      "ID  NAME       CREATED     LAST USED   EXPIRES",
      "k1  ci-bot     2026-10-30  never       no expiry",
      "k2  slack-bot  2026-09-01  2026-11-07  expired",
      "",
    ]);
  });

  it("says how to create one when there are none", async () => {
    const { stdout } = await run(["list"], () => []);
    expect(stdout).toBe("no access keys · create one with mend access-keys create <name>\n");
  });

  it("prints the versioned list as JSON", async () => {
    const { stdout } = await run(["list", "--json"], () => [ciBot]);
    expect(JSON.parse(stdout)).toEqual({ version: 1, keys: [ciBot] });
  });
});

describe("mend access-keys create", () => {
  const created = (sent: Sent) => ({
    key: { ...ciBot, id: "k9", name: "nightly", expiresAt: "2027-02-06T12:00:00.000Z" },
    secret: SECRET,
    route: sent.route,
  });

  it("asks for 90 days by default and shows the secret once, with how to send it", async () => {
    const { code, stdout, sent } = await run(["create", "nightly"], created);
    expect(code).toBe(0);
    expect(sent[0]).toEqual({
      method: "POST",
      route: "/me/access-keys",
      body: { name: "nightly", expiresInDays: 90 },
    });
    expect(stdout).toContain("✓ created access key nightly (k9) · expires 2027-02-06");
    expect(stdout.split("\n")).toContain(SECRET);
    expect(stdout).toContain("Mend keeps only its hash");
    expect(stdout).toContain(
      'curl -H "Authorization: Bearer $MEND_ACCESS_KEY" https://mend.example/api/projects',
    );
  });

  it.each([
    ["30d", 30],
    ["1y", 365],
    ["never", null],
  ])("--expires %s asks for %s days", async (value, days) => {
    const { sent } = await run(["create", "nightly", "--expires", value], created);
    expect(sent[0]?.body).toEqual({ name: "nightly", expiresInDays: days });
  });

  it("prints the created key and its secret as JSON", async () => {
    const { stdout } = await run(["create", "nightly", "--json"], created);
    const printed: unknown = JSON.parse(stdout);
    expect(printed).toMatchObject({ version: 1, secret: SECRET, key: { id: "k9" } });
  });

  it("refuses a bad expiry or a missing name before it asks the server", async () => {
    for (const args of [["create", "nightly", "--expires", "2w"], ["create"], ["create", "  "]]) {
      const { code, sent, stderr } = await run(args, created);
      expect(code, args.join(" ")).toBe(1);
      expect(sent, args.join(" ")).toEqual([]);
      expect(stderr, args.join(" ")).toMatch(/^mend: /);
    }
  });

  it("prints the server's words and exits 1 when the CLI itself runs on an access key", async () => {
    const words = "An access key cannot create, list or revoke access keys.";
    const { code, stdout, stderr } = await run(
      ["create", "nightly"],
      refused(403, "AccessKeyRefused", words),
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`mend: ${words}\n`);
  });

  it("reports a refusal as versioned JSON with its tag under --json", async () => {
    const words = "You belong to no organization, so there is none for an access key to act in.";
    const { code, stdout } = await run(
      ["create", "nightly", "--json"],
      refused(409, "AccessKeyNeedsOrganization", words),
    );
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      version: 1,
      error: { tag: "AccessKeyNeedsOrganization", message: words },
    });
  });
});

describe("mend access-keys revoke", () => {
  it("revokes by id and says the next request with it is refused", async () => {
    const { code, sent, stdout } = await run(["revoke", "k1"], () => ciBot);
    expect(code).toBe(0);
    expect(sent).toEqual([{ method: "DELETE", route: "/me/access-keys/k1", body: undefined }]);
    expect(stdout).toBe("✓ revoked access key ci-bot (k1) · the next request with it is refused\n");
  });

  it("needs an id", async () => {
    const { code, sent } = await run(["revoke"]);
    expect(code).toBe(1);
    expect(sent).toEqual([]);
  });
});

describe("--expires", () => {
  it("takes 1d to 365d, 1y and never, and nothing else", () => {
    expect(parseExpiry("1d")).toEqual({ days: 1 });
    expect(parseExpiry("365d")).toEqual({ days: 365 });
    expect(parseExpiry("366d")).toBeNull();
    expect(parseExpiry("0d")).toBeNull();
    expect(parseExpiry("90")).toBeNull();
  });
});

describe("mend help access-keys", () => {
  it("lists the three subcommands and lets their flags through the gate", () => {
    const page = renderGroup("access-keys", 80) ?? "";
    for (const name of ["access-keys list", "access-keys create", "access-keys revoke"])
      expect(page).toContain(name);
    expect(flagRefusal(["access-keys", "--json"])).toBeNull();
    expect(flagRefusal(["access-keys", "create", "ci", "--expires", "1y", "--json"])).toBeNull();
    expect(flagRefusal(["access-keys", "revoke", "k1", "--expires", "1y"])).toMatch(
      /^unknown flag --expires/,
    );
  });
});

describe("mend access-keys through the CLI", () => {
  it("exits 1 with the server's words when MEND_TOKEN is itself an access key", async () => {
    const words = "An access key cannot create, list or revoke access keys.";
    const routes: Array<string> = [];
    const server = createServer((request, response) => {
      routes.push(`${request.method} ${request.url}`);
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ _tag: "AccessKeyRefused", message: words }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing test port");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-access-keys-test-"));
    try {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          fileURLToPath(new URL("./main.ts", import.meta.url)),
          "access-keys",
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, "config"),
            MEND_URL: `http://127.0.0.1:${address.port}`,
            MEND_TOKEN: SECRET,
            MEND_DETACH_KEY: "none",
          },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10_000,
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [code] = await once(child, "close");
      expect(code).toBe(1);
      expect(stderr).toBe(`mend: ${words}\n`);
      expect(routes).toEqual(["GET /api/me/access-keys"]);
    } finally {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
