import { SessionId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { sessionControlView, sharedControlView } from "./session-steering.ts";

const facts = (
  sharedControlEnabledAt: Date | null,
  sharedControlUserIds: ReadonlyArray<string> = [],
) => ({
  ownerUserId: "alice",
  sharedControlEnabledAt,
  sharedControlUserIds,
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

const asked = (view: ReturnType<typeof sharedControlView>) =>
  view.asked.map((person) => person.userId);

/** Who asks and who holds shared control, as each viewer reads it (docs/adr/0026). */
describe("sharedControlView", () => {
  const alice = { userId: "alice", role: "member" as const };
  const carol = { userId: "carol", role: "member" as const };
  const dave = { userId: "dave", role: "member" as const };
  const bob = { userId: "bob", role: "owner" as const };
  const at = new Date("2026-11-18T10:52:00Z");
  const session = {
    ...facts(null, ["erin"]),
    id: SessionId.make("sess-1"),
    settledAt: null,
    harness: "claude" as const,
  };
  const people = [
    {
      userId: "carol",
      state: "asked" as const,
      askedAt: at,
      grantedAt: null,
      grantedByUserId: null,
    },
    {
      userId: "dave",
      state: "asked" as const,
      askedAt: at,
      grantedAt: null,
      grantedByUserId: null,
    },
    {
      userId: "erin",
      state: "granted" as const,
      askedAt: at,
      grantedAt: at,
      grantedByUserId: "alice",
    },
  ];

  it("the owner reads every ask and decides; an asker reads only their own and withdraws", () => {
    const owner = sharedControlView(session, alice, people, true);
    expect(asked(owner)).toEqual(["carol", "dave"]);
    expect(owner.granted.map((person) => person.userId)).toEqual(["erin"]);
    expect(owner.acts).toEqual({ ask: false, withdraw: false, decide: true, takeBack: true });

    const asker = sharedControlView(session, carol, people, true);
    expect(asked(asker)).toEqual(["carol"]);
    expect(asker.granted.map((person) => person.userId)).toEqual(["erin"]);
    expect(asker.acts).toEqual({ ask: false, withdraw: true, decide: false, takeBack: false });
    expect(asked(sharedControlView(session, dave, people, true))).toEqual(["dave"]);
  });

  it("someone who has not asked may ask; a holder steers and may not; an organization owner takes back", () => {
    const frank = { userId: "frank", role: "member" as const };
    expect(sharedControlView(session, frank, people, true)).toMatchObject({
      steer: false,
      asked: [],
      acts: { ask: true, withdraw: false, decide: false, takeBack: false },
    });
    expect(
      sharedControlView(session, { userId: "erin", role: "member" }, people, true),
    ).toMatchObject({ steer: true, acts: { ask: false } });
    expect(sharedControlView(session, bob, people, true)).toMatchObject({
      asked: [],
      acts: { ask: true, decide: false, takeBack: true },
    });
    expect(sharedControlView({ ...session, settledAt: at }, frank, people, true).acts.ask).toBe(
      false,
    );
  });

  it("an organization owner may turn off a session shared with one person only", () => {
    expect(sessionControlView(facts(null, ["erin"]), bob).toggleSharedControl).toBe(true);
    expect(sessionControlView(facts(null), bob).toggleSharedControl).toBe(false);
  });
});
