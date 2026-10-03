import { describe, expect, it } from "vitest";

import { harnessName } from "./harness-name";

describe("harnessName", () => {
  it("names the harnesses that have a product name, and shows every other as it is", () => {
    expect(harnessName("claude")).toBe("Claude Code");
    expect(harnessName("codex")).toBe("Codex");
    expect(harnessName("opencode")).toBe("OpenCode");
    expect(harnessName("pi")).toBe("pi");
    expect(harnessName("shell")).toBe("shell");
  });
});
