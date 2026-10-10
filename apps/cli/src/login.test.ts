import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  authorizeUrl,
  browserCommand,
  browserDecision,
  normalizeServerUrl,
  pollDeadline,
  pollDelayMs,
} from "./login.ts";

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

/**
 * The CLI as a user runs it, with a home of its own so the machine's own
 * config cannot leak in. `savedUrl` pre-writes the config file and leaves
 * MEND_URL unset — the shape of a machine that logged in before.
 */
const runCli = async (
  url: string,
  args: ReadonlyArray<string>,
  options: { readonly savedUrl?: string } = {},
) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-login-test-"));
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  if (options.savedUrl !== undefined) {
    const configDir = path.join(home, "config", "mend");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "cli.json"), JSON.stringify({ url: options.savedUrl }));
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    MEND_URL: options.savedUrl === undefined ? url : undefined,
    MEND_DETACH_KEY: "none",
    MEND_TOKEN: undefined,
  };
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "exit");
  return {
    code: typeof code === "number" ? code : null,
    stdout,
    stderr,
    configPath: path.join(home, "config", "mend", "cli.json"),
  };
};

describe("server url normalisation", () => {
  it("adds http:// to a bare host and drops a trailing slash", () => {
    expect(normalizeServerUrl("mend.local:3105")).toBe("http://mend.local:3105");
    expect(normalizeServerUrl("http://100.64.1.2:3105/")).toBe("http://100.64.1.2:3105");
    expect(normalizeServerUrl("https://mend.example.com")).toBe("https://mend.example.com");
  });

  it("keeps a real path but not its trailing slash", () => {
    expect(normalizeServerUrl("https://host.example/mend/")).toBe("https://host.example/mend");
  });

  it("refuses what cannot be dialed", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("   ")).toBeNull();
    expect(normalizeServerUrl("ftp://mend.local")).toBeNull();
    expect(normalizeServerUrl("http://")).toBeNull();
  });

  it("is idempotent: its own output normalises to itself", () => {
    for (const input of [
      "mend.local:3105",
      "http://100.64.1.2:3105/",
      "https://mend.example.com",
      "https://host.example/mend/",
      "  HTTP://Mixed.Case:8080  ",
    ]) {
      const normalized = normalizeServerUrl(input);
      expect(normalized).not.toBeNull();
      if (normalized !== null) expect(normalizeServerUrl(normalized)).toBe(normalized);
    }
  });
});

describe("authorize walk facts", () => {
  it("resolves the verify path against the URL the CLI dialed", () => {
    expect(authorizeUrl("http://100.64.1.2:3105", "/authorize?code=ABCD-EFGH")).toBe(
      "http://100.64.1.2:3105/authorize?code=ABCD-EFGH",
    );
  });

  it("holds the poll cadence to a sane band", () => {
    expect(pollDelayMs(2)).toBe(2000);
    expect(pollDelayMs(0)).toBe(1000);
    expect(pollDelayMs(600)).toBe(10_000);
  });

  it("counts down from receipt, whatever the server's clock says", () => {
    const received = Date.parse("2026-10-11T02:00:00.000Z");
    // The server's clock is 1 h 56 min behind: its expiresAt is long past on this clock.
    const behind = { expiresAt: "2026-10-11T00:14:00.000Z", expiresIn: 600 };
    expect(pollDeadline(behind, received)).toBe(received + 600_000);
    expect(pollDeadline({ expiresAt: "not a date", expiresIn: -3 }, received)).toBe(received);
  });

  it("reads an older server's expiresAt against its own Date header", () => {
    const received = Date.parse("2026-10-11T02:00:00.000Z");
    const expiry = { expiresAt: "2026-10-11T00:14:00.000Z" };
    expect(pollDeadline(expiry, received, "Sun, 11 Oct 2026 00:04:00 GMT")).toBe(
      received + 600_000,
    );
    // No Date header, or an unreadable date: ten minutes.
    expect(pollDeadline(expiry, received, null)).toBe(received + 10 * 60_000);
    expect(
      pollDeadline({ expiresAt: "not a date" }, received, "Sun, 11 Oct 2026 00:04:00 GMT"),
    ).toBe(received + 10 * 60_000);
  });

  it("opens a browser only on a terminal with a screen of its own", () => {
    const terminal = { args: [], platform: "darwin" as const, isTTY: true };
    expect(browserDecision({ ...terminal, env: {} })).toEqual({ open: true, why: null });
    // Over SSH the browser would open on the far machine's screen.
    const overSsh = browserDecision({ ...terminal, env: { SSH_CONNECTION: "1 2 3 4" } });
    expect(overSsh.open).toBe(false);
    expect(overSsh.why).toContain("over SSH");
    expect(browserDecision({ ...terminal, env: { SSH_TTY: "/dev/ttys003" } }).open).toBe(false);
    // Linux needs a display; macOS always has one.
    const linux = { ...terminal, platform: "linux" as const };
    expect(browserDecision({ ...linux, env: {} }).why).toContain("no display");
    expect(browserDecision({ ...linux, env: { WAYLAND_DISPLAY: "wayland-0" } }).open).toBe(true);
    expect(browserDecision({ ...linux, env: { DISPLAY: ":0" } }).open).toBe(true);
    // A pipe never opens one, and says nothing about it.
    expect(browserDecision({ ...terminal, isTTY: false, env: {} })).toEqual({
      open: false,
      why: null,
    });
  });

  it("lets --open and --no-open decide outright", () => {
    const ssh = { SSH_CONNECTION: "1 2 3 4" };
    expect(
      browserDecision({ args: ["--open"], env: ssh, platform: "darwin", isTTY: false }).open,
    ).toBe(true);
    expect(
      browserDecision({ args: ["--no-open"], env: {}, platform: "darwin", isTTY: true }),
    ).toEqual({ open: false, why: null });
  });

  it("knows how each platform opens a browser, and when to just print", () => {
    expect(browserCommand("darwin")).toEqual({ command: "open", args: [] });
    expect(browserCommand("linux")).toEqual({ command: "xdg-open", args: [] });
    expect(browserCommand("win32")).toBeNull();
  });
});

