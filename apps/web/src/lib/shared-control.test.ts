import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import {
  askersDetail,
  askersWords,
  controlMarkers,
  grantDialog,
  loginBand,
  loginRefusalOf,
  nameList,
  parseLoginHold,
  refusalReasonOf,
  type SharedControlView,
  sharedControlBands,
  stepRefusalWords,
  turnOffItems,
  turnOffSteps,
  withMarkers,
} from "./shared-control.ts";

const GRACE = "u-grace";
const ADA = "u-ada";
const LINUS = "u-linus";
const NAMES = new Map([
  [GRACE, "Grace Hopper"],
  [ADA, "Ada Lovelace"],
  [LINUS, "Linus Pauling"],
]);
const nameOf = (userId: string) => NAMES.get(userId) ?? null;
const asked = new Date("2026-11-19T10:52:00Z");

const view = (over: Partial<SharedControlView> = {}): SharedControlView => ({
  ownerUserId: GRACE,
  everyoneSince: null,
  granted: [],
  asked: [],
  steer: false,
  acts: { ask: false, withdraw: false, decide: false, takeBack: false },
  turnsOnSendersLogin: true,
  ...over,
});
const person = (userId: string, state: "asked" | "granted" = "asked") => ({
  userId,
  state,
  askedAt: asked,
  grantedAt: state === "granted" ? asked : null,
});
const context = (viewerId: string) => ({
  viewerId,
  nameOf,
  agent: "Claude Code",
  projectName: "checkout-api",
  ownerUserId: GRACE,
  timeOf: () => "10:52",
});

describe("sharedControlBands", () => {
  it("tells someone watching whose session it is and offers to ask", () => {
    const [band] = sharedControlBands(view({ acts: { ...view().acts, ask: true } }), context(ADA));
    expect(band?.title).toBe("This is Grace Hopper's session.");
    expect(band?.body).toBe(
      "You can read the conversation and review the change. Ask Grace for shared control to send messages too.",
    );
    expect(band?.buttons.map((button) => button.label)).toEqual(["Ask for shared control"]);
  });

  it("offers nothing to someone the server won't let ask", () => {
    const [band] = sharedControlBands(view(), context(ADA));
    expect(band?.buttons).toEqual([]);
    expect(band?.body).toBe("You can read the conversation and review the change.");
  });

  it("says an ask is pending, with Cancel request", () => {
    const [band] = sharedControlBands(
      view({ asked: [person(ADA)], acts: { ...view().acts, withdraw: true } }),
      context(ADA),
    );
    expect(band?.title).toBe("You asked Grace Hopper for shared control at 10:52.");
    expect(band?.buttons.map((button) => button.act)).toEqual([{ kind: "withdraw" }]);
  });

  it("tells a person who steers whose login their messages run on", () => {
    const [band] = sharedControlBands(
      view({ steer: true, granted: [person(ADA, "granted")] }),
      context(ADA),
    );
    expect(band?.body).toBe(
      "Grace turned on shared control, so you can send messages. They run on your own Claude Code login.",
    );
    const [shared] = sharedControlBands(
      view({ steer: true, granted: [person(ADA, "granted")], turnsOnSendersLogin: false }),
      context(ADA),
    );
    expect(shared?.body).toContain("They run on Grace's logins");
  });

  it("shows the owner each ask with Turn on and Dismiss", () => {
    const bands = sharedControlBands(
      view({ asked: [person(ADA), person(LINUS)], acts: { ...view().acts, decide: true } }),
      context(GRACE),
    );
    expect(bands.map((band) => band.title)).toEqual([
      "Ada Lovelace asked for shared control.",
      "Linus Pauling asked for shared control.",
    ]);
    expect(bands[0]?.buttons.map((button) => button.act)).toEqual([
      { kind: "grant", userId: ADA },
      { kind: "decline", userId: ADA },
    ]);
  });

  it("shows the owner who holds it, with Turn off", () => {
    const [band] = sharedControlBands(
      view({ granted: [person(ADA, "granted")], acts: { ...view().acts, takeBack: true } }),
      context(GRACE),
    );
    expect(band?.title).toBe("Shared control is on.");
    expect(band?.body).toBe(
      "Ada Lovelace can send messages, answer Claude Code's questions and approve commands. They run on Ada's own Claude Code login. Everyone else can still only read this session.",
    );
    expect(band?.buttons.map((button) => button.act.kind)).toEqual(["turn-off"]);
  });

  it("names the old switch for everyone", () => {
    const [band] = sharedControlBands(
      view({ everyoneSince: asked, acts: { ...view().acts, takeBack: true } }),
      context(GRACE),
    );
    expect(band?.body).toContain("Everyone who can see checkout-api can send messages");
  });

  it("shows an organization owner who doesn't own it that it is shared, with Turn off", () => {
    const [band] = sharedControlBands(
      view({ granted: [person(ADA, "granted")], acts: { ...view().acts, takeBack: true } }),
      context(LINUS),
    );
    expect(band?.title).toBe("Grace Hopper shares control of this session.");
    expect(band?.buttons).toHaveLength(1);
  });

  it("says nothing to the owner of a session nobody asks about", () => {
    expect(
      sharedControlBands(view({ acts: { ...view().acts, decide: true } }), context(GRACE)),
    ).toEqual([]);
  });
});

