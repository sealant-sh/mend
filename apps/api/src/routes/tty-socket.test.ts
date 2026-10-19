import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import {
  SessionControlEventsRepo,
  SessionsRepo,
  UpgradeTicketsRepo,
  makeUpgradeTicketsMemory,
} from "@mend/db";
import { SealantWorkspaceId, SessionProcessId } from "@mend/domain";
import { SessionProcess } from "@mend/domain/workbench";
import { SealantClient, SealantPrincipal } from "@mend/sealant";
import { SessionEngine, WorkspaceCaller } from "@mend/sessions";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";

import {
  CAROL_SESSION_IN_SHARED_A,
  CAROL_SHELL_IN_SHARED_A,
  createTenancyWorld,
  type HarnessUser,
} from "../../test/support/tenancy-harness.ts";
import { ProjectAccessLive } from "../access.ts";
import { Budgets, DEFAULT_BUDGET_LIMITS, makeBudgets } from "../budgets.ts";
import { ConnectionRegistry, makeConnectionRegistry } from "../connections.ts";
import { SessionSteeringLive } from "../session-steering.ts";
import { TtyRoutes } from "./tty.ts";
import { scopeOf, UrlBearers } from "./upgrade-tickets.ts";

type Workspace = Effect.Success<ReturnType<SealantClient["Service"]["getWorkspace"]>>;
type PlatformSession = Effect.Success<ReturnType<SealantClient["Service"]["getSession"]>>;
type Attachment = Awaited<ReturnType<PlatformSession["attach"]>>;
const unused = (): never => {
  throw new Error("unused owned terminal fixture capability");
};
const BANNER = new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d, 0x00, 0xff]);
const LIVE_OUTPUT = new Uint8Array([0x72, 0x65, 0x61, 0x64, 0x79, 0x0d, 0x0a, 0x80]);
const INPUT = new Uint8Array([0x6c, 0x73, 0x0d, 0x00, 0xff]);

const makeAttachment = () => {
  const ended = Promise.withResolvers<"closed">();
  const closed = Effect.runSync(Deferred.make<void>());
  const written = Effect.runSync(Deferred.make<void>());
  const inputs: Array<string | Uint8Array> = [];
  const resizes: Array<readonly [number, number]> = [];
  const queued: Array<Uint8Array> = [BANNER];
  let pending: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  let finished = false;
  let closeCount = 0;
  const attachment: Attachment = {
    send: (input) => {
      inputs.push(typeof input === "string" ? input : Uint8Array.from(input));
    },
    resize: (cols, rows) => {
      resizes.push([cols, rows]);
      Effect.runSync(Deferred.succeed(written, undefined));
    },
    output: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const value = queued.shift();
          if (value !== undefined) return Promise.resolve({ value, done: false });
          if (finished) return Promise.resolve({ value: undefined, done: true });
          if (pending !== undefined) throw new Error("concurrent owned PTY reads");
          return new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pending = resolve;
          });
        },
      }),
    },
    closed: ended.promise,
    close: () => {
      closeCount++;
      finished = true;
      pending?.({ value: undefined, done: true });
      pending = undefined;
      ended.resolve("closed");
      Effect.runSync(Deferred.succeed(closed, undefined));
    },
  };
  const output = (bytes: Uint8Array) => {
    if (finished) throw new Error("output after owned PTY attachment close");
    const wake = pending;
    pending = undefined;
    if (wake === undefined) queued.push(bytes);
    else wake({ value: bytes, done: false });
  };
  return { attachment, output, inputs, resizes, closed, written, closeCount: () => closeCount };
};
const platformWorkspace = (id: string): Workspace => ({
  id,
  name: "owned terminal",
  launch: undefined,
  status: unused,
  runtimeDeadline: unused,
  runtime: unused,
  image: unused,
  processUser: unused,
  ready: unused,
  phase: unused,
  harness: { run: unused, start: unused, session: unused },
  exec: unused,
  bind: unused,
  capture: { flush: unused, status: unused, replan: unused },
  sessions: { open: unused, get: unused, list: unused },
  events: unused,
  stop: unused,
  recover: unused,
  captureDrain: unused,
  restart: unused,
  credentials: { put: unused, release: unused, list: unused },
  dotfiles: { apply: unused },
  expire: unused,
  sshAsRoot: unused,
  forward: unused,
});
const wait = (signal: Deferred.Deferred<void>) =>
  Effect.runPromise(Deferred.await(signal).pipe(Effect.timeout("3 seconds")));

