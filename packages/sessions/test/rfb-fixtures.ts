import * as fs from "node:fs";
import * as zlib from "node:zlib";

import { ByteQueue } from "../src/screen/rfb-queue.ts";

const fixture = (name: string): Buffer =>
  fs.readFileSync(new URL(`fixtures/rfb/${name}`, import.meta.url));

/** The password capture.mjs gives Xvnc. */
export const PASSWORD = "mendcap1";
/** ProtocolVersion, the chosen security type, the VncAuth response and ClientInit. */
export const CLIENT_HANDSHAKE = 12 + 1 + 16 + 1;

/** noVNC 1.7.0 with its default options against TigerVNC 1.15, straight through. */
export const DEFAULTS_VIEWER = fixture("defaults.viewer.bin");
/** The same, with the viewer's messages sent on through the codec as the holder's. */
export const RELAYED_VIEWER = fixture("relayed.viewer.bin");
export const RELAYED_SERVER = fixture("relayed.server.bin");
/** noVNC's canvas, RGBA, once the relayed session went quiet. */
export const RELAYED_CANVAS = zlib.gunzipSync(fixture("relayed.canvas.rgba.gz"));

/** Every way to cut `bytes` in two, and one byte at a time. */
export const chunkings = (bytes: Uint8Array): ReadonlyArray<ReadonlyArray<Uint8Array>> => [
  ...Array.from({ length: bytes.length + 1 }, (_, at) => [
    bytes.subarray(0, at),
    bytes.subarray(at),
  ]),
  Array.from(bytes, (_, at) => bytes.subarray(at, at + 1)),
];

export const queueOf = (...chunks: ReadonlyArray<Uint8Array>): ByteQueue => {
  const queue = new ByteQueue();
  for (const chunk of chunks) queue.push(chunk);
  return queue;
};

/** Net array-buffer growth across `run`, not its peak. */
export const allocatedBy = <A>(run: () => A): { readonly result: A; readonly bytes: number } => {
  if (globalThis.gc === undefined) throw new Error("the sessions tests run with --expose-gc");
  globalThis.gc();
  const before = process.memoryUsage().arrayBuffers;
  const result = run();
  return { result, bytes: process.memoryUsage().arrayBuffers - before };
};
