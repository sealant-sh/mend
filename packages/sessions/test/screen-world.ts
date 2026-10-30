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

import { ScreenHost } from "../src/screen/screen-host.ts";
import { fakeWorkspace } from "./fake-workspace.ts";
import { XVNC_PASSWORD } from "./xvnc.ts";

export const OWNER = "alice";

export interface Dial {
  readonly port: number;
  readonly destination: ForwardDestination;
  readonly as: SealantPrincipalValue;
}

/** What a screen test drove: dials, starts, the connections to Xvnc, and where Xvnc listens. */
export interface ScreenWorld {
  readonly dials: Array<Dial>;
  readonly starts: Array<SessionId>;
  readonly screenProcess: Map<SessionId, SessionProcessId>;
  readonly sockets: Array<net.Socket>;
  /** False for a session whose screen this process holds no passwords for. */
  readonly signable: (sessionId: SessionId) => boolean;
  xvncPort: number;
}

export const makeScreenWorld = (
  signable: (sessionId: SessionId) => boolean = () => true,
): ScreenWorld => ({
  dials: [],
  starts: [],
  screenProcess: new Map(),
  sockets: [],
  signable,
  xvncPort: 0,
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
            return tcpForward(world, destination);
          },
          options.signal,
          toPlatformError,
        );
      }),
  });

/** The session side: one owner, the test's Xvnc password, and a start that goes Live at once. */
export const screenHostLayer = (world: ScreenWorld) =>
  Layer.effect(
    ScreenHost,
    Effect.gen(function* () {
      const screens = yield* ScreensRepo;
      return {
        ownerOf: () => Effect.succeed(OWNER),
        start: (sessionId) =>
          Effect.gen(function* () {
            world.starts.push(sessionId);
            const screen = yield* screens.ofSession(sessionId);
            const processId = world.screenProcess.get(sessionId);
            if (screen === null || processId === undefined) return yield* Effect.die("no screen");
            return yield* screens.setLife(screen.id, {
              life: { _tag: "Live", degraded: null, browserSandboxOff: false },
              processId,
            });
          }).pipe(Effect.orDie),
        passwords: (sessionId) =>
          Effect.succeed(
            world.signable(sessionId)
              ? { full: Redacted.make(XVNC_PASSWORD), viewOnly: Redacted.make(XVNC_PASSWORD) }
              : null,
          ),
        ptyOf: (processId) => Effect.succeed(`pty-${processId}`),
        turnOf: () => Effect.succeed(null),
      };
    }),
  );
