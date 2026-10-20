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

/** What a gateway process last wrote, for the message of a step that never ends. */
type Outputs = Array<() => string>;

const LISTENING = /Listening on (http:\/\/\S+)/;

/**
 * Another test can take the free port before the gateway binds it. Ready is the gateway's own
 * "Listening on" line, not an answer from whatever holds the port; a gateway that exits first
 * lost the port, and the next one gets another.
 */
const gatewayProcess = (mend: FakeMend, statePath: string, outputs: Outputs) =>
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
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
      (spawned) => Effect.sync(() => spawned.kill("SIGKILL")),
    );
    let output = "";
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-4096);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    outputs.push(() => `gateway on ${port}:\n${output}`);
    const url = yield* Effect.callback<string, Error>((resume) => {
      const listened = () => {
        const address = LISTENING.exec(output)?.[1];
        if (address === undefined) return;
        settle();
        resume(Effect.succeed(address));
      };
      const exited = () => {
        settle();
        resume(Effect.fail(new Error(`The gateway exited before it listened:\n${output}`)));
      };
      const settle = () => {
        child.stdout.off("data", listened);
        child.off("exit", exited);
      };
      child.stdout.on("data", listened);
      child.once("exit", exited);
      listened();
      return Effect.sync(settle);
    });
    return { child, url };
  }).pipe(Effect.retry({ times: 2 }));

const killed = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.void);
      return;
    }
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

const eventually = (condition: () => boolean) =>
  Effect.gen(function* () {
    while (!condition()) yield* Effect.sleep("50 millis");
  });

/** Bounds one step on its own, so a step that never ends fails naming itself. */
const within =
  (outputs: Outputs) =>
  (what: string) =>
  <A, E, R>(step: Effect.Effect<A, E, R>) =>
    step.pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.die(
            new Error(
              [`Timed out waiting for ${what}.`, ...outputs.map((output) => output())].join("\n"),
            ),
          ),
      }),
    );

describe("a setup cut short by SIGKILL", () => {
  it.live(
    "stops the shell Mend kept before the retry types the script again",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
        const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-kill-")), "state.sqlite");
        const outputs: Outputs = [];
        const step = within(outputs);

        const first = yield* gatewayProcess(mend, statePath, outputs).pipe(
          step("the first gateway to listen"),
        );
        const before = yield* connect(mend, first.url, "KILLED").pipe(step("the first pairing"));
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
        }).pipe(step("the setup action to save"));
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
        }).pipe(step("the launch"));
        yield* eventually(() => mend.tty.scriptRuns.length === 1).pipe(step("the setup script"));
        const orphan = mend.tty.scriptRuns[0] ?? "";
        yield* killed(first.child).pipe(step("the first gateway to exit"));
        assert.isTrue(mend.tty.shells.get(orphan)?.running, "Mend keeps the killed setup's shell");

        mend.tty.scripts.set("pnpm install", { lines: ["Done"], exitCode: 0 });
        const second = yield* gatewayProcess(mend, statePath, outputs).pipe(
          step("the second gateway to listen"),
        );
        const after = yield* connect(mend, second.url, "RESTARTED").pipe(
          step("the second pairing"),
        );
        const projection = yield* after[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        }).pipe(step("the thread after the restart"));
        const run = projection.runs[0];
        assert.strictEqual(run?.status, "failed");
        if (run === undefined) return;
        yield* after[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "prepared-run.retry",
          commandId: CommandId.make("kill-retry"),
          threadId: THREAD,
          runId: run.id,
        }).pipe(step("the retry"));
        yield* eventually(() => mend.tty.scriptRuns.length === 2).pipe(
          step("the retried setup script"),
        );
        assert.isFalse(
          mend.tty.shells.get(orphan)?.running,
          "the killed setup's shell was stopped before the retry typed the script",
        );
        yield* eventually(
          () =>
            mend.workbench.calls.filter(
              (call) => call.method === "POST" && call.path.endsWith("/turns"),
            ).length === 1,
        ).pipe(step("the opening turn"));
        const running = Array.from(mend.tty.shells.values()).filter((shell) => shell.running);
        assert.isAtMost(running.length, 1);
      }).pipe(Effect.scoped),
    60_000,
  );
});
