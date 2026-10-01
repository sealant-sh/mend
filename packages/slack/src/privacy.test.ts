import { describe, expect, it } from "vitest";

import {
  isDirectMessage,
  PRIVATE_PROJECT_STATUS,
  privateProjectStatusMessage,
  slackThreadReach,
  threadShowsReplies,
} from "./privacy.ts";

describe("what a channel may be shown", () => {
  it("tells a direct message with the bot from a channel, a private channel or a group DM", () => {
    expect(isDirectMessage("D0123")).toBe(true);
    for (const channel of ["C0123", "G0123"]) expect(isDirectMessage(channel)).toBe(false);
  });

  it("words a private project's status without a name, a branch or a link", () => {
    const message = privateProjectStatusMessage();
    expect(message.text).toBe("not shown · the project is private");
    expect(message.text).toBe(PRIVATE_PROJECT_STATUS);
    expect(JSON.stringify(message.blocks)).not.toContain("button");
  });
});

describe("how far a thread reaches the person who asked", () => {
  it("replies in a direct message or for a shared project; status only otherwise", () => {
    expect(threadShowsReplies("D0123", "private")).toBe(true);
    expect(threadShowsReplies("C0123", "shared")).toBe(true);
    expect(threadShowsReplies("C0123", "private")).toBe(false);
    const at = { projectOrganizationId: "org-acme", channelId: "C0123" };
    expect(
      slackThreadReach({ ...at, installOrganizationId: "org-acme", visibility: "shared" }),
    ).toBe("replies");
    expect(
      slackThreadReach({ ...at, installOrganizationId: "org-acme", visibility: "private" }),
    ).toBe("status");
  });

  it("reaches nobody without the project's organization's install", () => {
    const at = { projectOrganizationId: "org-acme", channelId: "D0123", visibility: "shared" };
    expect(slackThreadReach({ ...at, installOrganizationId: null })).toBe("none");
    expect(slackThreadReach({ ...at, installOrganizationId: "org-globex" })).toBe("none");
  });
});
