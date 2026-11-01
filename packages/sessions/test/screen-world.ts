import * as net from "node:net";
import { Readable } from "node:stream";
import { WritableStream } from "node:stream/web";

import { ScreensRepo } from "@mend/db";
import type { SessionId, SessionProcessId } from "@mend/domain";
import {
  type ForwardDestination,
  openBoundedForward,
  SealantClient,
  SealantPrincipal,
  type SealantPrincipalValue,
  toPlatformError,
} from "@mend/sealant";
import type { BoundedWorkspaceForward } from "@sealant/sdk";
import { Effect, Layer, Redacted } from "effect";

import { type ScreenPasswords, makeScreenPasswords } from "../src/screen/passwords.ts";
import { ScreenHost } from "../src/screen/screen-host.ts";
import { fakeWorkspace } from "./fake-workspace.ts";
import { XVNC_PASSWORD } from "./xvnc.ts";

export const OWNER = "alice";

/**
 * Polls `done` until it holds, failing with `what` once `ms` of real time has passed: a hand's end
 * and the row it resets go through a lock and the store, which a loaded runner makes slow, not wrong.
 */
export const eventually = <R>(
  done: () => Effect.Effect<boolean, never, R>,
  what: string,
  ms = 30_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!(yield* done())) {
      if (Date.now() > deadline) throw new Error(what);
      yield* Effect.sleep("20 millis");
    }
  });

export interface Dial {
  readonly port: number;
  readonly destination: ForwardDestination;
  readonly as: SealantPrincipalValue;
}

/** What a screen test drove: dials, starts, the connections to Xvnc, and where Xvnc listens. */
export interface ScreenWorld {
  readonly dials: Array<Dial>;
  readonly starts: Array<SessionId>;
  readonly rekeys: Array<SessionId>;
  /** Sessions whose screen's rekey fails, as when its person's helper never answers. */
  readonly rekeyFails: Set<SessionId>;
  readonly screenProcess: Map<SessionId, SessionProcessId>;
  readonly sockets: Array<net.Socket>;
  /** False for a session whose screen this process holds no passwords for. */
  readonly signable: (sessionId: SessionId) => boolean;
  xvncPort: number;
  /** Called at each dial, once it is recorded. */
  onDial: (() => void) | null;
  /**
   * Where each start's and rekey's fresh passwords go, as the screen's own script writes them;
   * null keeps the test Xvnc's fixed password for every screen.
   */
  signWith: ((passwords: ScreenPasswords) => void) | null;
}

export const makeScreenWorld = (
  signable: (sessionId: SessionId) => boolean = () => true,
): ScreenWorld => ({
  dials: [],
  starts: [],
  rekeys: [],
  rekeyFails: new Set(),
  screenProcess: new Map(),
  sockets: [],
  signable,
  xvncPort: 0,
  onDial: null,
  signWith: null,
});

/** One TCP connection to Xvnc, with the SDK's forward shape, bound as it was asked to be. */
const tcpForward = (world: ScreenWorld, destination: ForwardDestination) =>
  new Promise<BoundedWorkspaceForward>((resolve, reject) => {
    const socket = net.connect(world.xvncPort, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      world.sockets.push(socket);
      socket.off("error", reject);
      socket.on("error", () => undefined);
      resolve({
        readable: Readable.toWeb(socket),
        writable: new WritableStream<Uint8Array>({
          write: (chunk) =>
            new Promise<void>((done, failed) => {
              socket.write(chunk, (error) => {
                if (error) failed(error);
                else done();
              });
            }),
          close: () => void socket.end(),
          abort: () => void socket.destroy(),
        }),
        binding: destination.binding,
        closed: new Promise((done) => socket.once("close", () => done({ kind: "end" }))),
        close: () => socket.destroy(),
      });
    });
  });

/** The fake SDK: every forward is a TCP connection to the test's Xvnc. */
export const screenSealantLayer = (world: ScreenWorld) =>
  Layer.mock(SealantClient)({
    getWorkspace: () => Effect.succeed(fakeWorkspace("ws-1")),
    openForward: (_workspace, port, destination, options) =>
      Effect.gen(function* () {
        const as = yield* SealantPrincipal;
        return yield* openBoundedForward(
          () => {
            world.dials.push({ port, destination, as });
            world.onDial?.();
            return tcpForward(world, destination);
          },
          options.signal,
          toPlatformError,
        );
      }),
  });

/**
 * The session side: one owner, and a start that goes Live at once. Passwords are the test Xvnc's
 * fixed one, or with `signWith` fresh at each start and rekey and held by this process alone, so
 * a later process holds none of what an earlier one issued.
 */
export const screenHostLayer = (world: ScreenWorld) =>
  Layer.effect(
    ScreenHost,
    Effect.gen(function* () {
      const screens = yield* ScreensRepo;
      const issued = makeScreenPasswords();
      const issue = (sessionId: SessionId) => world.signWith?.(issued.issue(sessionId, OWNER));
      return {
        regionEncoder: () => Effect.die("no region encoder in screen fixture"),
        ownerOf: () => Effect.succeed(OWNER),
        start: (sessionId) =>
          Effect.gen(function* () {
            world.starts.push(sessionId);
            const screen = yield* screens.ofSession(sessionId);
            const processId = world.screenProcess.get(sessionId);
            if (screen === null || processId === undefined) return yield* Effect.die("no screen");
            issue(sessionId);
            return yield* screens.setLife(screen.id, {
              life: { _tag: "Live", degraded: null, browserSandboxOff: false },
              processId,
            });
          }).pipe(Effect.orDie),
        passwords: (sessionId) =>
          Effect.sync(() => {
            if (world.signWith !== null) return issued.of(sessionId);
            return world.signable(sessionId)
              ? { full: Redacted.make(XVNC_PASSWORD), viewOnly: Redacted.make(XVNC_PASSWORD) }
              : null;
          }),
        rekey: (sessionId) =>
          Effect.sync(() => {
            world.rekeys.push(sessionId);
            if (world.rekeyFails.has(sessionId)) return false;
            if (world.signWith === null) return world.signable(sessionId);
            issue(sessionId);
            return true;
          }),
        ptyOf: (processId) => Effect.succeed(`pty-${processId}`),
        turnOf: () => Effect.succeed(null),
      };
    }),
  );
