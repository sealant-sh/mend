import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AgentBridge, AgentBridgeLive } from "../src/agent-bridge.ts";
import { MendKeysConfig } from "../src/git-auth.ts";

const withBridge = <A, E>(work: Effect.Effect<A, E, AgentBridge>): Promise<A> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-bridge-"));
  const layer = AgentBridgeLive.pipe(Layer.provide(MendKeysConfig.layerFor(tmp)));
  return Effect.runPromise(
    work.pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true }))),
      Effect.orDie,
    ),
  );
};

/** A framed agent message: 4-byte BE length + payload. */
const agentMessage = (...bytes: ReadonlyArray<number>): Buffer => {
  const payload = Buffer.from(bytes);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
};

/** Open the bridged socket, write a request, resolve with the response. */
const askAgent = (socketPath: string, request: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const connection = net.connect(socketPath, () => {
      connection.write(request);
    });
    let pending: Buffer = Buffer.alloc(0);
    connection.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        connection.end();
        resolve(pending);
      }
    });
    connection.on("error", reject);
  });

describe("AgentBridge", () => {
  it("relays framed requests to the share client and answers verbatim", async () => {
    await withBridge(
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        expect((yield* bridge.status("u1")).connected).toBe(false);

        const seenContexts: string[] = [];
        // A fake share client that behaves like an agent: answers every
        // request with a canned "identities" response, echoing the id.
        const handleRef: { current: ((frame: string) => void) | null } = { current: null };
        const handle = yield* bridge.attach("u1", {
          name: "test-laptop",
          send: (frame) => {
            const parsed = JSON.parse(frame) as {
              id: number;
              context: string;
              payload: string;
            };
            seenContexts.push(parsed.context);
            const response = agentMessage(12, 0, 0, 0, 0); // SSH_AGENT_IDENTITIES_ANSWER, 0 keys
            handleRef.current?.(
              JSON.stringify({ t: "res", id: parsed.id, payload: response.toString("base64") }),
            );
          },
        });
        handleRef.current = handle.feed;

        const bridgeStatus = yield* bridge.status("u1");
        expect(bridgeStatus.connected).toBe(true);
        expect(bridgeStatus.clientName).toBe("test-laptop");

        // An op in flight names itself; the request carries the attribution.
        const end = yield* bridge.begin("u1", "adopt shimtest → ssh://localhost/repo");
        const answer = yield* Effect.promise(
          () => askAgent(bridge.socketPath("u1"), agentMessage(11)), // SSH_AGENTC_REQUEST_IDENTITIES
        );
        end();
        expect([...answer.subarray(4)]).toEqual([12, 0, 0, 0, 0]);
        expect(seenContexts).toEqual(["adopt shimtest → ssh://localhost/repo"]);

        // Detach tears the socket down; presence reads false again.
        handle.detach();
        expect((yield* bridge.status("u1")).connected).toBe(false);
        expect(fs.existsSync(bridge.socketPath("u1"))).toBe(false);
      }),
    );
  });

  it("answers SSH_AGENT_FAILURE when the client errs a request", async () => {
    await withBridge(
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        const handleRef: { current: ((frame: string) => void) | null } = { current: null };
        const handle = yield* bridge.attach("u1", {
          name: "flaky-laptop",
          send: (frame) => {
            const parsed = JSON.parse(frame) as { id: number };
            handleRef.current?.(
              JSON.stringify({ t: "err", id: parsed.id, message: "agent timeout" }),
            );
          },
        });
        handleRef.current = handle.feed;

        const answer = yield* Effect.promise(() =>
          askAgent(bridge.socketPath("u1"), agentMessage(13, 1, 2, 3)),
        );
        // [len=1][SSH_AGENT_FAILURE]
        expect([...answer]).toEqual([0, 0, 0, 1, 5]);
        handle.detach();
      }),
    );
  });

  it("a replaced share's late detach does not kill its successor", async () => {
    await withBridge(
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        const first = yield* bridge.attach("u1", { name: "first", send: () => {} });
        const second = yield* bridge.attach("u1", { name: "second", send: () => {} });
        first.detach(); // the ghost closes late
        const bridgeStatus = yield* bridge.status("u1");
        expect(bridgeStatus.connected).toBe(true);
        expect(bridgeStatus.clientName).toBe("second");
        second.detach();
        expect((yield* bridge.status("u1")).connected).toBe(false);
      }),
    );
  });

  it("attaches over a dead pod's leftover socket file", async () => {
    // A previous process's socket file survives on a shared mount (kubernetes: the RWX claim).
    // Attach must clear it and bind — a stale file must never require a manual rm.
    await withBridge(
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        yield* Effect.sync(() => {
          fs.mkdirSync(path.dirname(bridge.socketPath("u1")), { recursive: true, mode: 0o700 });
          fs.writeFileSync(bridge.socketPath("u1"), "");
        });
        const handle = yield* bridge.attach("u1", { name: "after-restart", send: () => {} });
        expect((yield* bridge.status("u1")).connected).toBe(true);
        expect(fs.statSync(bridge.socketPath("u1")).isSocket()).toBe(true);
        handle.detach();
      }),
    );
  });

  it("gives each account its own signer: one share neither answers for nor replaces another", async () => {
    await withBridge(
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        const aliceAsked: Array<string> = [];
        const aliceRef: { current: ((frame: string) => void) | null } = { current: null };
        const alice = yield* bridge.attach("alice", {
          name: "alice-laptop",
          send: (frame) => {
            const parsed = JSON.parse(frame) as { id: number; context: string };
            aliceAsked.push(parsed.context);
            aliceRef.current?.(
              JSON.stringify({
                t: "res",
                id: parsed.id,
                payload: agentMessage(12, 0, 0, 0, 0).toString("base64"),
              }),
            );
          },
        });
        aliceRef.current = alice.feed;

        expect(bridge.socketPath("alice")).not.toBe(bridge.socketPath("bob"));
        expect((yield* bridge.status("bob")).connected).toBe(false);
        expect(fs.existsSync(bridge.socketPath("bob"))).toBe(false);

        const bob = yield* bridge.attach("bob", { name: "bob-laptop", send: () => {} });
        expect((yield* bridge.status("alice")).clientName).toBe("alice-laptop");
        bob.detach();
        expect((yield* bridge.status("alice")).connected).toBe(true);

        const end = yield* bridge.begin("alice", "refresh api → origin");
        const answer = yield* Effect.promise(() =>
          askAgent(bridge.socketPath("alice"), agentMessage(11)),
        );
        end();
        expect([...answer.subarray(4)]).toEqual([12, 0, 0, 0, 0]);
        expect(aliceAsked).toEqual(["refresh api → origin"]);
        alice.detach();
      }),
    );
  });

  it("keeps socket paths short and distinct whatever the account id looks like", async () => {
    await withBridge(
      Effect.gen(function* () {
        const bridge = yield* AgentBridge;
        const long = bridge.socketPath("a".repeat(500));
        const escaping = bridge.socketPath("../../escape");
        expect(path.basename(long)).toMatch(/^[0-9a-f]{16}\.sock$/);
        expect(path.dirname(escaping)).toBe(path.dirname(long));
        expect(long).not.toBe(escaping);
      }),
    );
  });
});
