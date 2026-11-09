import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServerName, McpServerUrl, type McpTransport } from "@mend/domain/workbench";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { withPrompt, promptCommandOf } from "../agent-command.ts";
import { mendMcpFlags, withMendMcp } from "./launch.ts";
import {
  mcpPersonOf,
  personalMcpDir,
  personalMcpWords,
  PersonalMcp,
  piMcpJsonWith,
  planPersonalMcp,
  WITHHELD_UNDER_SHARED_CONTROL,
  type UnsealedMcpServer,
} from "./personal.ts";

const DIR = "/home/mabc123/.mend/mcp";

const server = (
  name: string,
  transport: McpTransport,
  secrets: Record<string, string> = {},
): UnsealedMcpServer => ({ name: McpServerName.make(name), transport, secrets });
const stdio = (command: string, args: ReadonlyArray<string>) =>
  ({ _tag: "stdio", command, args }) as const;
const http = (url: string) => ({ _tag: "http", url: McpServerUrl.make(url) }) as const;
const sse = (url: string) => ({ _tag: "sse", url: McpServerUrl.make(url) }) as const;

/** What Codex reads of one `--config=mcp_servers.<name>={…}` word. */
const codexTable = (flag: string): { readonly name: string; readonly table: unknown } => {
  const match = /^--config=mcp_servers\.([a-z][a-z0-9_-]*)=(\{.*\})$/s.exec(flag);
  if (match === null) throw new Error(`not a Codex server flag: ${flag}`);
  return { name: match[1] ?? "", table: parseToml(`t = ${match[2]}`)["t"] };
};

const scratch: Array<string> = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The plan's files, written under a scratch directory, with every path rewritten to it. */
const materialize = (plan: ReturnType<typeof planPersonalMcp>, dir: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-plan-"));
  scratch.push(root);
  for (const file of plan.files) {
    const at = path.join(root, path.relative(dir, file.path));
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.writeFileSync(at, file.content);
  }
  return (text: string) => text.replaceAll(dir, root);
};

describe("planPersonalMcp for Claude", () => {
  it("names one file after Mend's own config, holding every server with its values", () => {
    const plan = planPersonalMcp({
      harness: "claude",
      dir: DIR,
      servers: [
        server("github", stdio("npx", ["-y", "@modelcontextprotocol/server-github"]), {
          GITHUB_TOKEN: "ghp_value",
        }),
        server("figma", http("https://mcp.figma.com/mcp")),
        server("linear", sse("https://mcp.linear.app/sse"), { Authorization: "Bearer lin" }),
      ],
    });
    expect(plan.flags).toEqual([`--mcp-config=${DIR}/claude.json`]);
    expect(plan.skipped).toEqual([]);
    expect(plan.files.map((file) => file.path)).toEqual([`${DIR}/claude.json`]);
    expect(JSON.parse(plan.files[0]?.content ?? "")).toEqual({
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "ghp_value" },
        },
        figma: { type: "http", url: "https://mcp.figma.com/mcp" },
        linear: {
          type: "sse",
          url: "https://mcp.linear.app/sse",
          headers: { Authorization: "Bearer lin" },
        },
      },
    });
  });
});

describe("planPersonalMcp for Codex", () => {
  it("runs a stdio server through a script that exports its env and starts it with its exact words", () => {
    const words = ["it's", '"quoted"', "$HOME", "`id`", "$(id)", "a;b", "line\nbreak", "-", ""];
    const env = {
      TOKEN: 'it\'s a "secret" $(id) `id` \\ \n second line',
      OTHER: "plain",
    };
    const plan = planPersonalMcp({
      harness: "codex",
      dir: DIR,
      servers: [server("tool", stdio(process.execPath, ["-e", PRINT, ...words]), env)],
    });
    const [flag] = plan.flags;
    expect(plan.flags).toHaveLength(1);
    expect(codexTable(flag ?? "")).toEqual({
      name: "tool",
      table: { command: "/bin/sh", args: [`${DIR}/codex/tool.sh`] },
    });
    const at = materialize(plan, DIR);
    const result = spawnSync("/bin/sh", [at(`${DIR}/codex/tool.sh`)], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      argv: words,
      TOKEN: env.TOKEN,
      OTHER: env.OTHER,
    });
  });

  it("gives an HTTP server its headers through a helper that prints them, and none without headers", () => {
    const headers = { Authorization: 'Bearer it\'s "x" $(id)', "X-Team": "t1" };
    const plan = planPersonalMcp({
      harness: "codex",
      dir: DIR,
      servers: [
        server("remote", http("https://mcp.example.com/mcp"), headers),
        server("open", http("https://open.example.com/mcp")),
      ],
    });
    const [withHeaders, open] = plan.flags.map(codexTable);
    expect(withHeaders).toEqual({
      name: "remote",
      table: {
        url: "https://mcp.example.com/mcp",
        http_headers_helper: `cat '${DIR}/codex/remote.headers.json'`,
      },
    });
    expect(open).toEqual({ name: "open", table: { url: "https://open.example.com/mcp" } });
    const at = materialize(plan, DIR);
    const table = withHeaders?.table;
    const helper =
      typeof table === "object" && table !== null && "http_headers_helper" in table
        ? String(table.http_headers_helper)
        : "";
    const printed = spawnSync("sh", ["-c", at(helper)], { encoding: "utf8" });
    expect(JSON.parse(printed.stdout)).toEqual(headers);
  });

  it("skips an SSE server, which Codex cannot reach, and says why", () => {
    const plan = planPersonalMcp({
      harness: "codex",
      dir: DIR,
      servers: [server("slack", sse("https://mcp.slack.com/sse"))],
    });
    expect(plan).toEqual({ flags: [], files: [], skipped: [{ name: "slack", why: "SSE" }] });
  });

  it("keeps a URL one TOML string, whatever it holds", () => {
    const url = 'https://evil.example.com/mcp?x="}, command="sh", y={"\\\u007f';
    const plan = planPersonalMcp({ harness: "codex", dir: DIR, servers: [server("e", http(url))] });
    expect(plan.flags.map(codexTable)).toEqual([{ name: "e", table: { url } }]);
  });
});

