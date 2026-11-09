import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vm from "node:vm";

import type { McpSignInObserved } from "@mend/db";
import { McpServerUrl } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mendMcpFlags, withMendMcp } from "./launch.ts";
import { mcpPersonOf, WITHHELD_UNDER_SHARED_CONTROL } from "./personal.ts";
import {
  CLAUDE_SIGN_INS_PROGRAM,
  claudeSignInsFileOf,
  harvestedSignInsOf,
  keepHarvestedSignIns,
  SIGN_INS_ONLY_IN_OWN_HOME,
  signInFenceOf,
  SIGN_IN_WATCH_SOURCE,
  withClaudeSignIns,
} from "./sign-ins.ts";

const exec = promisify(execFile);
const FIGMA_URL = "https://mcp.figma.com/mcp";
const KEY = "figma|0123456789abcdef";
const LOGIN = { accessToken: "login-synthetic", refreshToken: "", expiresAt: 9_999_999_999_999 };

const entry = (expiresAt: number, token = `token-${expiresAt}`) => ({
  serverName: "figma",
  serverUrl: FIGMA_URL,
  accessToken: token,
  refreshToken: `refresh-${expiresAt}`,
  expiresAt,
  clientId: "client-synthetic",
  discoveryState: { authorizationServerUrl: "https://www.figma.com" },
});

// Core stores and syncs back the `claudeAiOauth` section alone, newest-wins on its expiresAt.
const coreLoginOf = (raw: string) => {
  const { claudeAiOauth } = JSON.parse(raw);
  return JSON.stringify({ claudeAiOauth });
};

