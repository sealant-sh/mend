import { describe, expect, it } from "vitest";

import type { ProcessLogPageDto } from "#/lib/api";
import { base64Bytes, recordPages } from "#/lib/record";

const page = (
  from: string,
  sequences: ReadonlyArray<number>,
  nextFrom: string,
): ProcessLogPageDto => ({
  processId: "p1",
  sealantSessionId: "sess_1",
  sealantRunId: "run_1",
  requestedFrom: from,
  firstSequence: sequences.length === 0 ? null : String(sequences[0]),
  lastSequence: sequences.length === 0 ? null : String(sequences.at(-1)),
  nextFrom,
  status: "exited",
  chunks: sequences.map((sequence) => ({ sequence: String(sequence), dataBase64: "aGk=" })),
  telemetryLoss: "unknown",
  telemetryNote: "",
});

const drain = async (
  pages: AsyncGenerator<ProcessLogPageDto, { readonly truncated: boolean }>,
): Promise<{ readonly froms: ReadonlyArray<string>; readonly truncated: boolean }> => {
  const froms: Array<string> = [];
  for (;;) {
    const step = await pages.next();
    if (step.done === true) return { froms, truncated: step.value.truncated };
    froms.push(step.value.requestedFrom);
  }
};

describe("recordPages", () => {
  it("walks the cursor until an empty page", async () => {
    const book: Record<string, ProcessLogPageDto> = {
      "0": page("0", [56, 57], "58"),
      "58": page("58", [60], "61"),
      "61": page("61", [], "61"),
    };
    const asked: Array<string> = [];
    const result = await drain(
      recordPages((from) => {
        asked.push(from);
        return Promise.resolve(book[from] ?? page(from, [], from));
      }, "0"),
    );
    expect(asked).toEqual(["0", "58", "61"]);
    expect(result).toEqual({ froms: ["0", "58", "61"], truncated: false });
  });

  it("starts from the seek point and stops on a cursor that does not move", async () => {
    const result = await drain(recordPages((from) => Promise.resolve(page(from, [9], from)), "9"));
    expect(result).toEqual({ froms: ["9"], truncated: false });
  });

  it("says when the page cap ended the walk", async () => {
    let next = 0;
    const result = await drain(
      recordPages(
        (from) => {
          next += 1;
          return Promise.resolve(page(from, [next], String(next)));
        },
        "0",
        3,
      ),
    );
    expect(result.truncated).toBe(true);
    expect(result.froms).toHaveLength(3);
  });
});

describe("base64Bytes", () => {
  it("keeps every byte, including ones outside ASCII", () => {
    expect([...base64Bytes("G1s/MjAwNGg=")]).toEqual([
      ...new TextEncoder().encode("\u001b[?2004h"),
    ]);
    expect([...base64Bytes("4pSA")]).toEqual([0xe2, 0x94, 0x80]);
  });
});
