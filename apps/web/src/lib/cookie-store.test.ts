import { describe, expect, it } from "vitest";

import { cookieValue } from "./cookie-store.ts";

describe("reading one cookie", () => {
  it("finds the cookie by its whole name, not one that ends or starts like it", () => {
    const cookies = "xmend-inbox-folds=1; mend-inbox-folds=%7B%7D; mend-inbox-folds-old=2";
    expect(cookieValue(cookies, "mend-inbox-folds")).toBe("%7B%7D");
    expect(cookieValue(cookies, "mend-inbox-filters")).toBeUndefined();
    expect(cookieValue("", "mend-inbox-folds")).toBeUndefined();
  });
});