describe("the put-back before Claude starts", () => {
  let dir: string;
  let config: string;
  let credentials: string;
  let plan: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-sign-ins-"));
    config = path.join(dir, "claude");
    credentials = path.join(config, ".credentials.json");
    plan = path.join(dir, "claude-sign-ins.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const putBack = async (keep: Record<string, unknown>, forget: ReadonlyArray<unknown> = []) => {
    await fs.writeFile(plan, JSON.stringify({ keep, forget }), { mode: 0o600 });
    const argv = withClaudeSignIns(["sh", "-c", 'echo "started $*"', "claude", "--resume"], plan);
    const [command, ...args] = argv;
    return exec(command ?? "sh", args, {
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: config },
    });
  };
  const held = async () => JSON.parse(await fs.readFile(credentials, "utf8"));

  it("writes a missing or older entry, keeps a newer one and the login, and starts Claude", async () => {
    await fs.mkdir(config);
    await fs.writeFile(
      credentials,
      JSON.stringify({
        claudeAiOauth: LOGIN,
        mcpOAuth: { [KEY]: entry(2_000), "other|1111111111111111": entry(5) },
        unknown: { kept: true },
      }),
      { mode: 0o600 },
    );
    const started = await putBack({
      [KEY]: entry(3_000),
      "linear|2222222222222222": { ...entry(10), serverName: "linear" },
      "other|1111111111111111": entry(1),
    });
    expect(started.stdout).toBe("started --resume\n");
    expect(started.stderr).toBe("");
    expect(await held()).toEqual({
      claudeAiOauth: LOGIN,
      mcpOAuth: {
        [KEY]: entry(3_000),
        "other|1111111111111111": entry(5),
        "linear|2222222222222222": { ...entry(10), serverName: "linear" },
      },
      unknown: { kept: true },
    });
    expect((await fs.stat(credentials)).mode & 0o777).toBe(0o600);
  });

  it("leaves a file that already holds the newest entries as it is", async () => {
    await fs.mkdir(config);
    await fs.writeFile(credentials, JSON.stringify({ mcpOAuth: { [KEY]: entry(3_000) } }));
    const before = await fs.stat(credentials);
    await putBack({ [KEY]: entry(3_000, "other-token") });
    expect(await held()).toEqual({ mcpOAuth: { [KEY]: entry(3_000) } });
    expect((await fs.stat(credentials)).ino).toBe(before.ino);
  });

  it("creates an absent file and its directory with the entries alone", async () => {
    await putBack({ [KEY]: entry(3_000) });
    expect(await held()).toEqual({ mcpOAuth: { [KEY]: entry(3_000) } });
    expect((await fs.stat(credentials)).mode & 0o777).toBe(0o600);
  });

  it("removes a forgotten server's entries and nothing else", async () => {
    await fs.mkdir(config);
    await fs.writeFile(
      credentials,
      JSON.stringify({
        claudeAiOauth: LOGIN,
        mcpOAuth: {
          [KEY]: entry(2_000),
          "figma|ffffffffffffffff": { ...entry(2_000), serverUrl: "https://elsewhere.example/mcp" },
        },
      }),
    );
    await putBack({}, [{ serverName: "figma", serverUrl: FIGMA_URL }]);
    expect(await held()).toEqual({
      claudeAiOauth: LOGIN,
      mcpOAuth: {
        "figma|ffffffffffffffff": { ...entry(2_000), serverUrl: "https://elsewhere.example/mcp" },
      },
    });
  });

  it("refuses a symlinked credentials file in one line, and Claude still starts", async () => {
    await fs.mkdir(config);
    const target = path.join(dir, "elsewhere.json");
    await fs.writeFile(target, JSON.stringify({ claudeAiOauth: LOGIN }));
    await fs.symlink(target, credentials);
    const started = await putBack({ [KEY]: entry(3_000) });
    expect(started.stdout).toBe("started --resume\n");
    expect(started.stderr).toBe(
      "mend: your MCP sign-ins were not put back: the Claude credentials file is not a regular file\n",
    );
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ claudeAiOauth: LOGIN });
  });

  it("starts Claude when the credentials file is not JSON, saying so without its contents", async () => {
    await fs.mkdir(config);
    await fs.writeFile(credentials, "token-in-a-broken-file");
    const started = await putBack({ [KEY]: entry(3_000) });
    expect(started.stdout).toBe("started --resume\n");
    expect(started.stderr).toBe(
      "mend: your MCP sign-ins were not put back: the Claude credentials file is not JSON\n",
    );
    expect(await fs.readFile(credentials, "utf8")).toBe("token-in-a-broken-file");
  });

  it("holds no single quote, so it can sit inside one", () => {
    expect(CLAUDE_SIGN_INS_PROGRAM).not.toContain("'");
  });

  it("leaves Core's login section exactly as Core wrote it", async () => {
    await fs.mkdir(config);
    const login = {
      accessToken: "login-synthetic",
      refreshToken: "login-refresh-synthetic",
      expiresAt: 1_800_000_000_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
    };
    const written = JSON.stringify({ claudeAiOauth: login });
    await fs.writeFile(credentials, written, { mode: 0o600 });
    await putBack({ [KEY]: entry(3_000) }, [
      { serverName: "linear", serverUrl: "https://mcp.linear.app/mcp" },
    ]);
    const after = await fs.readFile(credentials, "utf8");
    expect(coreLoginOf(after)).toBe(coreLoginOf(written));
    expect(Object.keys(JSON.parse(after)).toSorted()).toEqual(["claudeAiOauth", "mcpOAuth"]);
  });

  it("decides each entry on its own expiresAt, never the login's", async () => {
    await fs.mkdir(config);
    const later = { ...entry(4_000), serverName: "linear" };
    await fs.writeFile(
      credentials,
      JSON.stringify({
        claudeAiOauth: { ...LOGIN, expiresAt: 1 },
        mcpOAuth: { [KEY]: entry(2_000), "linear|3333333333333333": later },
      }),
    );
    await putBack({
      [KEY]: entry(3_000),
      "linear|3333333333333333": { ...entry(3_500), serverName: "linear" },
    });
    expect(await held()).toEqual({
      claudeAiOauth: { ...LOGIN, expiresAt: 1 },
      mcpOAuth: { [KEY]: entry(3_000), "linear|3333333333333333": later },
    });
  });
});

describe("withMendMcp with kept sign-ins", () => {
  const flags = ["--mcp-config=/home/anna/.mend/mcp/claude.json"];
  const file = "/home/anna/.mend/mcp/claude-sign-ins.json";

  it("puts Claude behind the put-back, inside env and with its flags", () => {
    const argv = withMendMcp(["env", "A=1", "claude", "-p"], {
      _tag: "Delivered",
      harness: "claude",
      flags,
      signIns: file,
    });
    expect(argv).toEqual([
      "env",
      "A=1",
      ...withClaudeSignIns(["claude", ...mendMcpFlags("claude"), ...flags, "-p"], file),
    ]);
  });

  it("leaves another harness, and a launch without sign-ins, unwrapped", () => {
    const signIns = { _tag: "Delivered", harness: "claude", flags, signIns: file } as const;
    expect(withMendMcp(["codex"], signIns)[0]).toBe("codex");
    expect(withMendMcp(["claude"], { ...signIns, signIns: null })[0]).toBe("claude");
  });
});