describe("planPersonalMcp", () => {
  it("never puts a secret value on argv, for any harness or transport", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    const alphabet = `abcXYZ019 '"\\$\`;|&<>(){}[]=,.\n\t%é✓`;
    const value = () =>
      `v${Array.from({ length: 12 + (next() % 20) }, () => alphabet[next() % alphabet.length]).join("")}`;
    const values: Array<string> = [];
    const servers = Array.from({ length: 16 }, (_, index) => {
      const secrets = Object.fromEntries(
        Array.from({ length: 1 + (next() % 4) }, (_secret, at) => {
          const secret = value();
          values.push(secret);
          return [index % 3 === 0 ? `NAME_${at}` : `X-Header-${at}`, secret];
        }),
      );
      const transport =
        index % 3 === 0
          ? stdio("npx", ["-y", `server-${index}`])
          : index % 3 === 1
            ? http(`https://s${index}.example.com/mcp`)
            : sse(`https://s${index}.example.com/sse`);
      return server(`s${index}`, transport, secrets);
    });
    for (const harness of ["claude", "codex", "pi", "opencode"]) {
      const plan = planPersonalMcp({ harness, dir: DIR, servers });
      const argv = withMendMcp([harness], { _tag: "Delivered", harness, flags: plan.flags });
      for (const secret of values) {
        for (const form of [secret, JSON.stringify(secret).slice(1, -1)]) {
          expect(argv.join("\u0000")).not.toContain(form);
        }
      }
    }
  });

  it("skips a server whose names cannot be written safely", () => {
    const plan = planPersonalMcp({
      harness: "codex",
      dir: DIR,
      servers: [
        { name: McpServerName.make("ok"), transport: stdio("x", []), secrets: { "A;B": "v" } },
        server("fine", stdio("x", []), { A_B: "v" }),
      ],
    });
    expect(plan.skipped).toEqual([{ name: "ok", why: "a name Mend cannot use" }]);
    expect(plan.flags.map((flag) => codexTable(flag).name)).toEqual(["fine"]);
  });

  it("gives pi and opencode nothing on argv", () => {
    for (const harness of ["pi", "opencode"]) {
      expect(
        planPersonalMcp({ harness, dir: DIR, servers: [server("a", http("https://a.test/mcp"))] }),
      ).toEqual({ flags: [], files: [], skipped: [] });
    }
  });
});

const PRINT = `process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), TOKEN: process.env.TOKEN, OTHER: process.env.OTHER }))`;

describe("personalMcpDir", () => {
  it("is the person's own never-saved home, or root's directory outside every capture", () => {
    expect(personalMcpDir("/home/mabc123")).toBe("/home/mabc123/.mend/mcp");
    expect(personalMcpDir(null)).toBe("/run/mend/mcp");
  });
});

