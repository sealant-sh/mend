import { describe, expect, it } from "vitest";

import { cn } from "../src/lib/utils.ts";

// globals.css adds names to Tailwind's scales. `cn` must know each one, or it reads the name as
// another utility and drops a class beside it that sets something else.
describe("cn with the kit's named scales", () => {
  it("keeps a colour beside a named type size", () => {
    expect(cn("text-meta text-primary-foreground")).toBe("text-meta text-primary-foreground");
    expect(cn("text-row text-muted-foreground")).toBe("text-row text-muted-foreground");
  });

  it("lets a named type size replace a stock one", () => {
    expect(cn("text-sm text-prose")).toBe("text-prose");
    expect(cn("text-2xs text-xs")).toBe("text-xs");
  });

  it("treats the named shadows as shadows, not shadow colours", () => {
    expect(cn("shadow-md shadow-pop")).toBe("shadow-pop");
    expect(cn("shadow-pop shadow-foreground/10")).toBe("shadow-pop shadow-foreground/10");
  });

  it("knows the named radii and spacing", () => {
    expect(cn("rounded-lg rounded-chip")).toBe("rounded-chip");
    expect(cn("w-64 w-sidebar")).toBe("w-sidebar");
    expect(cn("h-12 h-header")).toBe("h-header");
  });

  it("still lets a later colour replace an earlier one", () => {
    expect(cn("text-muted-foreground text-info")).toBe("text-info");
  });
});