describe("the put-back's file", () => {
  const http = { _tag: "http", url: McpServerUrl.make(FIGMA_URL) } as const;

  it("keeps the entries of kept sign-ins and forgets the forgotten servers, never a stdio one", () => {
    const file = claudeSignInsFileOf({
      dir: "/run/mend/mcp",
      servers: [
        { name: "figma", transport: http, signIn: { key: KEY, entry: entry(1) }, forgotten: true },
        { name: "linear", transport: { ...http, _tag: "sse" }, signIn: null, forgotten: true },
        {
          name: "github",
          transport: { _tag: "stdio", command: "gh", args: [] },
          signIn: null,
          forgotten: true,
        },
        { name: "plain", transport: http, signIn: null, forgotten: false },
      ],
      readAt: 42,
    });
    expect(file?.path).toBe("/run/mend/mcp/claude-sign-ins.json");
    expect(JSON.parse(file?.content ?? "")).toEqual({
      readAt: 42,
      keep: { [KEY]: entry(1) },
      forget: [{ serverName: "linear", serverUrl: FIGMA_URL }],
    });
  });

  it("is not written when there is nothing to put back or forget", () => {
    expect(
      claudeSignInsFileOf({
        dir: "/run/mend/mcp",
        servers: [{ name: "plain", transport: http, signIn: null, forgotten: false }],
        readAt: 42,
      }),
    ).toBeNull();
  });
});

type WatchIo = {
  readonly credentials: string;
  readonly delivered: string;
  readonly stat: (path: string) => { mtimeMs: number; size: number; ino: number } | null;
  readonly read: (path: string) => string | null;
  readonly post: (entries: ReadonlyArray<unknown>) => Promise<"done" | "again">;
};

const isWatch = (value: unknown): value is (io: WatchIo) => { check: () => Promise<void> } =>
  typeof value === "function";

describe("the helper's watch over the credentials file", () => {
  const signInWatch: unknown = vm.runInNewContext(`${SIGN_IN_WATCH_SOURCE}; signInWatch`, {});
  if (!isWatch(signInWatch)) throw new Error("the watch source defines no signInWatch");

  const harness = () => {
    const files = new Map<string, { text: string; mtimeMs: number }>();
    const posts: Array<unknown> = [];
    const reads: Array<string> = [];
    let answer: "done" | "again" = "done";
    let clock = 0;
    const write = (file: string, value: unknown) =>
      files.set(file, { text: JSON.stringify(value), mtimeMs: ++clock });
    write("claude.json", {
      mcpServers: {
        figma: { type: "http", url: FIGMA_URL },
        events: { type: "sse", url: "https://events.example/sse" },
        github: { type: "stdio", command: "gh" },
      },
    });
    const watch = signInWatch({
      credentials: "credentials.json",
      delivered: "claude.json",
      stat: (file) => {
        const held = files.get(file);
        return held === undefined
          ? null
          : { mtimeMs: held.mtimeMs, size: held.text.length, ino: 1 };
      },
      read: (file) => {
        reads.push(file);
        return files.get(file)?.text ?? null;
      },
      post: (entries) => {
        posts.push(JSON.parse(JSON.stringify(entries)));
        return Promise.resolve(answer);
      },
    });
    return {
      watch,
      posts,
      reads,
      credentials: (value: unknown) => write("credentials.json", value),
      answer: (next: "done" | "again") => {
        answer = next;
      },
    };
  };

  it("posts the delivered HTTP and SSE servers' entries once, and again only when one changes", async () => {
    const io = harness();
    await io.watch.check();
    io.credentials({
      claudeAiOauth: LOGIN,
      mcpOAuth: {
        [KEY]: entry(1),
        "figma|elsewhere": { ...entry(1), serverUrl: "https://elsewhere.example/mcp" },
        "github|stdio": { ...entry(1), serverName: "github" },
        "repo-server|0000": { ...entry(1), serverName: "repo-server" },
      },
    });
    await io.watch.check();
    await io.watch.check();
    expect(io.posts).toEqual([[{ key: KEY, entry: entry(1) }]]);
    const readsBefore = io.reads.filter((file) => file === "credentials.json").length;
    await io.watch.check();
    expect(io.reads.filter((file) => file === "credentials.json")).toHaveLength(readsBefore);

    io.credentials({
      claudeAiOauth: LOGIN,
      mcpOAuth: {
        [KEY]: entry(2),
        "events|1": { ...entry(1), serverName: "events", serverUrl: "https://events.example/sse" },
      },
    });
    await io.watch.check();
    expect(io.posts[1]).toEqual([
      { key: KEY, entry: entry(2) },
      {
        key: "events|1",
        entry: { ...entry(1), serverName: "events", serverUrl: "https://events.example/sse" },
      },
    ]);
  });

  it("tries a post the channel could not take again at the next check", async () => {
    const io = harness();
    io.answer("again");
    io.credentials({ mcpOAuth: { [KEY]: entry(1) } });
    await io.watch.check();
    io.answer("done");
    await io.watch.check();
    await io.watch.check();
    expect(io.posts).toHaveLength(2);
  });

  it("never posts Core's login: a refreshed login alone posts nothing", async () => {
    const io = harness();
    io.credentials({ claudeAiOauth: LOGIN, mcpOAuth: { [KEY]: entry(1) } });
    await io.watch.check();
    io.credentials({
      claudeAiOauth: { ...LOGIN, expiresAt: LOGIN.expiresAt + 1 },
      mcpOAuth: { [KEY]: entry(1) },
    });
    await io.watch.check();
    expect(io.posts).toEqual([[{ key: KEY, entry: entry(1) }]]);
    expect(JSON.stringify(io.posts)).not.toContain("login-synthetic");
  });

  it("posts nothing for a file without sign-ins or that is not JSON", async () => {
    const io = harness();
    io.credentials({ claudeAiOauth: LOGIN });
    await io.watch.check();
    io.credentials("not json");
    await io.watch.check();
    expect(io.posts).toEqual([]);
  });
});

