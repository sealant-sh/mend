import { describe, expect, it } from "vitest";

import { flagRefusal } from "./flag-gate.ts";
import { renderGroup } from "./help.ts";
import { mcpServersCommand, VALUES_ON_ARGV, valuesFromLines } from "./mcp-servers.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";

const TOKEN = "ghp_value_that_must_never_print_0123456789";
const AT = "2026-11-09T10:00:00.000Z";

const github = {
  id: "s1",
  scope: "person",
  name: "github",
  transport: { _tag: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
  secretNames: ["GITHUB_TOKEN"],
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
};
const figma = {
  id: "s2",
  scope: "person",
  name: "figma",
  transport: { _tag: "http", url: "https://mcp.figma.com/mcp" },
  secretNames: [],
  enabled: false,
  createdAt: AT,
  updatedAt: AT,
};
const LIMITS = {
  servers: 16,
  secretsPerServer: 16,
  secretValueBytes: 8192,
  args: 32,
  argBytes: 1024,
};

interface Sent {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
}

interface Terminal {
  readonly terminal?: boolean;
  readonly typed?: ReadonlyArray<string | null>;
  readonly stdin?: string;
}

const run = async (
  args: ReadonlyArray<string>,
  { terminal = false, typed = [], stdin = "" }: Terminal = {},
  servers: ReadonlyArray<typeof github | typeof figma> = [github, figma],
  refuse?: () => never,
) => {
  const sent: Array<Sent> = [];
  const asked: Array<string> = [];
  let stdout = "";
  let stderr = "";
  const api: ApiCall = async (method, route, body) => {
    sent.push({ method, route, body });
    if (refuse !== undefined) refuse();
    const reply =
      method === "GET"
        ? { servers, limits: LIMITS }
        : method === "DELETE"
          ? { removed: servers.some((server) => route.endsWith(`/${server.name}`)) }
          : {
              ...github,
              name: decodeURIComponent(route.split("/").at(-1) ?? ""),
              transport: Reflect.get(Object(body), "transport"),
              enabled: Reflect.get(Object(body), "enabled") ?? true,
              secretNames: Object.keys(Object(Reflect.get(Object(body), "secrets"))),
            };
    return JSON.parse(JSON.stringify(reply));
  };
  let answers = [...typed];
  const code = await mcpServersCommand(args, {
    connect: () => ({ api }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    terminal,
    askHidden: async (label) => {
      asked.push(label);
      const [next, ...rest] = answers;
      answers = rest;
      return next ?? null;
    },
    readStdin: async () => stdin,
  });
  return { code, sent, stdout, stderr, asked };
};

describe("mend mcp list", () => {
  it("prints one aligned row per server with the names of its values, never a value", async () => {
    const { code, stdout, sent } = await run([]);
    expect(code).toBe(0);
    expect(sent).toEqual([{ method: "GET", route: "/me/mcp-servers", body: undefined }]);
    expect(stdout.split("\n")).toEqual([
      "NAME    TRANSPORT  TARGET                                      SECRETS           STATE",
      "github  stdio      npx -y @modelcontextprotocol/server-github  env GITHUB_TOKEN  on",
      "figma   http       mcp.figma.com                               -                 off",
      "",
    ]);
  });

  it("says how to add one when there are none", async () => {
    const { stdout } = await run(["list"], {}, []);
    expect(stdout).toContain("no MCP servers · add one with mend mcp add");
  });

  it("prints the versioned list as JSON", async () => {
    const { stdout } = await run(["--json"]);
    expect(JSON.parse(stdout)).toEqual({ version: 1, servers: [github, figma] });
  });
});

describe("mend mcp add", () => {
  it("adds an HTTP server by URL, and an SSE one with --sse", async () => {
    const http = await run(["add", "linear", "https://mcp.linear.app/mcp"]);
    expect(http.code).toBe(0);
    expect(http.sent.at(-1)).toEqual({
      method: "PUT",
      route: "/me/mcp-servers/linear",
      body: { transport: { _tag: "http", url: "https://mcp.linear.app/mcp" }, secrets: {} },
    });
    expect(http.stdout).toBe("✓ added linear · http · mcp.linear.app · on\n");
    const sse = await run(["add", "events", "https://mcp.example.com/sse", "--sse"]);
    expect(sse.sent.at(-1)?.body).toMatchObject({ transport: { _tag: "sse" } });
  });

  it("adds a stdio server from the command after --, asking for each value with echo off", async () => {
    const { code, sent, stdout, asked } = await run(
      ["add", "gh", "--env", "GITHUB_TOKEN", "--", "npx", "-y", "server-github", "--read-only"],
      { terminal: true, typed: [TOKEN] },
    );
    expect(code).toBe(0);
    expect(asked).toEqual(["GITHUB_TOKEN (not shown): "]);
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      route: "/me/mcp-servers/gh",
      body: {
        transport: { _tag: "stdio", command: "npx", args: ["-y", "server-github", "--read-only"] },
        secrets: { GITHUB_TOKEN: { _tag: "Set", value: TOKEN } },
      },
    });
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).toContain("env GITHUB_TOKEN");
  });

  it("reads NAME=value lines from stdin without a terminal, = in a value included", async () => {
    const { sent } = await run(
      ["add", "linear", "https://mcp.linear.app/mcp", "--header", "Authorization"],
      { stdin: `\nAuthorization=Bearer ${TOKEN}==\n` },
    );
    expect(sent.at(-1)?.body).toMatchObject({
      secrets: { Authorization: { _tag: "Set", value: `Bearer ${TOKEN}==` } },
    });
  });

  it("refuses a value on the command line before it asks the server", async () => {
    for (const args of [
      ["add", "gh", "--env", `GITHUB_TOKEN=${TOKEN}`, "--", "npx", "server-github"],
      ["add", "linear", "https://mcp.linear.app/mcp", "--header", `Authorization=${TOKEN}`],
    ]) {
      const { code, sent, stderr } = await run(args);
      expect(code).toBe(1);
      expect(sent).toEqual([]);
      expect(stderr).toContain(VALUES_ON_ARGV);
      expect(stderr).not.toContain(TOKEN);
    }
  });

  it("never prints a value under --json, on success or refusal", async () => {
    const added = await run(["add", "gh", "--env", "GITHUB_TOKEN", "--json", "--", "npx", "x"], {
      terminal: true,
      typed: [TOKEN],
    });
    expect(JSON.parse(added.stdout)).toMatchObject({ version: 1, server: { name: "gh" } });
    expect(added.stdout).not.toContain(TOKEN);
    const refused = await run(["add", "gh", "--env", `GITHUB_TOKEN=${TOKEN}`, "--json", "--", "x"]);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      version: 1,
      error: { tag: "InvalidMcpArguments" },
    });
    expect(refused.stdout).not.toContain(TOKEN);
  });

  it("refuses a name it already has and points to Settings or remove", async () => {
    const { code, sent, stderr } = await run(["add", "figma", "https://mcp.figma.com/mcp"]);
    expect(code).toBe(1);
    expect(sent.map((call) => call.method)).toEqual(["GET"]);
    expect(stderr).toContain("figma exists: change it in Settings → MCP servers");
    expect(stderr).toContain("mend mcp remove figma");
  });

  it("adds nothing when a value is not given", async () => {
    const gaveUp = await run(["add", "gh", "--env", "GITHUB_TOKEN", "--", "npx"], {
      terminal: true,
      typed: [null],
    });
    expect(gaveUp.code).toBe(1);
    expect(gaveUp.sent.map((call) => call.method)).toEqual(["GET"]);
    const missing = await run(["add", "gh", "--env", "A", "--env", "B", "--", "npx"], {
      stdin: "A=1\n",
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no NAME=value line for B");
  });

  it("refuses Mend's own names, bad URLs and flags of the other transport", async () => {
    for (const args of [
      ["add", "mend-tools", "https://mcp.example.com/"],
      ["add", "tools", "ftp://mcp.example.com/"],
      ["add", "tools", "https://mcp.example.com/", "--env", "TOKEN"],
      ["add", "tools", "--header", "Authorization", "--", "npx"],
      ["add", "tools"],
    ]) {
      const { code, sent } = await run(args);
      expect(code, args.join(" ")).toBe(1);
      expect(sent, args.join(" ")).toEqual([]);
    }
  });
});

