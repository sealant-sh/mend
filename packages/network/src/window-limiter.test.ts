import { describe, expect, it } from "vitest";

import { makeWindowLimiter } from "./window-limiter.ts";

describe("the sliding window limiter", () => {
  it("admits up to the limit, then answers the seconds until the oldest unit leaves", () => {
    const limiter = makeWindowLimiter(60_000);
    expect(limiter.take("a", 2, 0)).toBeNull();
    expect(limiter.take("a", 2, 10_000)).toBeNull();
    expect(limiter.take("a", 2, 20_000)).toBe(40);
    expect(limiter.take("a", 2, 59_999)).toBe(1);
    expect(limiter.take("a", 2, 60_000)).toBeNull();
  });

  it("spends nothing on a refusal, so knocking does not push the subject further out", () => {
    const limiter = makeWindowLimiter(60_000);
    limiter.take("a", 1, 0);
    for (let at = 1_000; at < 60_000; at += 1_000) expect(limiter.take("a", 1, at)).not.toBeNull();
    expect(limiter.take("a", 1, 60_000)).toBeNull();
  });

  it("keeps subjects apart and admits everything at 0", () => {
    const limiter = makeWindowLimiter();
    expect(limiter.take("a", 1, 0)).toBeNull();
    expect(limiter.take("b", 1, 0)).toBeNull();
    expect(limiter.take("a", 1, 1)).not.toBeNull();
    for (let i = 0; i < 100; i += 1) expect(limiter.take("c", 0, i)).toBeNull();
  });

  it("forgets idle subjects once it holds many, so rotating names cannot grow it without bound", () => {
    const limiter = makeWindowLimiter(1_000);
    for (let i = 0; i <= 5_000; i += 1) limiter.take(`s${i}`, 5, 0);
    limiter.take("late", 5, 10_000);
    expect(limiter.subjects()).toBeLessThan(10);
  });

  it("never holds more than its cap: past it, new subjects share one window", () => {
    const limiter = makeWindowLimiter(60_000, 100);
    for (let i = 0; i < 100; i += 1) expect(limiter.take(`s${i}`, 2, 0)).toBeNull();
    expect(limiter.take("new-1", 2, 1)).toBeNull();
    expect(limiter.take("new-2", 2, 2)).toBeNull();
    expect(limiter.take("new-3", 2, 3)).not.toBeNull();
    expect(limiter.subjects()).toBeLessThanOrEqual(101);
    // A subject counted before the cap keeps its own window.
    expect(limiter.take("s1", 2, 4)).toBeNull();
    // Once the window passes, the idle subjects go and new ones are counted apart again.
    expect(limiter.take("later", 2, 70_000)).toBeNull();
    expect(limiter.subjects()).toBeLessThan(5);
  });
});