const CAROL_AGENT_IN_SHARED_A = SessionProcessId.make("process-shared-a-carol-agent");
const carolAgent = new SessionProcess({
  id: CAROL_AGENT_IN_SHARED_A,
  sessionId: CAROL_SESSION_IN_SHARED_A,
  sealantWorkspaceId: SealantWorkspaceId.make("workspace-shared-a"),
  sealantSessionId: "platform-process-shared-a-carol-agent",
  sealantRunId: null,
  launchCorrelationId: null,
  serviceId: null,
  attemptOrdinal: null,
  kind: "agent-pty",
  harness: "claude",
  providerSessionId: null,
  protocolOptions: null,
  label: "claude",
  argv: ["claude"],
  status: "running",
  exitCode: null,
  workspacePort: null,
  protocol: "tcp",
  hostPort: null,
  createdAt: new Date("2026-10-19T09:00:00.000Z"),
  exitedAt: null,
  updatedAt: new Date("2026-10-19T09:00:00.000Z"),
});

const startServer = async (
  address: "process" | "session",
  privateProject: boolean,
  process: SessionProcessId = CAROL_SHELL_IN_SHARED_A,
  /** What the engine answers each key: whether it cleared a wait. */
  clears = true,
) => {
  const world = await createTenancyWorld(
    [],
    process === CAROL_AGENT_IN_SHARED_A ? [carolAgent] : [],
  );
  const typed: Array<SessionProcessId> = [];
  const pty = makeAttachment();
  const audits: Array<Parameters<SessionControlEventsRepo["Service"]["record"]>[0]> = [];
  const lookups: Array<{
    operation: string;
    workspace: string;
    session?: string;
    principal: unknown;
  }> = [];
  const attaches: Array<bigint | undefined> = [];
  const permissions: Array<string> = [];
  const connection = Effect.runSync(makeConnectionRegistry);
  const tickets = makeUpgradeTicketsMemory();
  const server = createServer();
  const platform = Layer.mock(SealantClient, {
    getWorkspace: (id) =>
      Effect.gen(function* () {
        lookups.push({ operation: "workspace", workspace: id, principal: yield* SealantPrincipal });
        return platformWorkspace(id);
      }),
    getSession: (workspace, id) =>
      Effect.gen(function* () {
        lookups.push({
          operation: "session",
          workspace: workspace.id,
          session: id,
          principal: yield* SealantPrincipal,
        });
        const session: PlatformSession = {
          id,
          workspaceId: workspace.id,
          runId: "owned-run",
          mode: "pty",
          send: unused,
          output: unused,
          resize: unused,
          signal: unused,
          status: unused,
          close: unused,
          attach: async (options) => {
            attaches.push(options?.from);
            return pty.attachment;
          },
        };
        return session;
      }),
  });
  const dependencies = Layer.mergeAll(
    world.authLayer,
    world.accessLayers,
    platform,
    Layer.succeed(ConnectionRegistry, connection),
    Layer.succeed(Budgets, makeBudgets(DEFAULT_BUDGET_LIMITS)),
    Layer.succeed(UpgradeTicketsRepo, tickets),
    Layer.succeed(UrlBearers, { mode: "refuse" }),
    Layer.mock(WorkspaceCaller, {
      mayAct: (workspace) =>
        Effect.gen(function* () {
          const principal = yield* SealantPrincipal;
          expect(principal).toEqual({ kind: "user", userId: "carol" });
          permissions.push(workspace);
        }),
      observe: () => (self) => self,
      act: () => (self) => self,
      observeRun: () => (self) => self,
      observeRunStream: () => (self) => self,
    }),
    Layer.mock(SessionControlEventsRepo, {
      record: (event) =>
        Effect.sync(() => {
          audits.push(event);
        }),
    }),
    Layer.mock(SessionEngine, {
      launchUnderWay: () => false,
      personTyped: (processId) =>
        Effect.sync(() => {
          typed.push(processId);
          return clears;
        }),
    }),
  );
  const authorization = SessionSteeringLive.pipe(
    Layer.provideMerge(ProjectAccessLive),
    Layer.provideMerge(dependencies),
  );
  const runtime = ManagedRuntime.make(
    HttpRouter.serve(TtyRoutes.pipe(Layer.provide(authorization)), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provide(NodeHttpServer.layer(() => server, { port: 0, host: "127.0.0.1" }))),
  );
  const clients = new Set<WebSocket>();
  try {
    await Effect.runPromise(
      Effect.flatMap(SessionsRepo, (repo) =>
        repo.setSharedControl(CAROL_SESSION_IN_SHARED_A, "carol"),
      ).pipe(Effect.provide(world.accessLayers)),
    );
    if (privateProject) world.setVisibility("shared-a", "private");
    await runtime.runPromise(Effect.void);
    const listening = server.address();
    if (listening === null || typeof listening === "string")
      throw new Error("no owned HTTP server address");
    const query = address === "process" ? { process } : { session: CAROL_SESSION_IN_SHARED_A };
    return {
      world,
      typed,
      pty,
      audits,
      lookups,
      attaches,
      permissions,
      connection,
      connect: async (user: HarnessUser) => {
        const ticket = await Effect.runPromise(
          tickets.mint({
            userId: user,
            credential: null,
            target: "tty",
            scope: scopeOf("tty", query),
          }),
        );
        const params = new URLSearchParams({ ...query, ticket: ticket.ticket, from: "17" });
        const client = new WebSocket(`ws://127.0.0.1:${listening.port}/api/tty?${params}`);
        clients.add(client);
        client.binaryType = "arraybuffer";
        const open = Effect.runSync(Deferred.make<void>());
        const banner = Effect.runSync(Deferred.make<void>());
        const live = Effect.runSync(Deferred.make<void>());
        const closed = Effect.runSync(Deferred.make<void>());
        const output: Array<Uint8Array> = [];
        client.addEventListener("open", () => Effect.runSync(Deferred.succeed(open, undefined)), {
          once: true,
        });
        client.addEventListener("message", (event) => {
          if (!(event.data instanceof ArrayBuffer)) throw new Error("expected binary PTY output");
          output.push(new Uint8Array(event.data));
          Effect.runSync(Deferred.succeed(output.length === 1 ? banner : live, undefined));
        });
        client.addEventListener(
          "close",
          () => Effect.runSync(Deferred.succeed(closed, undefined)),
          { once: true },
        );
        await wait(open);
        await wait(banner);
        return {
          client,
          output,
          live,
          close: async () => {
            client.close();
            await wait(closed);
            await wait(pty.closed);
          },
        };
      },
      close: async () => {
        for (const client of clients) client.close();
        await runtime.dispose();
        pty.attachment.close();
        await world.dispose();
      },
    };
  } catch (error) {
    await runtime.dispose();
    pty.attachment.close();
    await world.dispose();
    throw error;
  }
};