describe("mend mcp on, off and remove", () => {
  it("turns a server on with its saved transport and sends no secrets, so every value is kept", async () => {
    const { code, sent, stdout } = await run(["on", "figma"]);
    expect(code).toBe(0);
    expect(sent.at(-1)).toEqual({
      method: "PUT",
      route: "/me/mcp-servers/figma",
      body: { transport: figma.transport, enabled: true },
    });
    expect(stdout).toBe("✓ figma · http · mcp.figma.com · on\n");
    const off = await run(["off", "github"]);
    expect(off.sent.at(-1)?.body).toEqual({ transport: github.transport, enabled: false });
  });

  it("says when there is no server by that name", async () => {
    const { code, stderr } = await run(["off", "nope"]);
    expect(code).toBe(1);
    expect(stderr).toBe("mend: no MCP server named nope · mend mcp lists yours\n");
  });

  it("removes by name with remove or rm", async () => {
    const removed = await run(["rm", "github"]);
    expect(removed.sent).toEqual([
      { method: "DELETE", route: "/me/mcp-servers/github", body: undefined },
    ]);
    expect(removed.stdout).toBe("✓ removed github and its saved values\n");
    const absent = await run(["remove", "nope", "--json"]);
    expect(JSON.parse(absent.stdout)).toEqual({ version: 1, name: "nope", removed: false });
  });

  it("prints the server's words and exits 1 when the CLI runs on an access key", async () => {
    const words = "An access key cannot list or change MCP servers.";
    const { code, stdout, stderr } = await run([], {}, [], () => {
      throw new MendRequestError("http", words, 403, { call: "", tag: "AccessKeyRefused" });
    });
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(`mend: ${words}\n`);
  });
});

