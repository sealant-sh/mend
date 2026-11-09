// A person's own MCP servers at launch (docs/adr/0024) in an executor that shares one home: what
// the agent is given, where the values go, and when they are kept back.

import { McpServerId, type SessionId } from "@mend/domain";
import { McpServerName, McpServerUrl, Session, type McpTransport } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { mendMcpFlags } from "../src/mend-mcp/launch.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { lifecycleLayer } from "./engine/capture-fixture.ts";
import {
  isPickupExec,
  mcpServersLayerOf,
  now,
  recordingProtocolHostLayer,
  redeemPickupExec,
  setup,
  type World,
  withEngine,
} from "./engine/fixture.ts";
import { secretForms } from "./pickup-channel.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefSECRETvalue";
const FIGMA_HEADER = "Bearer figma_0123456789SECRETheader";

const sealed = (name: string, transport: McpTransport, secrets: Record<string, string> | null) => ({
  id: McpServerId.make(`mcp-${name}`),
  name: McpServerName.make(name),
  transport,
  sealedSecrets: secrets === null ? null : `sealed:${JSON.stringify(secrets)}`,
});

const OWNERS_SERVERS = [
  sealed(
    "github",
    { _tag: "stdio", command: "npx", args: ["-y", "server-github"] },
    {
      GITHUB_TOKEN,
    },
  ),
  sealed(
    "figma",
    { _tag: "http", url: McpServerUrl.make("https://mcp.figma.com/mcp") },
    {
      Authorization: FIGMA_HEADER,
    },
  ),
  sealed("slack", { _tag: "sse", url: McpServerUrl.make("https://mcp.slack.com/sse") }, null),
];

interface Launched {
  readonly spawned: ReadonlyArray<ReadonlyArray<string>>;
  readonly execs: ReadonlyArray<ReadonlyArray<string>>;
  readonly created: ReadonlyArray<CreateOptions>;
  /** Every file a pickup wrote, by path. */
  readonly written: ReadonlyMap<string, string>;
  readonly world: World;
  readonly sessionId: SessionId;
}

/** One launch of `harness` in a fresh executor that shares one home, by the session's owner. */
const launch = async (input: {
  readonly harness: "claude" | "codex";
  readonly protocol: boolean;
  readonly onceShared?: boolean;
}): Promise<Launched> => {
  const spawned: Array<ReadonlyArray<string>> = [];
  const execs: Array<ReadonlyArray<string>> = [];
  const created: Array<CreateOptions> = [];
  const tokenEvents: Array<string> = [];
  const written = new Map<string, string>();
  let sessionId: SessionId | null = null;
  let world: World | null = null;
  const launchOf = () => tokenEvents.findLast((event) => event.startsWith("issue:"))?.slice(6);
  await withEngine(
    (at, tmp) =>
      Effect.gen(function* () {
        world = at;
        const project = yield* setup(tmp, at);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness: input.harness,
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        sessionId = session.id;
        if (input.onceShared === true) {
          const row = at.sessions.get(session.id);
          if (row === undefined) return yield* Effect.die("no session");
          at.sessions.set(session.id, new Session({ ...row, sharedControlEverAt: now() }));
        }
        if (input.protocol) {
          yield* engine.launchProtocol(session.id, { mode: "protocol" }, "user-fixture");
        } else {
          yield* engine.launch(session.id, [input.harness]);
        }
      }),
    {
      captured: makeMemoryCaptureStore(),
      tokenEvents,
      mcpServersLayer: mcpServersLayerOf((accountId) =>
        Effect.succeed(accountId === "user-fixture" ? OWNERS_SERVERS : []),
      ),
      protocolHostLayer: recordingProtocolHostLayer([], []),
      sealantLayer: lifecycleLayer(created, {
        spawned,
        execCalls: execs,
        captureOps: {
          execEffect: (argv) =>
            isPickupExec(argv) && argv[3] === "mend-write"
              ? redeemPickupExec(argv, sessionId, launchOf() ?? null).pipe(
                  Effect.map((answer) => {
                    for (const file of answer.files) {
                      written.set(file.path, Buffer.from(file.base64, "base64").toString("utf8"));
                    }
                    return { exitCode: 0, stdout: "", stderr: "" };
                  }),
                  Effect.orDie,
                )
              : undefined,
        },
      }),
    },
  );
  if (sessionId === null || world === null) throw new Error("the launch did not run");
  return { spawned, execs, created, written, world, sessionId };
};

