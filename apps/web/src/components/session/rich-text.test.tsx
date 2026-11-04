// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { RichText } from "./rich-text.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
afterEach(() => act(() => root?.unmount()));

describe("reading agent Markdown", () => {
  it("shows headings, emphasis, lists, a table, links and an unfinished code fence", async () => {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(() =>
      root?.render(
        <RichText
          text={
            "## Findings\n\n**Observed** and *measured*, ~~old~~.\n\n- [x] Read `file.ts`\n- [ ] Run checks\n\n1. First\n2. Second\n\n> Evidence\n\n---\n\n| Check | Result |\n| --- | --- |\n| Unit | Passed |\n\nhttps://mend.run\n\n```ts\nconst answer = 42;"
          }
        />,
      ),
    );
    expect(host.querySelector("h2")?.textContent).toBe("Findings");
    expect(host.querySelector("strong")?.textContent).toBe("Observed");
    expect(host.querySelector("em")?.textContent).toBe("measured");
    expect(host.querySelector("del")?.textContent).toBe("old");
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(host.querySelector("ol")?.textContent).toContain("First");
    expect(host.querySelector("blockquote")?.textContent).toContain("Evidence");
    expect(host.querySelector("hr")).not.toBeNull();
    expect(host.querySelector("th")?.textContent).toBe("Check");
    expect(host.querySelector("td")?.textContent).toBe("Unit");
    expect(host.querySelector("pre code")?.textContent).toBe("const answer = 42;\n");
    expect(host.textContent).toContain("tsCopy");
    expect(host.querySelector("a")?.target).toBe("_blank");
    expect(host.querySelector("a")?.rel).toBe("noreferrer noopener");

    await act(() => root?.render(<RichText text={"| Check | Res\n\n```ts\nconst ans"} />));
    expect(host.textContent).toContain("const ans");
    await act(() =>
      root?.render(<RichText text={"| Check | Result |\n| --- | --- |\n| Unit | Pass"} />),
    );
    expect(host.querySelector("td")?.textContent).toBe("Unit");
  });

  it("does not render raw HTML or unsafe link destinations", async () => {
    const host = document.createElement("div");
    root = createRoot(host);
    await act(() =>
      root?.render(
        <RichText
          text={
            '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[unsafe](javascript:alert%281%29)\n\n[docs](https://docs.mend.run)'
          }
        />,
      ),
    );
    expect(host.querySelector("script, img")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toBe("");
    expect(host.querySelectorAll("a")[1]?.href).toBe("https://docs.mend.run/");
  });
});