describe("grantDialog", () => {
  it("says who can send messages and what the asker can do", () => {
    const dialog = grantDialog(view({ asked: [person(ADA)] }), {
      askerId: ADA,
      nameOf,
      agent: "Claude Code",
      projectName: "checkout-api",
      sessionTitle: "Retry webhooks with a dead-letter queue",
    });
    expect(dialog.title).toBe("Turn on shared control for Ada Lovelace?");
    expect(dialog.description).toBe(
      "Ada asked to send messages in Retry webhooks with a dead-letter queue.",
    );
    expect(dialog.rows[0]?.body).toBe(
      "Ada Lovelace and you. Everyone else who can open checkout-api can only read this session.",
    );
    expect(dialog.rows[1]?.body).toContain("runs it on Ada's own Claude Code login");
  });
});

describe("turning it off", () => {
  it("turns the switch for everyone off when it is on, else takes each grant back", () => {
    expect(turnOffSteps(view({ everyoneSince: asked, granted: [person(ADA, "granted")] }))).toEqual(
      [{ kind: "everyone-off" }],
    );
    expect(turnOffSteps(view({ granted: [person(ADA, "granted")] }))).toEqual([
      { kind: "take-back", userId: ADA },
    ]);
  });

  it("offers one menu item per person when several hold it", () => {
    const takeBack = { ...view().acts, takeBack: true };
    expect(
      turnOffItems(view({ granted: [person(ADA, "granted")], acts: takeBack }), nameOf).map(
        (item) => item.label,
      ),
    ).toEqual(["Turn off shared control"]);
    expect(
      turnOffItems(
        view({ granted: [person(ADA, "granted"), person(LINUS, "granted")], acts: takeBack }),
        nameOf,
      ).map((item) => item.label),
    ).toEqual([
      "Turn off shared control for Ada Lovelace",
      "Turn off shared control for Linus Pauling",
    ]);
    expect(turnOffItems(view({ granted: [person(ADA, "granted")] }), nameOf)).toEqual([]);
  });
});

const refusal = (data: unknown) =>
  TRPCClientError.from({ error: { message: "Refused.", code: -32600, data } });

describe("refusals", () => {
  it("reads why a step was refused, and words it", () => {
    const cause = refusal({ tag: "SharedControlRefused", sharedControl: { reason: "not-asked" } });
    expect(refusalReasonOf(cause)).toBe("not-asked");
    expect(stepRefusalWords(cause, nameOf, ADA)).toBe(
      "Ada's request is no longer open: it was cancelled or already answered.",
    );
  });

  it("reads the sender's login a message was refused for", () => {
    const cause = refusal({
      tag: "SessionNotSteerable",
      sharedControl: { reason: null, login: { provider: "claude", state: "invalid" } },
    });
    expect(loginRefusalOf(cause)).toEqual({ provider: "claude", state: "invalid" });
    expect(loginRefusalOf(refusal({ tag: "SessionNotSteerable" }))).toBeNull();
    expect(loginRefusalOf(new Error("offline"))).toBeNull();
  });

  it("falls back to the server's words", () => {
    expect(stepRefusalWords(refusal({ tag: "NotFound" }), nameOf, null)).toBe("Refused.");
  });
});