// Each test here spawns the CLI from source; on a loaded CI runner the first, with its two real
// polling delays, took 5 s, so vitest's 5 s default left no headroom.
describe("mend login", { timeout: 30_000 }, () => {
  it("opens a request, polls to approval, and saves url + token + device id", async () => {
    const requests: Array<string> = [];
    let polls = 0;
    const fake = await startFakeMend((request, response) => {
      requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.url === "/api/cli/auth") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            deviceCode: "mdc_secret",
            code: "ABCDEFGH",
            verifyPath: "/authorize?code=ABCD-EFGH",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            intervalSeconds: 1,
          }),
        );
        return;
      }
      if (request.url === "/api/cli/auth/token") {
        polls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          polls === 1
            ? JSON.stringify({ status: "pending" })
            : JSON.stringify({
                status: "approved",
                token: "mdt_fresh-token",
                user: { id: "u1", name: "Yiannis", email: "y@example.com" },
                device: { id: "d1", name: "test-host" },
              }),
        );
        return;
      }
      response.writeHead(404).end();
    });

    try {
      const result = await runCli(fake.url, ["login"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(requests[0]).toBe("POST /api/cli/auth");
      expect(polls).toBe(2);
      expect(result.stdout).toContain("ABCD-EFGH");
      expect(result.stdout).toContain(`${fake.url}/authorize?code=ABCD-EFGH`);
      expect(result.stdout).toContain("signed in as y@example.com");
      // The token never appears in the output — it goes to the config alone.
      expect(result.stdout).not.toContain("mdt_fresh-token");
      const saved = JSON.parse(fs.readFileSync(result.configPath, "utf8")) as {
        url: string;
        token: string;
        deviceId: string;
      };
      expect(saved).toEqual({ url: fake.url, token: "mdt_fresh-token", deviceId: "d1" });
      const mode = fs.statSync(result.configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      await fake.close();
    }
  });

  it("signs in when the server's clock runs two hours behind this one", async () => {
    let polls = 0;
    let started: unknown = null;
    const skewMs = -(116 * 60_000);
    const fake = await startFakeMend((request, response) => {
      const serverNow = Date.now() + skewMs;
      const headers = {
        "content-type": "application/json",
        date: new Date(serverNow).toUTCString(),
      };
      if (request.url === "/api/cli/auth") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          started = JSON.parse(body);
          response.writeHead(200, headers);
          // An older server: no expiresIn, only its own clock's expiresAt.
          response.end(
            JSON.stringify({
              deviceCode: "mdc_secret",
              code: "ABCDEFGH",
              verifyPath: "/authorize?code=ABCD-EFGH",
              expiresAt: new Date(serverNow + 10 * 60_000).toISOString(),
              intervalSeconds: 1,
            }),
          );
        });
        return;
      }
      if (request.url === "/api/cli/auth/token") {
        polls += 1;
        response.writeHead(200, headers);
        response.end(
          JSON.stringify({
            status: "approved",
            token: "mdt_skewed",
            user: { id: "u1", name: "Yiannis", email: "y@example.com" },
            device: { id: "d1", name: "test-host" },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });

    try {
      const result = await runCli(fake.url, ["login"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(polls).toBe(1);
      expect(result.stdout).toContain("signed in as y@example.com");
      expect(started).toEqual({ name: os.hostname(), client: "cli" });
    } finally {
      await fake.close();
    }
  });

  it("reuses a saved server URL without asking for it again", async () => {
    let polls = 0;
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/cli/auth") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            deviceCode: "mdc_secret",
            code: "ABCDEFGH",
            verifyPath: "/authorize?code=ABCD-EFGH",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            intervalSeconds: 1,
          }),
        );
        return;
      }
      if (request.url === "/api/cli/auth/token") {
        polls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "approved",
            token: "mdt_fresh-token",
            user: { id: "u1", name: "Yiannis", email: "y@example.com" },
            device: { id: "d1", name: "test-host" },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });

    try {
      // MEND_URL is unset; only the config file names the server. No prompt:
      // stdin is not a terminal, and the saved URL must be used as-is.
      const result = await runCli(fake.url, ["login"], { savedUrl: fake.url });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(polls).toBe(1);
      expect(result.stdout).not.toContain("mend server url");
      expect(result.stdout).toContain(`authorize request open at ${fake.url}`);
    } finally {
      await fake.close();
    }
  });

  it("refuses a 200 that does not answer like a Mend server, without crashing", async () => {
    const fake = await startFakeMend((_request, response) => {
      // A captive portal or a non-Mend server: 200 with an HTML body.
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>welcome to the lobby wifi</html>");
    });

    try {
      const result = await runCli(fake.url, ["login"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("did not answer like a Mend server");
      expect(fs.existsSync(result.configPath)).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("reports a denial as a denial, not an error to retry", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/cli/auth") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            deviceCode: "mdc_secret",
            code: "ABCDEFGH",
            verifyPath: "/authorize?code=ABCD-EFGH",
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            intervalSeconds: 1,
          }),
        );
        return;
      }
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ _tag: "CliAuthDenied" }));
    });

    try {
      const result = await runCli(fake.url, ["login"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("denied in the browser");
      expect(fs.existsSync(result.configPath)).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
