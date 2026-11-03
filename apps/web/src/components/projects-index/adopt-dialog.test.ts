import { describe, expect, it } from "vitest";

import { cloneUrlOf, inferName } from "./adopt-dialog";

const repo = (visibility: string) => ({
  nameWithOwner: "sealant-sh/sealantd",
  visibility,
  pushedAt: null,
  url: "https://github.com/sealant-sh/sealantd",
});

describe("Adopt a repository", () => {
  it("clones a public repository over https and a private one over ssh, which a key can read", () => {
    expect(cloneUrlOf(repo("PUBLIC"))).toBe("https://github.com/sealant-sh/sealantd");
    expect(cloneUrlOf(repo("PRIVATE"))).toBe("git@github.com:sealant-sh/sealantd.git");
  });

  it("names the project after the repository whatever form its URL takes", () => {
    expect(inferName("git@github.com:sealant-sh/mend.git")).toBe("mend");
    expect(inferName("https://github.com/sealant-sh/mend/")).toBe("mend");
    expect(inferName("git@host:mend")).toBe("mend");
  });
});