describe("controlMarkers", () => {
  const events = [
    { id: "1", actorUserId: ADA, kind: "shared-control-ask", refId: ADA, createdAt: asked },
    {
      id: "2",
      actorUserId: GRACE,
      kind: "shared-control-grant",
      refId: ADA,
      createdAt: new Date("2026-11-19T10:53:00Z"),
    },
    {
      id: "3",
      actorUserId: GRACE,
      kind: "shared-control-take-back",
      refId: ADA,
      createdAt: new Date("2026-11-19T11:00:00Z"),
    },
    { id: "4", actorUserId: GRACE, kind: "stop", refId: null, createdAt: asked },
  ];

  it("words each event for the asker", () => {
    expect(
      controlMarkers(events, { viewerId: ADA, nameOf, ownerUserId: GRACE }).map((m) => m.label),
    ).toEqual([
      "You asked Grace Hopper for shared control",
      "Grace Hopper turned on shared control for you",
      "Grace Hopper turned off shared control for you",
    ]);
  });

  it("words each event for the owner", () => {
    expect(
      controlMarkers(events, { viewerId: GRACE, nameOf, ownerUserId: GRACE }).map((m) => m.label),
    ).toEqual([
      "Ada Lovelace asked for shared control",
      "You turned on shared control for Ada Lovelace",
      "You turned off shared control for Ada Lovelace",
    ]);
  });
});

describe("withMarkers", () => {
  const entries = [{ at: "2026-11-19T10:00:00.000Z" }, { at: "2026-11-19T11:00:00.000Z" }];
  const at = (entry: { readonly at: string }) => entry.at;

  it("lays each marker before the first entry after it", () => {
    const placed = withMarkers(
      entries,
      at,
      [{ at: "2026-11-19T10:30:00.000Z" }, { at: "2026-11-19T12:00:00.000Z" }],
      true,
    );
    expect(placed.map((item) => item.kind)).toEqual(["entry", "marker", "entry", "marker"]);
  });

  it("leaves out a marker older than a window that doesn't reach the start", () => {
    expect(withMarkers(entries, at, [{ at: "2026-11-19T09:00:00.000Z" }], false)).toHaveLength(2);
    expect(withMarkers(entries, at, [{ at: "2026-11-19T09:00:00.000Z" }], true)).toHaveLength(3);
  });
});

describe("the sender's login", () => {
  it("says what to do for each state", () => {
    const expired = loginBand(
      { provider: "claude", state: "invalid" },
      { agentName: "Claude Code", ownerName: "Grace Hopper", own: false },
    );
    expect(expired.title).toBe("Your Claude Code login has expired, so your message wasn't sent.");
    expect(expired.body).toBe(
      "Messages you send in Grace's session run on your own login. Connect Claude Code again and Mend sends the message. It's still in the box below.",
    );
    expect(expired.connect).toBe(true);
    expect(
      loginBand(
        { provider: "claude", state: "unchosen" },
        { agentName: "Claude Code", ownerName: null, own: true },
      ).connect,
    ).toBe(false);
  });

  it("reads back only a hold it wrote", () => {
    expect(parseLoginHold('{"provider":"codex","state":"missing","at":5}')).toEqual({
      provider: "codex",
      state: "missing",
      at: 5,
    });
    expect(parseLoginHold("")).toBeNull();
    expect(parseLoginHold('{"provider":"codex","state":"gone","at":5}')).toBeNull();
    expect(parseLoginHold("{")).toBeNull();
  });
});

describe("the inbox's words", () => {
  it("names who asks", () => {
    expect(askersWords(["Ada Lovelace"])).toBe("Ada asked for shared control");
    expect(askersWords(["Ada Lovelace", null])).toBe("2 people asked for shared control");
    expect(askersWords([null])).toBe("Someone asked for shared control");
    expect(askersDetail(["Ada Lovelace", "Linus Pauling"])).toBe(
      "Ada Lovelace and Linus Pauling asked for shared control",
    );
  });

  it("lists names", () => {
    expect(nameList(["Ada", "Linus", "you"])).toBe("Ada, Linus and you");
  });
});
