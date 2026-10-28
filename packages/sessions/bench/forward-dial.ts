/**
 * Cold-dial measurement for the forward adapter (ADR 0017, delivery 5). Runs the adapter itself
 * against a Core and one workspace, and writes one JSON line per dial or request.
 *
 *   node packages/sessions/bench/forward-dial.ts <mode> --core <url> --key <service key>
 *     --owner <sealant user id> --workspace <id> --port <n> [--session <process session id>]
 *     [--runs 100] [--series <label>] --out <file.jsonl>
 *
 * Modes:
 *   probe   `runs` sequential probes: open a forward, close it, read no bytes.
 *   cold    `runs` sequential HTTP/1.1 GETs, each on a new forward (the Agent is destroyed after
 *           each), so every request pays a dial.
 *   warm    one keep-alive Agent; `runs` sequential GETs over it, so only the first dials.
 *
 * A dial line is the adapter's `ForwardDialRecord` (`kind: ready | failed`, `lookupMs`,
 * `attempts[].openMs`, `totalMs`). A request line is `{ kind: "request", ttfbMs, totalMs, dialled }`.
 * `forward-dial-summary.ts` reads the files back.
 */
import { appendFileSync } from "node:fs";
import * as http from "node:http";
import { parseArgs } from "node:util";

import { SealantWorkspaceId } from "@mend/domain";
import {
  ForwardSessionOwner,
  openWorkspaceForward,
  SealantClient,
  toPlatformError,
} from "@mend/sealant";
import { Sealant } from "@sealant/sdk";
import { Effect, Layer } from "effect";

import { ForwardAgent, forwardSockets } from "../src/forward-node.ts";
import {
  ForwardAdapter,
  ForwardAdapterLive,
  type ForwardDialRecord,
  type ForwardTarget,
} from "../src/forward.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    core: { type: "string" },
    key: { type: "string" },
    owner: { type: "string" },
    workspace: { type: "string" },
    port: { type: "string" },
    session: { type: "string" },
    runs: { type: "string", default: "100" },
    series: { type: "string" },
    out: { type: "string" },
  },
});

const required = (name: string, value: string | undefined): string => {
  if (value === undefined || value === "") throw new Error(`--${name} is required`);
  return value;
};

const mode = positionals[0];
if (mode !== "probe" && mode !== "cold" && mode !== "warm") {
  throw new Error("mode must be probe, cold or warm");
}
const runs = Number(values.runs);
const out = required("out", values.out);
const target: ForwardTarget = {
  workspaceId: SealantWorkspaceId.make(required("workspace", values.workspace)),
  port: Number(required("port", values.port)),
  binding:
    values.session === undefined
      ? { kind: "port" }
      : { kind: "session", session: ForwardSessionOwner.make(values.session) },
};
const series = values.series ?? `${mode}-${target.binding.kind}-${target.port}`;

const sdk = new Sealant({
  baseUrl: required("core", values.core),
  apiKey: required("key", values.key),
  ownerUserId: required("owner", values.owner),
});

const platform = Layer.mock(SealantClient, {
  getWorkspace: (id) =>
    Effect.tryPromise({ try: () => sdk.workspaces.get(id), catch: toPlatformError }),
  openForward: (workspace, port, destination, options) =>
    openWorkspaceForward(workspace, port, destination, options, toPlatformError),
});
const adapter = ForwardAdapterLive.pipe(Layer.provide(platform));

const write = (line: object) => appendFileSync(out, `${JSON.stringify({ series, ...line })}\n`);
const dialLine = (record: ForwardDialRecord) => write(record);

const request = (agent: http.Agent) =>
  new Promise<{ readonly ttfbMs: number; readonly totalMs: number; readonly status: number }>(
    (resolve, reject) => {
      const started = performance.now();
      const outgoing = http.request(
        {
          host: "bench.invalid",
          port: 80,
          path: "/",
          agent,
          headers: { connection: "keep-alive" },
        },
        (incoming) => {
          const ttfbMs = performance.now() - started;
          incoming.resume();
          incoming.on("end", () =>
            resolve({
              ttfbMs,
              totalMs: performance.now() - started,
              status: incoming.statusCode ?? 0,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    },
  );

const main = Effect.gen(function* () {
  const forwards = yield* ForwardAdapter;
  if (mode === "probe") {
    for (let i = 0; i < runs; i++) {
      dialLine(yield* forwards.probe(target, { purpose: "benchmark" }));
    }
    return;
  }
  const connect = yield* forwardSockets;
  let dials = 0;
  const makeAgent = () =>
    new ForwardAgent(
      () => {
        dials += 1;
        return connect(target, { purpose: "benchmark", observe: dialLine });
      },
      { maxSockets: 1, maxFreeSockets: 1, timeout: 60_000 },
    );
  let agent = makeAgent();
  for (let i = 0; i < runs; i++) {
    const before = dials;
    const answer = yield* Effect.promise(() => request(agent));
    write({ kind: "request", index: i, ...answer, dialled: dials > before });
    if (mode === "cold") {
      agent.destroy();
      agent = makeAgent();
    }
  }
  agent.destroy();
});

await Effect.runPromise(main.pipe(Effect.provide(adapter)));
await sdk.close();
