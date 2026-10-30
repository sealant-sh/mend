import { describe, expect, it } from "vitest";

import { allocatedBy, queueOf } from "../../test/rfb-fixtures.ts";

const LARGE = 16 * 1024 * 1024;

describe("ByteQueue", () => {
  it("peeks and takes across chunk boundaries in order", () => {
    const queue = queueOf(Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5), Uint8Array.of(6, 7, 8, 9));
    expect([...queue.peek(4)]).toEqual([1, 2, 3, 4]);
    expect(queue.length).toBe(9);
    expect([...queue.take(4)]).toEqual([1, 2, 3, 4]);
    expect(queue.length).toBe(5);
    expect([...queue.peek(1)]).toEqual([5]);
    expect([...queue.take(3)]).toEqual([5, 6, 7]);
    expect([...queue.peek(2)]).toEqual([8, 9]);
    expect([...queue.take(2)]).toEqual([8, 9]);
    expect(queue.length).toBe(0);
  });

  it("copies only the requested prefix when a peek spans a large chunk", () => {
    const large = new Uint8Array(LARGE);
    large[0] = 4;
    const queue = queueOf(Uint8Array.of(1, 2, 3), large);
    const { result, bytes } = allocatedBy(() => queue.peek(4));
    expect([...result]).toEqual([1, 2, 3, 4]);
    expect(bytes).toBeLessThan(1024);
    expect(queue.length).toBe(3 + LARGE);
  });

  it("copies only the requested prefix when a take spans a large chunk", () => {
    const large = new Uint8Array(LARGE);
    large[0] = 4;
    const queue = queueOf(Uint8Array.of(1, 2, 3), large);
    const { result, bytes } = allocatedBy(() => queue.take(4));
    expect([...result]).toEqual([1, 2, 3, 4]);
    expect(bytes).toBeLessThan(1024);
    expect(queue.length).toBe(LARGE - 1);
  });
});