const agentArgv = (launched: Launched, harness: string) =>
  launched.spawned.findLast((argv) => argv.includes(harness)) ?? [];

const noValueReachesThePlatform = (launched: Launched) => {
  const everything = [
    ...launched.execs.map((argv) => argv.join("\u0000")),
    ...launched.spawned.map((argv) => argv.join("\u0000")),
    ...launched.created.map((options) => JSON.stringify(options)),
  ].join("\n");
  for (const secret of [GITHUB_TOKEN, FIGMA_HEADER]) {
    for (const form of secretForms(new TextEncoder().encode(secret))) {
      expect(everything).not.toContain(form);
    }
  }
};

const summaryOf = (launched: Launched) => launched.world.sessions.get(launched.sessionId)?.summary;

describe("a person's own MCP servers in an executor that shares one home (docs/adr/0024)", () => {
  it("a cold Claude launch gets the owner's servers from root's directory, beside Mend's own", async () => {
    const launched = await launch({ harness: "claude", protocol: false });
    const argv = agentArgv(launched, "claude");
    const at = argv.indexOf("claude");
    expect(argv.slice(at, at + 4)).toEqual([
      "claude",
      ...mendMcpFlags("claude"),
      "--mcp-config=/run/mend/mcp/claude.json",
    ]);
    expect(JSON.parse(launched.written.get("/run/mend/mcp/claude.json") ?? "")).toEqual({
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "server-github"],
          env: { GITHUB_TOKEN },
        },
        figma: {
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: { Authorization: FIGMA_HEADER },
        },
        slack: { type: "sse", url: "https://mcp.slack.com/sse" },
      },
    });
    noValueReachesThePlatform(launched);
    expect(summaryOf(launched)).toContain("MCP servers · github, figma, slack");
  }, 30_000);

  it("a Codex launch gets one override a server, skips SSE, and says so", async () => {
    const launched = await launch({ harness: "codex", protocol: true });
    const argv = agentArgv(launched, "codex");
    expect(argv.filter((arg) => arg.startsWith("--config=mcp_servers."))).toEqual([
      '--config=mcp_servers.github={command="/bin/sh", args=["/run/mend/mcp/codex/github.sh"]}',
      `--config=mcp_servers.figma={url="https://mcp.figma.com/mcp", http_headers_helper="cat '/run/mend/mcp/codex/figma.headers.json'"}`,
    ]);
    expect(launched.written.get("/run/mend/mcp/codex/github.sh")).toBe(
      `export GITHUB_TOKEN='${GITHUB_TOKEN}'\nexec 'npx' '-y' 'server-github'\n`,
    );
    expect(
      JSON.parse(launched.written.get("/run/mend/mcp/codex/figma.headers.json") ?? ""),
    ).toEqual({ Authorization: FIGMA_HEADER });
    noValueReachesThePlatform(launched);
    expect(summaryOf(launched)).toContain(
      "MCP servers · github, figma · not for Codex: slack (SSE)",
    );
  }, 30_000);

  it("records the agent's command before any MCP flag on its process row", async () => {
    for (const launched of [
      await launch({ harness: "claude", protocol: false }),
      await launch({ harness: "codex", protocol: true }),
    ]) {
      const rows = [...launched.world.processes.values()].filter(
        (process) => process.sessionId === launched.sessionId,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.argv.some((arg) => /mcp-config|mcp_servers/.test(arg))).toBe(false);
      }
    }
  }, 60_000);

  it("keeps the owner's servers from a once-shared conversation, whose turns other people send", async () => {
    const launched = await launch({ harness: "claude", protocol: true, onceShared: true });
    const argv = agentArgv(launched, "claude");
    expect(argv.some((arg) => arg.includes("/run/mend/mcp"))).toBe(false);
    expect(argv).toContain(mendMcpFlags("claude")[0]);
    expect([...launched.written.keys()].some((file) => file.includes("/mcp/"))).toBe(false);
    expect(summaryOf(launched)).toContain(
      "MCP servers not delivered: this workspace shares one home, and the session is under shared control",
    );
  }, 30_000);

  it("still gives them to a once-shared terminal: typing in the owner's terminal is 7a's exception", async () => {
    const launched = await launch({ harness: "claude", protocol: false, onceShared: true });
    expect(agentArgv(launched, "claude")).toContain("--mcp-config=/run/mend/mcp/claude.json");
  }, 30_000);
});