describe("mcpPersonOf", () => {
  const base = { sessionOwner: "alice", onceShared: false, terminal: false } as const;
  it.each([
    [
      "a person executor: whoever the process runs as",
      { ...base, runsAs: "bob", holder: null },
      { _tag: "Deliver", accountId: "bob" },
    ],
    [
      "a person executor, once shared: still the sender",
      { ...base, runsAs: "bob", holder: null, onceShared: true },
      { _tag: "Deliver", accountId: "bob" },
    ],
    [
      "a shared home, the holder's own session",
      { ...base, runsAs: null, holder: "alice" },
      { _tag: "Deliver", accountId: "alice" },
    ],
    [
      "a shared home, a once-shared conversation",
      { ...base, runsAs: null, holder: "alice", onceShared: true },
      { _tag: "Withhold", accountId: "alice", why: WITHHELD_UNDER_SHARED_CONTROL },
    ],
    [
      "a shared home, a once-shared terminal (7a's exception)",
      { ...base, runsAs: null, holder: "alice", onceShared: true, terminal: true },
      { _tag: "Deliver", accountId: "alice" },
    ],
    [
      "a shared home, another person's join",
      { ...base, runsAs: null, holder: "carol" },
      { _tag: "Withhold", accountId: "alice", why: "this workspace is another person's" },
    ],
    [
      "a shared home Mend cannot place",
      { ...base, runsAs: null, holder: null },
      { _tag: "Withhold", accountId: "alice", why: "Mend cannot say whose this workspace is" },
    ],
    [
      "a session with no owner",
      { ...base, runsAs: null, holder: "alice", sessionOwner: null },
      { _tag: "Withhold", accountId: null, why: "the session has no owner" },
    ],
  ] as const)("%s", (_, input, expected) => {
    expect(mcpPersonOf(input)).toEqual(expected);
  });
});

describe("piMcpJsonWith", () => {
  const github = server("github", stdio("npx", ["gh"]), { TOKEN: "t" });
  it("adds the person's servers beside the profile's own, and theirs win a name", () => {
    const profile = JSON.stringify({
      mcpServers: { executor: { command: "executor" }, github: { command: "old" } },
      settings: { toolPrefix: "none" },
    });
    expect(
      JSON.parse(
        piMcpJsonWith(profile, [github, server("slack", sse("https://s.test/sse"))]) ?? "",
      ),
    ).toEqual({
      mcpServers: {
        executor: { command: "executor" },
        github: { command: "npx", args: ["gh"], env: { TOKEN: "t" } },
        slack: { url: "https://s.test/sse", httpTransport: "sse" },
      },
      settings: { toolPrefix: "none" },
    });
  });

  it("makes the file when the profile has none, and leaves one it cannot read as it is", () => {
    expect(JSON.parse(piMcpJsonWith(null, [github]) ?? "")).toEqual({
      mcpServers: { github: { command: "npx", args: ["gh"], env: { TOKEN: "t" } } },
    });
    expect(piMcpJsonWith("not json", [github])).toBeNull();
    expect(piMcpJsonWith('{"mcpServers": []}', [github])).toBeNull();
  });
});

describe("personalMcpWords", () => {
  it("names what was delivered and what the harness could not take", () => {
    expect(
      personalMcpWords({
        harness: "codex",
        delivered: ["figma", "github"],
        skipped: [{ name: "slack", why: "SSE" }],
      }),
    ).toBe("MCP servers · figma, github · not for Codex: slack (SSE)");
    expect(personalMcpWords({ harness: "claude", delivered: ["figma"], skipped: [] })).toBe(
      "MCP servers · figma",
    );
    expect(personalMcpWords({ harness: "claude", delivered: [], skipped: [] })).toBeNull();
  });
});

const delivered = (harness: string, flags: ReadonlyArray<string>): PersonalMcp => ({
  _tag: "Delivered",
  harness,
  flags,
});

describe("withMendMcp with the person's servers", () => {
  const claude = planPersonalMcp({
    harness: "claude",
    dir: DIR,
    servers: [server("figma", http("https://mcp.figma.com/mcp"))],
  });
  it("puts the person's config after Mend's own, attached, and only once", () => {
    const argv = withMendMcp(["claude", "-p"], delivered("claude", claude.flags));
    expect(argv).toEqual(["claude", ...mendMcpFlags("claude"), ...claude.flags, "-p"]);
    expect(withMendMcp(argv, delivered("claude", claude.flags))).toEqual(argv);
    expect(withMendMcp(["claude", "-p"], PersonalMcp.none("no servers"))).toEqual([
      "claude",
      ...mendMcpFlags("claude"),
      "-p",
    ]);
  });

  it("gives another command none of them", () => {
    expect(withMendMcp(["codex", "exec"], delivered("claude", claude.flags))).toEqual([
      "codex",
      ...mendMcpFlags("codex"),
      "exec",
    ]);
  });

  it("reaches the command a prompt starts, so the prompt wrapper itself carries no flag", () => {
    const prompted = withPrompt(["claude", "--model", "opus"], "fix it");
    expect(prompted.some((arg) => arg.startsWith("--mcp-config"))).toBe(false);
    expect(promptCommandOf(withMendMcp(prompted, delivered("claude", claude.flags)))).toEqual([
      "claude",
      ...mendMcpFlags("claude"),
      ...claude.flags,
      "--model",
      "opus",
    ]);
  });
});
