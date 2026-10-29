import { describe, expect, it } from "vitest";

import { ViewerConnectionId } from "../ids.ts";
import {
  type ScreenInputEvent,
  type ScreenInputLog,
  type ScreenInputTransition,
  SCREEN_INPUT_INITIAL,
  SCREEN_LIMITS,
  type ScreenInput,
  transitionInput,
} from "./screen.ts";

const OWNER = "yiannis";
const OTHER = "anna";
const D = ViewerConnectionId.make("connection-d");
const C = ViewerConnectionId.make("connection-c");
const since = new Date("2026-10-30T10:00:00Z");
const later = new Date("2026-10-30T10:00:30Z");
const at = (ms: number) => new Date(since.getTime() + ms);

const states = {
  agent: { _tag: "Agent", epoch: 4 },
  fencingToD: { _tag: "Fencing", epoch: 4, by: OWNER, to: { _tag: "Person", connection: D } },
  fencingToC: { _tag: "Fencing", epoch: 4, by: OWNER, to: { _tag: "Person", connection: C } },
  fencingBack: { _tag: "Fencing", epoch: 4, by: OWNER, to: { _tag: "AwaitingAgent" } },
  personD: { _tag: "Person", epoch: 4, userId: OWNER, connection: D },
  personC: { _tag: "Person", epoch: 4, userId: OWNER, connection: C },
  paused: { _tag: "Paused", epoch: 4, reason: "disconnected", since },
  awaiting: { _tag: "AwaitingAgent", epoch: 4 },
} satisfies Record<string, ScreenInput>;
type State = keyof typeof states;

const events = {
  ownerTakesOnD: { _tag: "Take", by: OWNER, connection: D },
  otherTakesOnD: { _tag: "Take", by: OTHER, connection: D },
  fenceDone: { _tag: "Fenced", epoch: 4 },
  staleFenceDone: { _tag: "Fenced", epoch: 3 },
  dLapses: { _tag: "Lapse", connection: D, reason: "lease-lapsed", at: later },
  ownerHandsBack: { _tag: "HandBack", by: OWNER },
  otherHandsBack: { _tag: "HandBack", by: OTHER },
  pauseTimeoutEarly: { _tag: "PausedTimeout", at: at(SCREEN_LIMITS.pausedTimeoutMs - 1) },
  pauseTimeoutDue: { _tag: "PausedTimeout", at: at(SCREEN_LIMITS.pausedTimeoutMs) },
  agentLooks: { _tag: "AgentLooked" },
  agentActs: { _tag: "AgentActed" },
  boot: { _tag: "Boot", at: later },
  ended: { _tag: "Ended" },
} satisfies Record<string, ScreenInputEvent>;
type Event = keyof typeof events;

const same: ScreenInputTransition = { _tag: "Unchanged" };
const refused = (why: "owner-only" | "held" | "look-first"): ScreenInputTransition => ({
  _tag: "Refused",
  why,
});
const to = (
  next: ScreenInput,
  releases = false,
  log: ScreenInputLog | null = null,
): ScreenInputTransition => ({
  _tag: "Changed",
  next,
  releases,
  log,
});
const owner = { _tag: "Person", userId: OWNER } as const satisfies ScreenInputLog["actor"];
const fenceToD = {
  _tag: "Fencing",
  epoch: 5,
  by: OWNER,
  to: { _tag: "Person", connection: D },
} as const;
const fenceBack = { _tag: "Fencing", epoch: 5, by: OWNER, to: { _tag: "AwaitingAgent" } } as const;
const pausedBy = (reason: "lease-lapsed" | "restart", releases: boolean) =>
  to({ _tag: "Paused", epoch: 5, reason, since: later }, releases, {
    actor: { _tag: "Mend" },
    body: { _tag: "Paused", reason },
  });
const awaiting5 = { _tag: "AwaitingAgent", epoch: 5 } as const;

