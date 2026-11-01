import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResourceStatusLines } from "./resource-status-lines";
vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
const line = "@db · running · own database · observed 3 s ago";
describe("session resource lines", () => {
  it("shows the server's line without rebuilding its status or age", () => {
    const markup = renderToStaticMarkup(<ResourceStatusLines lines={[line]} />);
    expect(markup).toContain(line);
    expect(renderToStaticMarkup(<ResourceStatusLines lines={[]} />)).toBe("");
  });
});