describe("what the channel keeps", () => {
  const harvested = harvestedSignInsOf({
    entries: [
      { key: KEY, entry: entry(1_700_000_000_000) },
      { key: "no-expiry", entry: { serverName: "figma", serverUrl: FIGMA_URL } },
      { key: "", entry: entry(1) },
      "not an entry",
    ],
  });

  it("reads each entry whole, and drops one it cannot read", () => {
    expect(harvested).toEqual({
      entries: [
        {
          key: KEY,
          serverName: "figma",
          serverUrl: FIGMA_URL,
          expiresAt: new Date(1_700_000_000_000),
          document: JSON.stringify(entry(1_700_000_000_000)),
        },
      ],
      readAt: null,
    });
    expect(harvestedSignInsOf({ entries: [], readAt: 7 })).toEqual({
      entries: [],
      readAt: new Date(7),
    });
    expect(harvestedSignInsOf({ entries: "no" })).toBeNull();
  });

  const keepAll = (
    person: Parameters<typeof keepHarvestedSignIns>[0]["person"],
    ownHome = true,
  ) => {
    const kept: Array<{ accountId: string; observed: McpSignInObserved }> = [];
    const answer = Effect.runSync(
      keepHarvestedSignIns({
        person,
        ownHome,
        processStartedAt: new Date(5),
        entries: harvested?.entries ?? [],
        seal: (document) => Effect.succeed(`sealed:${document.length}`),
        keep: (accountId, observed) => {
          kept.push({ accountId, observed });
          return Effect.succeed("kept");
        },
      }),
    );
    return { answer, kept };
  };

  it("credits the person the process carries the servers of, sealed", () => {
    const { answer, kept } = keepAll(
      mcpPersonOf({
        runsAs: "bob",
        holder: null,
        sessionOwner: "anna",
        onceShared: true,
        terminal: false,
      }),
    );
    expect(answer).toEqual({ _tag: "Kept", outcomes: [{ key: KEY, kept: "kept" }] });
    expect(kept).toEqual([
      {
        accountId: "bob",
        observed: expect.objectContaining({
          key: KEY,
          sealed: expect.stringMatching(/^sealed:/),
          processStartedAt: new Date(5),
        }),
      },
    ]);
  });

  it("keeps nothing from a process that carries no one's servers", () => {
    const { answer, kept } = keepAll(
      mcpPersonOf({
        runsAs: null,
        holder: "anna",
        sessionOwner: "anna",
        onceShared: true,
        terminal: false,
      }),
    );
    expect(answer).toEqual({ _tag: "Refused", why: WITHHELD_UNDER_SHARED_CONTROL });
    expect(kept).toEqual([]);
  });

  it("keeps nothing from a home that shares one set of logins, whoever's servers it carries", () => {
    const { answer, kept } = keepAll(
      mcpPersonOf({
        runsAs: null,
        holder: "anna",
        sessionOwner: "anna",
        onceShared: false,
        terminal: true,
      }),
      false,
    );
    expect(answer).toEqual({ _tag: "Refused", why: SIGN_INS_ONLY_IN_OWN_HOME });
    expect(kept).toEqual([]);
  });

  it("fences a harvest at the launch's read of the servers when that came before its start", () => {
    expect(signInFenceOf(new Date(100), new Date(40))).toEqual(new Date(40));
    expect(signInFenceOf(new Date(100), new Date(140))).toEqual(new Date(100));
    expect(signInFenceOf(new Date(100), null)).toEqual(new Date(100));
  });
});
