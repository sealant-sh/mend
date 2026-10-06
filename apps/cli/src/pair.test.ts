import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chooseUrl, groupCode, minutesUntil, pairingLink, renderQr } from "./pair.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const startFakeMend = async (handle: Handler) => {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

/** The CLI as a user runs it, with a home of its own so the machine's own config cannot leak in. */
const runCli = async (
  url: string,
  args: ReadonlyArray<string>,
  options: { readonly token?: string } = {},
) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pair-test-"));
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    MEND_URL: url,
    MEND_DETACH_KEY: "none",
    MEND_TOKEN: options.token,
  };
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [code] = await once(child, "close");
    return { code: typeof code === "number" ? code : null, stdout, stderr };
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
};

describe("pairing facts", () => {
  it("groups the code the way it is read aloud", () => {
    expect(groupCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(groupCode("abcd-efgh")).toBe("ABCD-EFGH");
  });

  it("encodes the base URL into the deep link", () => {
    expect(pairingLink("http://100.64.1.2:3105", "ABCDEFGH")).toBe(
      "mend://pair?u=http%3A%2F%2F100.64.1.2%3A3105&c=ABCDEFGH",
    );
  });

  it("preserves configured order and accepts only exact configured overrides", () => {
    const urls = ["https://mend.example", "http://100.64.1.2:3105"];
    expect(chooseUrl(urls, null)).toBe("https://mend.example");
    expect(chooseUrl(urls.toReversed(), null)).toBe("http://100.64.1.2:3105");
    for (const url of urls) {
      expect(chooseUrl(urls, url)).toBe(url);
    }
    expect(chooseUrl(urls, "http://mend.local:3105")).toBeNull();
    expect(chooseUrl([], null)).toBeNull();
    expect(chooseUrl([], "https://mend.example")).toBeNull();
  });

  it("reports whole minutes left, and nothing at all for an unreadable date", () => {
    const now = Date.parse("2026-08-22T10:00:00.000Z");
    expect(minutesUntil("2026-08-22T10:10:00.000Z", now)).toBe(10);
    expect(minutesUntil("2026-08-22T09:00:00.000Z", now)).toBe(0);
    expect(minutesUntil("not a date", now)).toBeNull();
  });
});

// Each test here spawns the CLI from source; on a loaded CI runner one start has taken 3 s, so
// vitest's 5 s default left little headroom.
describe("mend pair", { timeout: 30_000 }, () => {
  it.each([null, "http://100.64.1.2:3105"])(
    "prints the configured URL and QR with override %s, without Origin",
    async (override) => {
      const requests: Array<{
        method: string | undefined;
        url: string | undefined;
        origin: string | undefined;
        authorization: string | undefined;
      }> = [];
      const fake = await startFakeMend((request, response) => {
        requests.push({
          method: request.method,
          url: request.url,
          origin: request.headers.origin,
          authorization: request.headers.authorization,
        });
        if (request.url === "/api/me/devices/pairings") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              code: "ABCDEFGH",
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
              urls: ["https://mend.example", "http://100.64.1.2:3105"],
            }),
          );
          return;
        }
        response.writeHead(404).end();
      });

      try {
        const args = override === null ? ["pair"] : ["pair", "--url", override];
        const result = await runCli(fake.url, args, { token: "test-token" });
        expect(result.stderr).toBe("");
        expect(result.code).toBe(0);
        expect(requests).toEqual([
          {
            method: "POST",
            url: "/api/me/devices/pairings",
            origin: undefined,
            authorization: "Bearer test-token",
          },
        ]);
        // The QR renders as block characters, on a pipe as well as in a terminal.
        expect(result.stdout).toContain("▄");
        expect(result.stdout).toContain("ABCD-EFGH");
        const selectedUrl = override ?? "https://mend.example";
        expect(result.stdout).toContain(`url     ${selectedUrl}\n`);
        expect(result.stdout).toContain(await renderQr(pairingLink(selectedUrl, "ABCDEFGH")));
        expect(result.stdout).toContain("in 10 min");
        expect(result.stdout).toContain("enter the url and the code");
      } finally {
        await fake.close();
      }
    },
  );

  it.each([
    "https://unlisted.example",
    "https://mend.example/",
    "https://MEND.example",
    "https://mend.example:443",
    "http://mend.example",
    "https://mend.example/path",
    "https://mend.example?query=1",
    "https://mend.example#fragment",
    "https://user@mend.example",
    " https://mend.example",
    "",
  ])("rejects unconfigured --url %s without printing a QR or code", async (override) => {
    const fake = await startFakeMend((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          code: "ABCDEFGH",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          urls: ["https://mend.example", "http://100.64.1.2:3105"],
        }),
      );
    });
    try {
      const result = await runCli(fake.url, ["pair", "--url", override], { token: "test-token" });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "mend: --url must exactly match one of the server's configured pairing URLs\n",
      );
      expect(result.stdout).toBe("");
    } finally {
      await fake.close();
    }
  });

  it.each([[], ["--url"]])("rejects missing server URLs or flag values: %j", async (...args) => {
    const fake = await startFakeMend((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          code: "ABCDEFGH",
          expiresAt: new Date().toISOString(),
          urls: [],
        }),
      );
    });
    try {
      const result = await runCli(fake.url, ["pair", ...args], { token: "test-token" });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        args.length === 0 ? "no configured pairing URLs" : "--url requires an exact URL",
      );
      expect(result.stdout).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("fails the way every other authenticated command fails when nobody is signed in", async () => {
    const fake = await startFakeMend((_request, response) => {
      response.writeHead(401).end();
    });

    try {
      const result = await runCli(fake.url, ["pair"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(`mend: not signed in to ${fake.url} — run: mend login\n`);
      expect(result.stdout).toBe("");
    } finally {
      await fake.close();
    }
  });
});
