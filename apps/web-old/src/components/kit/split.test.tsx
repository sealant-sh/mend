// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseSplitLayout, SplitView } from "./split";

describe("SplitView", () => {
  it("renders on a server, where there is no browser storage", () => {
    expect(typeof globalThis.localStorage).toBe("undefined");
    const html = renderToString(
      <SplitView storageKey="test" label="Resize" start={<p>left</p>} end={<p>right</p>} />,
    );
    expect(html).toContain("left");
    expect(html).toContain("right");
  });
});

describe("parseSplitLayout", () => {
  it("takes a saved layout of two panes that adds up to the whole", () => {
    expect(parseSplitLayout('{"start":38,"end":62}', 20, 20)).toEqual({ start: 38, end: 62 });
  });

  it("ignores what it cannot trust instead of throwing", () => {
    for (const raw of [
      null,
      "not json",
      "null",
      "[38, 62]",
      '{"start":"38","end":62}',
      '{"start":10,"end":90}',
      '{"start":38,"end":40}',
      '{"start":1e999,"end":62}',
    ])
      expect(parseSplitLayout(raw, 20, 20)).toBeNull();
  });
});
