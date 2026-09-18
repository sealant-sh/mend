import { Effect } from "effect";
import type { Socket } from "effect/unstable/socket";
import { describe, expect, it } from "vitest";

import { makeFrameGuard } from "./socket-budgets.ts";

describe("the frame guard", () => {
  it("admits frames within the budget, closes once with 1009 on the first over it, then drops all", async () => {
    const closes: Array<Socket.CloseEvent> = [];
    const guard = makeFrameGuard(8, (event) =>
      Effect.sync(() => {
        closes.push(event);
      }),
    );
    expect(guard.refuse(new Uint8Array(8))).toBeNull();
    expect(guard.refuse("12345678")).toBeNull();
    // Multi-byte text is measured in bytes, as it arrives on the wire.
    const over = guard.refuse("ééééé");
    expect(over).not.toBeNull();
    if (over !== null) await Effect.runPromise(over);
    expect(closes.map((event) => event.code)).toEqual([1009]);

    const later = guard.refuse(new Uint8Array(1));
    expect(later).not.toBeNull();
    if (later !== null) await Effect.runPromise(later);
    expect(closes).toHaveLength(1);
  });

  it("is off at 0", () => {
    const guard = makeFrameGuard(0, () => Effect.void);
    expect(guard.refuse(new Uint8Array(10_000_000))).toBeNull();
  });
});
