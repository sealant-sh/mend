import { describe, expect, it } from "vitest";

import { isDirectMessage, PRIVATE_PROJECT_STATUS, privateProjectStatusMessage } from "./privacy.ts";

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
