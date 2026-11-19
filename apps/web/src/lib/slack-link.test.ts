import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import { linkedLead, readSlackLink, slackPersonLabel } from "./slack-link.ts";

const account = { name: "Ada Lovelace", email: "ada@northwind.dev" };
const preview = {
  teamName: "Northwind",
  slackUserId: "U04R2K7N1",
  slackUserName: "ada",
  slackRealName: "Ada Lovelace",
  requestText: "@mend fix the flaky login test in checkout-api",
  expiresAt: new Date("2026-11-19T10:52:00Z"),
  replacesSlackUserId: null,
};
const refused = (code: string, httpStatus: number) =>
  new TRPCClientError("No such link.", {
    result: { error: { code: -32004, message: "No such link.", data: { code, httpStatus } } },
  });

const never = async () => {
  throw new Error("not asked");
};

describe("the Slack link page", () => {
  it("reads who is signed in, then the code", async () => {
    expect(
      await readSlackLink("abc", { account: async () => account, preview: async () => preview }),
    ).toEqual({ kind: "link", account, preview });
  });

  it("can't use a missing code, and asks a signed-out person to sign in first", async () => {
    expect(await readSlackLink(null, { account: never, preview: never })).toEqual({
      kind: "unusable",
    });
    expect(await readSlackLink("abc", { account: async () => null, preview: never })).toEqual({
      kind: "sign-in",
    });
    expect(await readSlackLink("abc", { account: never, preview: never })).toEqual({
      kind: "unreachable",
    });
  });

  it("names the Slack person as Slack does, falling back to their id", () => {
    expect(slackPersonLabel(preview)).toBe("Ada Lovelace (@ada)");
    expect(slackPersonLabel({ ...preview, slackRealName: null })).toBe("@ada");
    expect(slackPersonLabel({ ...preview, slackUserName: null })).toBe("U04R2K7N1");
  });

  it("says whether the waiting mention runs", () => {
    expect(linkedLead(true)).toMatch(/Mend runs your request/);
    expect(linkedLead(false)).toMatch(/didn't start your request/);
  });

  it("treats a refused code as one that can't be used", async () => {
    const state = await readSlackLink("abc", {
      account: async () => account,
      preview: async () => {
        throw refused("NOT_FOUND", 404);
      },
    });
    expect(state).toEqual({ kind: "unusable" });
  });
});