const table: Record<Event, Record<State, ScreenInputTransition>> = {
  ownerTakesOnD: {
    agent: to(fenceToD, true),
    fencingToD: same,
    fencingToC: to(fenceToD),
    fencingBack: to(fenceToD),
    personD: same,
    personC: to(fenceToD, true),
    paused: to(fenceToD),
    awaiting: to(fenceToD),
  },
  otherTakesOnD: {
    agent: refused("owner-only"),
    fencingToD: refused("owner-only"),
    fencingToC: refused("owner-only"),
    fencingBack: refused("owner-only"),
    personD: refused("owner-only"),
    personC: refused("owner-only"),
    paused: refused("owner-only"),
    awaiting: refused("owner-only"),
  },
  fenceDone: {
    agent: same,
    fencingToD: to({ _tag: "Person", epoch: 4, userId: OWNER, connection: D }, false, {
      actor: owner,
      body: { _tag: "Taken", epoch: 4 },
    }),
    fencingToC: to({ _tag: "Person", epoch: 4, userId: OWNER, connection: C }, false, {
      actor: owner,
      body: { _tag: "Taken", epoch: 4 },
    }),
    fencingBack: to({ _tag: "AwaitingAgent", epoch: 4 }, false, {
      actor: owner,
      body: { _tag: "HandedBack", epoch: 4 },
    }),
    personD: same,
    personC: same,
    paused: same,
    awaiting: same,
  },
  staleFenceDone: {
    agent: same,
    fencingToD: same,
    fencingToC: same,
    fencingBack: same,
    personD: same,
    personC: same,
    paused: same,
    awaiting: same,
  },
  dLapses: {
    agent: same,
    fencingToD: pausedBy("lease-lapsed", false),
    fencingToC: same,
    fencingBack: same,
    personD: pausedBy("lease-lapsed", true),
    personC: same,
    paused: same,
    awaiting: same,
  },
  ownerHandsBack: {
    agent: same,
    fencingToD: to(fenceBack),
    fencingToC: to(fenceBack),
    fencingBack: same,
    personD: to(fenceBack, true),
    personC: to(fenceBack, true),
    paused: to(awaiting5, false, { actor: owner, body: { _tag: "HandedBack", epoch: 5 } }),
    awaiting: same,
  },
  otherHandsBack: {
    agent: refused("owner-only"),
    fencingToD: refused("owner-only"),
    fencingToC: refused("owner-only"),
    fencingBack: refused("owner-only"),
    personD: refused("owner-only"),
    personC: refused("owner-only"),
    paused: refused("owner-only"),
    awaiting: refused("owner-only"),
  },
  pauseTimeoutEarly: {
    agent: same,
    fencingToD: same,
    fencingToC: same,
    fencingBack: same,
    personD: same,
    personC: same,
    paused: same,
    awaiting: same,
  },
  pauseTimeoutDue: {
    agent: same,
    fencingToD: same,
    fencingToC: same,
    fencingBack: same,
    personD: same,
    personC: same,
    paused: to(awaiting5, false, {
      actor: { _tag: "Mend" },
      body: { _tag: "HandedBack", epoch: 5 },
    }),
    awaiting: same,
  },
  agentLooks: {
    agent: same,
    fencingToD: refused("held"),
    fencingToC: refused("held"),
    fencingBack: refused("held"),
    personD: refused("held"),
    personC: refused("held"),
    paused: refused("held"),
    awaiting: to({ _tag: "Agent", epoch: 5 }),
  },
  agentActs: {
    agent: same,
    fencingToD: refused("held"),
    fencingToC: refused("held"),
    fencingBack: refused("held"),
    personD: refused("held"),
    personC: refused("held"),
    paused: refused("held"),
    awaiting: refused("look-first"),
  },
  boot: {
    agent: to(awaiting5),
    fencingToD: pausedBy("restart", false),
    fencingToC: pausedBy("restart", false),
    fencingBack: pausedBy("restart", false),
    personD: pausedBy("restart", false),
    personC: pausedBy("restart", false),
    paused: same,
    awaiting: same,
  },
  ended: {
    agent: to(awaiting5),
    fencingToD: to(awaiting5),
    fencingToC: to(awaiting5),
    fencingBack: to(awaiting5),
    personD: to(awaiting5),
    personC: to(awaiting5),
    paused: to(awaiting5),
    awaiting: same,
  },
};

const isKey = <K extends string>(record: Record<K, unknown>, key: string): key is K =>
  Object.hasOwn(record, key);
const cells = Object.entries(table).flatMap(([event, row]) =>
  Object.entries(row).flatMap(([state, expected]) =>
    isKey(events, event) && isKey(states, state) ? [{ event, state, expected }] : [],
  ),
);

const tags = (values: ReadonlyArray<{ _tag: string }>) => new Set(values.map((v) => v._tag));

describe("transitionInput", () => {
  it.each(cells)("$event in $state", ({ event, state, expected }) => {
    expect(transitionInput(states[state], events[event], OWNER)).toEqual(expected);
  });

  it("covers every state and event in the ADR's table", () => {
    expect(tags(Object.values(states))).toEqual(
      new Set(["Agent", "Fencing", "Person", "Paused", "AwaitingAgent"]),
    );
    expect(tags(Object.values(events))).toEqual(
      new Set([
        "Take",
        "Fenced",
        "Lapse",
        "HandBack",
        "PausedTimeout",
        "AgentLooked",
        "AgentActed",
        "Boot",
        "Ended",
      ]),
    );
    expect(cells).toHaveLength(Object.keys(states).length * Object.keys(events).length);
  });

  it.each(cells.filter((cell) => cell.expected._tag === "Changed"))(
    "$event twice in $state changes nothing the second time",
    ({ event, state }) => {
      const first = transitionInput(states[state], events[event], OWNER);
      if (first._tag !== "Changed") throw new Error(`expected a change, got ${first._tag}`);
      expect(transitionInput(first.next, events[event], OWNER)._tag).not.toBe("Changed");
    },
  );

  it("refuses every Take and Hand back on a screen whose session has no owner", () => {
    for (const state of Object.values(states)) {
      expect(transitionInput(state, events.ownerTakesOnD, null)).toEqual(refused("owner-only"));
      expect(transitionInput(state, events.ownerHandsBack, null)).toEqual(refused("owner-only"));
    }
  });

  it("walks a takeover from the initial state to the agent's next look", () => {
    const steps: ReadonlyArray<ScreenInputEvent> = [
      events.agentLooks,
      events.ownerTakesOnD,
      { _tag: "Fenced", epoch: 2 },
      events.ownerHandsBack,
      { _tag: "Fenced", epoch: 3 },
      events.agentLooks,
    ];
    const seen = steps.reduce<ReadonlyArray<ScreenInput>>((trail, event) => {
      const result = transitionInput(trail[trail.length - 1] ?? SCREEN_INPUT_INITIAL, event, OWNER);
      if (result._tag !== "Changed") throw new Error(`${event._tag} did not change the input`);
      return [...trail, result.next];
    }, []);
    expect(seen.map((input) => `${input._tag}@${input.epoch}`)).toEqual([
      "Agent@1",
      "Fencing@2",
      "Person@2",
      "Fencing@3",
      "AwaitingAgent@3",
      "Agent@4",
    ]);
  });
});
