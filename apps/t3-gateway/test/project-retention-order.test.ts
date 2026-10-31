import { describe, expect, it } from "vitest";

import { makeProjectReadOrder } from "../src/project-read-order.ts";

describe("project restoration ordering", () => {
  it("lets a restored project reappear and refuses pre-removal reads", () => {
    const order = makeProjectReadOrder();
    const stale = order.begin();
    order.removed("project");
    expect(order.apply("project", stale)).toBe(false);
    const restored = order.begin();
    expect(order.apply("project", restored)).toBe(true);
    expect(order.apply("project", stale)).toBe(false);
  });
  it("a delayed unavailable response cannot hide a newer restored project", () => {
    const order = makeProjectReadOrder();
    order.removed("project");
    const old404 = order.begin();
    const restore = order.begin();
    expect(order.apply("project", restore)).toBe(true);
    expect(order.apply("project", old404)).toBe(false);
    expect(order.newerThan("project", old404)).toBe(true);
  });
  it("a newer snapshot without the project refuses an older read of it, though it was never cached", () => {
    const order = makeProjectReadOrder();
    order.removed("project");
    const delayed = order.begin();
    const resync = order.begin();
    order.snapshot(resync);
    expect(order.apply("project", delayed)).toBe(false);
    expect(order.apply("project", order.begin())).toBe(true);
  });
});
