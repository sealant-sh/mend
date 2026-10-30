import { parentPort } from "node:worker_threads";

import { encodePng } from "./png.ts";
import { Framebuffer, SCREEN_HEIGHT, SCREEN_WIDTH } from "./rfb-framebuffer.ts";
import { ByteQueue } from "./rfb-queue.ts";
import type { WorkerReply, WorkerRequest } from "./screen-workers.ts";

const queue = new ByteQueue();
let framebuffer: Framebuffer | undefined;

const answer = (request: WorkerRequest): WorkerReply => {
  switch (request._tag) {
    case "Decode":
      queue.push(request.bytes);
      return { _tag: "Decoded", read: (framebuffer ??= new Framebuffer()).read(queue) };
    case "Copy":
      return { _tag: "Pixels", pixels: (framebuffer ??= new Framebuffer()).pixels.slice() };
    case "Encode":
      return { _tag: "Png", png: encodePng(request.bytes, SCREEN_WIDTH, SCREEN_HEIGHT) };
  }
};

parentPort?.on("message", (request: WorkerRequest) => {
  const reply = answer(request);
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker's port, which has no origin.
  parentPort?.postMessage(reply, reply._tag === "Pixels" ? [reply.pixels.buffer] : []);
});