describe("admitted terminal sockets", () => {
  for (const address of ["process", "session"] as const) {
    it.each([
      { name: "visible owner", user: "carol", privateProject: false, typing: true },
      { name: "shared viewer", user: "alice", privateProject: false, typing: false },
      {
        name: "owner admitted after visibility loss",
        user: "carol",
        privateProject: true,
        typing: false,
      },
    ] as const)(
      `${address}: $name receives output; only the admitted visible owner types/resizes`,
      async (scenario) => {
        const server = await startServer(address, scenario.privateProject);
        try {
          const socket = await server.connect(scenario.user);
          expect(socket.output).toEqual([BANNER]);
          socket.client.send(INPUT);
          socket.client.send(JSON.stringify({ t: "input", data: "pwd\r" }));
          socket.client.send(JSON.stringify({ t: "resize", cols: 132, rows: 47 }));
          if (scenario.typing) await wait(server.pty.written);
          server.pty.output(LIVE_OUTPUT);
          await wait(socket.live);
          expect(socket.output).toEqual([BANNER, LIVE_OUTPUT]);
          // Close is ordered after preceding client frames. The actual runRaw consumer then exits,
          // finalizes the platform attachment and unregisters the connection before negative assertions.
          await socket.close();
          expect(server.pty.inputs).toEqual(scenario.typing ? [INPUT, "pwd\r"] : []);
          expect(server.typed).toEqual([]);
          expect(server.pty.resizes).toEqual(scenario.typing ? [[132, 47]] : []);
          expect(server.pty.closeCount()).toBe(1);
          expect(
            await Effect.runPromise(server.connection.countFor(scenario.user, "terminal")),
          ).toBe(0);
          expect(server.attaches).toEqual([17n]);
          const target =
            address === "process"
              ? server.world.processes.get(CAROL_SHELL_IN_SHARED_A)
              : server.world.sessions.get(CAROL_SESSION_IN_SHARED_A);
          if (
            target === undefined ||
            target.sealantWorkspaceId === null ||
            target.sealantSessionId === null
          )
            throw new Error("missing addressed fixture PTY");
          expect(server.lookups).toEqual([
            {
              operation: "workspace",
              workspace: target.sealantWorkspaceId,
              principal: { kind: "user", userId: "carol" },
            },
            {
              operation: "session",
              workspace: target.sealantWorkspaceId,
              session: target.sealantSessionId,
              principal: { kind: "user", userId: "carol" },
            },
          ]);
          expect(server.permissions).toEqual(scenario.typing ? [target.sealantWorkspaceId] : []);
          expect(server.audits).toEqual([
            {
              sessionId: CAROL_SESSION_IN_SHARED_A,
              actorUserId: scenario.user,
              kind: scenario.typing ? "terminal-attach" : "terminal-watch",
              refId: address === "process" ? CAROL_SHELL_IN_SHARED_A : null,
            },
          ]);
        } finally {
          await server.close();
        }
      },
    );
  }
});

