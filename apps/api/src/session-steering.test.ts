import { describe, expect, it } from "vitest";

import { sessionControlView } from "./session-steering.ts";

const facts = (sharedControlEnabledAt: Date | null) => ({
  ownerUserId: "alice",
  sharedControlEnabledAt,
});

/** The control view a session's detail carries (docs/adr/0003, docs/adr/0013). */
describe("sessionControlView", () => {
  const alice = { userId: "alice", role: "member" as const };
  const carol = { userId: "carol", role: "member" as const };
  const bob = { userId: "bob", role: "owner" as const };

  it("only the owner types in the terminal, even while control is shared", () => {
    const shared = facts(new Date());
    expect(sessionControlView(shared, alice)).toMatchObject({ steer: true, terminalInput: true });
    expect(sessionControlView(shared, carol)).toMatchObject({ steer: true, terminalInput: false });
    expect(sessionControlView(facts(null), carol)).toMatchObject({
      steer: false,
      terminalInput: false,
    });
  });

  it("an organization owner may stop a session they do not steer, and still not type in it", () => {
    expect(sessionControlView(facts(null), bob)).toMatchObject({
      steer: false,
      stop: true,
      terminalInput: false,
    });
    expect(sessionControlView(facts(new Date()), null)).toMatchObject({
      own: false,
      steer: false,
      stop: false,
      terminalInput: false,
    });
  });
});
