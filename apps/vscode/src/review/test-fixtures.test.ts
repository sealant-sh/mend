import { describe, expect, it } from "vitest";

import { MendApiError } from "../mend-http.js";
import { FakeMend, PINNED } from "./test-fixtures.js";

const fileLevel = { side: null, startLine: null, endLine: null, hunkContextHash: null } as const;

describe("the fake Mend the review tests post to", () => {
  it("files a comment on a deleted file under its old path, as Mend does", async () => {
    const mend = new FakeMend();
    const posted = await mend.postComment(
      "change-1",
      PINNED.id,
      { oldPath: "README", newPath: null, ...fileLevel },
      "Keep the install steps",
    );
    expect(posted.file).toBe("README");
  });

  it("refuses a target Mend refuses, as Mend's 422 does", async () => {
    const mend = new FakeMend();
    await expect(
      mend.postComment(
        "change-1",
        PINNED.id,
        { oldPath: null, newPath: "README", ...fileLevel },
        "Keep the install steps",
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      mend.postComment(
        "change-1",
        PINNED.id,
        {
          oldPath: null,
          newPath: "src/auth/limit.ts",
          side: "new",
          startLine: 40,
          endLine: 40,
          hunkContextHash: "h1",
        },
        "Past the end of the hunk",
      ),
    ).rejects.toBeInstanceOf(MendApiError);
    expect(mend.serverComments).toEqual([]);
  });
});