describe("NAME=value lines", () => {
  it("takes only the names asked for, once each", () => {
    expect(valuesFromLines("A=1\nB=2=3\n", ["A", "B"])).toEqual({ values: { A: "1", B: "2=3" } });
    expect(valuesFromLines("C=1\n", ["A"])).toEqual({
      issue: "stdin names C, which this command did not",
    });
    expect(valuesFromLines("A=1\nA=2\n", ["A"])).toEqual({ issue: "stdin gives A twice" });
    expect(valuesFromLines("A=\n", ["A"])).toEqual({ issue: "stdin: A is empty" });
  });
});

describe("mend help mcp", () => {
  it("lists its subcommands and lets their flags through the gate", () => {
    const page = renderGroup("mcp", 80) ?? "";
    for (const name of ["mcp add", "mcp remove", "mcp on", "mcp off"]) expect(page).toContain(name);
    expect(flagRefusal(["mcp", "--json"])).toBeNull();
    expect(flagRefusal(["mcp", "rm", "github", "--json"])).toBeNull();
    expect(
      flagRefusal(["mcp", "add", "gh", "--env", "TOKEN", "--", "npx", "--anything", "--env"]),
    ).toBeNull();
    expect(
      flagRefusal(["mcp", "add", "figma", "https://x.example", "--sse", "--header", "A"]),
    ).toBeNull();
    expect(flagRefusal(["mcp", "on", "figma", "--sse"])).toMatch(/^unknown flag --sse/);
  });
});
