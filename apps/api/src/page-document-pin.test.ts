import { describe, expect, it, vi } from "vitest";

vi.mock("@mend/t3-contracts/html-render", async (actual) => ({
  ...(await actual<typeof import("@mend/t3-contracts/html-render")>()),
  injectHtmlRenderBootstrap: (html: string) => `<head><script>changed()</script></head>${html}`,
}));

describe("a t3code pin whose bootstrap Mend can no longer read", () => {
  it("still loads, and refuses only to build a page document", async () => {
    const { pageDocument } = await import("./page-document.ts");
    expect(() => pageDocument("<p>x</p>", "light")).toThrow(
      "the vendored t3code bootstrap no longer has the shape Mend reads",
    );
  });
});