describe("keys in a terminal agent's terminal (G4)", () => {
  it("tell the engine the person typed there, once per interval, and only for the owner who types", async () => {
    for (const scenario of [
      { user: "carol", typed: [CAROL_AGENT_IN_SHARED_A] },
      { user: "alice", typed: [] },
    ] as const) {
      const server = await startServer("process", false, CAROL_AGENT_IN_SHARED_A);
      try {
        const socket = await server.connect(scenario.user);
        socket.client.send(INPUT);
        socket.client.send(JSON.stringify({ t: "input", data: "y" }));
        socket.client.send(JSON.stringify({ t: "resize", cols: 132, rows: 47 }));
        if (scenario.user === "carol") await wait(server.pty.written);
        server.pty.output(LIVE_OUTPUT);
        await wait(socket.live);
        await socket.close();
        expect(server.typed).toEqual(scenario.typed);
      } finally {
        await server.close();
      }
    }
  });

  it("writes the emulator's own replies to the agent but reads only a key as the person typing", async () => {
    const server = await startServer("process", false, CAROL_AGENT_IN_SHARED_A, false);
    try {
      const socket = await server.connect("carol");
      const replies = "\x1b[?1;2c\x1b[>0;276;0c\x1b[24;1R\x1b[?0u\x1b[I";
      socket.client.send(new TextEncoder().encode(replies));
      socket.client.send(JSON.stringify({ t: "input", data: "\x1b[O" }));
      socket.client.send(JSON.stringify({ t: "input", data: "\r" }));
      socket.client.send(JSON.stringify({ t: "resize", cols: 132, rows: 47 }));
      await wait(server.pty.written);
      server.pty.output(LIVE_OUTPUT);
      await wait(socket.live);
      await socket.close();
      expect(
        server.pty.inputs.map((input) =>
          typeof input === "string" ? input : new TextDecoder().decode(input),
        ),
      ).toEqual([replies, "\x1b[O", "\r"]);
      expect(server.typed).toEqual([CAROL_AGENT_IN_SHARED_A]);
    } finally {
      await server.close();
    }
  });
});
