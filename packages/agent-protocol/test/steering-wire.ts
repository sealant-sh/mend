import * as fs from "node:fs";

import { type Cause, Effect, Queue, Stream } from "effect";

import { AgentProtocolError, type AgentTransport } from "../src/index.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export const ignore = (): void => undefined;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const encodeLine = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const decodeFrame = (bytes: Uint8Array): JsonObject => {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isObject(value)) throw new Error("expected an object frame");
  return value;
};

export interface TranscriptStep {
  readonly type: "emit_inbound" | "expect_outbound";
  readonly label: string;
  readonly frame: JsonObject;
}

export const readTranscript = (name: string): ReadonlyArray<TranscriptStep> =>
  fs
    .readFileSync(new URL(`./fixtures/steering/${name}`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .flatMap((line): ReadonlyArray<TranscriptStep> => {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) throw new Error("expected an object transcript line");
      const type = value["type"];
      const label = value["label"];
      const frame = value["frame"];
      if ((type !== "emit_inbound" && type !== "expect_outbound") || !isObject(frame)) return [];
      return [{ type, label: typeof label === "string" ? label : "", frame }];
    });

export const makeWire = Effect.fn("test.makeWire")(function* (
  onSend: (frame: JsonObject) => void = () => undefined,
) {
  const output = yield* Queue.unbounded<Uint8Array, AgentProtocolError | Cause.Done>();
  const acknowledged = yield* Queue.unbounded<true>();
  const sent: Array<JsonObject> = [];
  let boundaryChunks = 0;
  let acknowledgements = 0;
  const pushBytes = (bytes: Uint8Array): void => {
    if (bytes.at(-1) === 0x0a) boundaryChunks += 1;
    Queue.offerUnsafe(output, bytes);
  };
  const transport: AgentTransport = {
    send: (bytes) =>
      Effect.sync(() => {
        const frame = decodeFrame(bytes);
        sent.push(frame);
        onSend(frame);
      }),
    output: Stream.fromQueue(output),
    acknowledgeOutput: () => Queue.offer(acknowledged, true).pipe(Effect.asVoid),
    close: () => Effect.void,
  };
  const drain = Effect.gen(function* () {
    while (acknowledgements < boundaryChunks) {
      yield* Queue.take(acknowledged);
      acknowledgements += 1;
    }
  });
  return {
    transport,
    sent,
    pushBytes,
    push: (value: unknown) => pushBytes(encodeLine(value)),
    drain,
    end: Queue.end(output),
  };
});

const chunksOf =
  (size: number) =>
  (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
    const chunks: Array<Uint8Array> = [];
    for (let index = 0; index < bytes.length; index += size) {
      chunks.push(bytes.slice(index, index + size));
    }
    return chunks;
  };

export const CHUNKINGS = {
  whole: (bytes: Uint8Array): ReadonlyArray<Uint8Array> => [bytes],
  lines: (bytes: Uint8Array): ReadonlyArray<Uint8Array> => {
    const chunks: Array<Uint8Array> = [];
    let start = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0x0a) {
        chunks.push(bytes.slice(start, index + 1));
        start = index + 1;
      }
    }
    if (start < bytes.length) chunks.push(bytes.slice(start));
    return chunks;
  },
  oneByte: chunksOf(1),
  twoBytes: chunksOf(2),
  sevenBytes: chunksOf(7),
  thirtyOneBytes: chunksOf(31),
  nineHundredNinetySevenBytes: chunksOf(997),
};

export const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

export const makeRecordingPeer = (
  steps: ReadonlyArray<TranscriptStep>,
  options: {
    readonly skip: (step: TranscriptStep) => boolean;
    readonly match: (expected: TranscriptStep, actual: JsonObject) => ReadonlyArray<string>;
  },
) => {
  let cursor = 0;
  const ids = new Map<unknown, unknown>();
  const mismatches: Array<string> = [];
  let push: (frame: JsonObject) => void = ignore;
  const skipped = (): void => {
    for (let step = steps[cursor]; step !== undefined && options.skip(step); step = steps[cursor]) {
      cursor += 1;
    }
  };
  const pump = (): void => {
    for (skipped(); cursor < steps.length; skipped()) {
      const step = steps[cursor];
      if (step === undefined || step.type !== "emit_inbound") return;
      const frame = step.frame;
      const isResponse = "id" in frame && !("method" in frame);
      push(isResponse && ids.has(frame["id"]) ? { ...frame, id: ids.get(frame["id"]) } : frame);
      cursor += 1;
    }
  };
  return {
    connect: (emit: (frame: JsonObject) => void) => {
      push = emit;
      pump();
    },
    onSend: (actual: JsonObject): void => {
      skipped();
      const expected = steps[cursor];
      if (expected === undefined || expected.type !== "expect_outbound") {
        mismatches.push(`unexpected outbound frame ${JSON.stringify(actual)}`);
        return;
      }
      mismatches.push(...options.match(expected, actual).map((m) => `${expected.label}: ${m}`));
      if ("id" in expected.frame) ids.set(expected.frame["id"], actual["id"]);
      cursor += 1;
      pump();
    },
    mismatches,
    remaining: () => steps.slice(cursor),
  };
};
