import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  EnvironmentHttpApi,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Schedule from "effect/Schedule";

import { WEBSOCKET_TICKET_QUERY_PARAM } from "../src/ws.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { bearer, PERSON, tokenRequest } from "./support/gateway.ts";
import { connectWsRpc } from "./support/rpc.ts";

const freePort = Effect.callback<number>((resume) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close(() => resume(Effect.succeed(port)));
  });
});

const gatewayProcess = (mend: FakeMend, statePath: string) =>
  Effect.gen(function* () {
    const port = yield* freePort;
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [join(import.meta.dirname, "../src/bin.ts")], {
          env: {
            ...process.env,
            MEND_T3_GATEWAY_MEND_URL: mend.url.href,
            MEND_T3_GATEWAY_HOST: "127.0.0.1",
            MEND_T3_GATEWAY_PORT: String(port),
            MEND_T3_GATEWAY_STATE_PATH: statePath,
            MEND_T3_GATEWAY_LABEL: "Mend under test",
          },
          stdio: "ignore",
        }),
      ),
      (spawned) => Effect.sync(() => spawned.kill("SIGKILL")),
    );
    const url = `http://127.0.0.1:${port}`;
    yield* Effect.tryPromise(() => fetch(`${url}/.well-known/t3/environment`)).pipe(
      Effect.filterOrFail((response) => response.ok),
      Effect.retry({ times: 150, schedule: Schedule.spaced("100 millis") }),
    );
    return { child, url };
  });

const killed = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    child.once("exit", () => resume(Effect.void));
    child.kill("SIGKILL");
  });

const connect = (mend: FakeMend, url: string, code: string) =>
  Effect.gen(function* () {
    mend.addPairingCode(code, PERSON);
    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: url });
    const access = yield* client.auth.token(tokenRequest(code, { client_device_type: "desktop" }));
    const ticket = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
    const socket = new URL("/ws", url);
    socket.protocol = "ws:";
    socket.searchParams.set(WEBSOCKET_TICKET_QUERY_PARAM, ticket.ticket);
    socket.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    return yield* connectWsRpc(socket.toString());
  }).pipe(Effect.provide(FetchHttpClient.layer));

const THREAD = ThreadId.make("draft-killed");

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

describe("a setup cut short by SIGKILL", () => {
  it.live(
    "stops the shell Mend kept before the retry types the script again",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
        const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-kill-")), "state.sqlite");

        const first = yield* gatewayProcess(mend, statePath);
        const before = yield* connect(mend, first.url, "KILLED");
        yield* before[WS_METHODS.serverUpdateSettings]({
          patch: {
            projectScriptOverrides: {
              [ProjectId.make("project-1")]: [
                {
                  id: "install",
                  name: "Install",
                  command: "pnpm install",
                  icon: "configure",
                  runOnWorktreeCreate: true,
                  async: false,
                },
              ],
            },
          },
        });
        yield* before[ORCHESTRATION_V2_WS_METHODS.launchThread]({
          commandId: CommandId.make("kill-launch"),
          threadId: THREAD,
          projectId: ProjectId.make("project-1"),
          title: "Install and test",
          generateTitle: false,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
          initialMessage: {
            messageId: MessageId.make("message-killed"),
            text: "Run the tests",
            attachments: [],
          },
        });
        yield* eventually(() => mend.tty.scriptRuns.length === 1, "the setup script");
        const orphan = mend.tty.scriptRuns[0] ?? "";
        yield* killed(first.child);
        assert.isTrue(mend.tty.shells.get(orphan)?.running, "Mend keeps the killed setup's shell");

        mend.tty.scripts.set("pnpm install", { lines: ["Done"], exitCode: 0 });
        const second = yield* gatewayProcess(mend, statePath);
        const after = yield* connect(mend, second.url, "RESTARTED");
        const projection = yield* after[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const run = projection.runs[0];
        assert.strictEqual(run?.status, "failed");
        if (run === undefined) return;
        yield* after[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "prepared-run.retry",
          commandId: CommandId.make("kill-retry"),
          threadId: THREAD,
          runId: run.id,
        });
        yield* eventually(() => mend.tty.scriptRuns.length === 2, "the retried setup script");
        assert.isFalse(
          mend.tty.shells.get(orphan)?.running,
          "the killed setup's shell was stopped before the retry typed the script",
        );
        yield* eventually(
          () =>
            mend.workbench.calls.filter(
              (call) => call.method === "POST" && call.path.endsWith("/turns"),
            ).length === 1,
          "the opening turn",
        );
        const running = Array.from(mend.tty.shells.values()).filter((shell) => shell.running);
        assert.isAtMost(running.length, 1);
      }).pipe(Effect.scoped),
    60_000,
  );
});
