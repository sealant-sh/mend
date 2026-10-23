import type { SessionStatus } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  Expected,
  NoLiveAgent,
  Restart,
  refusalError,
  refusalOf,
  type LaunchOver,
} from "./launch-admission.ts";

const settled = new Date("2026-10-19T08:00:00.123Z");
const later = new Date("2026-10-19T08:05:00.456Z");

const observed = (
  status: SessionStatus,
  settledAt: Date | null,
  agentLive: boolean,
  underWay = false,
  agentRan = agentLive,
) => ({ status, settledAt, agentLive, underWay, agentRan });

describe("refusalOf (SLNT-167)", () => {
  it.each<{
    readonly row: string;
    readonly over: LaunchOver;
    readonly seen: ReturnType<typeof observed>;
    readonly answer: string | null;
  }>([
    {
      row: "Expected, another launch under way",
      over: Expected(settled),
      seen: observed("failed", settled, false, true),
      answer: "MovedOn starting",
    },
    {
      row: "Expected, the agent live",
      over: Expected(null),
      seen: observed("running", null, true),
      answer: "MovedOn running",
    },
    {
      row: "Expected, settled again since",
      over: Expected(settled),
      seen: observed("failed", later, false),
      answer: "MovedOn failed",
    },
    {
      row: "Expected settled, the session now unsettled and not live",
      over: Expected(settled),
      seen: observed("idle", null, false),
      answer: "MovedOn idle",
    },
    {
      row: "Expected never settled, the session settled since",
      over: Expected(null),
      seen: observed("failed", settled, false),
      answer: "MovedOn failed",
    },
    {
      row: "Expected, the same attempt",
      over: Expected(new Date(settled.getTime())),
      seen: observed("failed", settled, false),
      answer: null,
    },
    {
      row: "Expected never settled, never launched",
      over: Expected(null),
      seen: observed("starting", null, false),
      answer: null,
    },
    {
      row: "NoLiveAgent, another launch under way",
      over: NoLiveAgent,
      seen: observed("failed", settled, false, true),
      answer: "AgentLive starting under way",
    },
    {
      row: "NoLiveAgent, the agent live",
      over: NoLiveAgent,
      seen: observed("running", null, true),
      answer: "AgentLive running",
    },
    {
      row: "NoLiveAgent, nothing live",
      over: NoLiveAgent,
      seen: observed("failed", settled, false),
      answer: null,
    },
    {
      row: "Restart, another launch under way",
      over: Restart,
      seen: observed("running", null, true, true),
      answer: "AgentLive starting under way",
    },
    {
      row: "Restart, the agent live",
      over: Restart,
      seen: observed("running", null, true),
      answer: null,
    },
    {
      row: "Restart, nothing live",
      over: Restart,
      seen: observed("failed", settled, false),
      answer: null,
    },
  ])("$row → $answer", ({ over, seen, answer }) => {
    const refusal = refusalOf(over, seen);
    expect(
      refusal === null
        ? null
        : [
            refusal._tag,
            refusal.status,
            ...(refusal._tag === "AgentLive" && refusal.underWay ? ["under way"] : []),
          ].join(" "),
    ).toBe(answer);
    if (refusal !== null) expect(refusal.settledAt).toBe(seen.settledAt);
  });

  it.each<{
    readonly row: string;
    readonly over: LaunchOver;
    readonly seen: ReturnType<typeof observed>;
    readonly reason: string | null;
  }>([
    {
      row: "Expected never launched, an agent ran and exited while a shell holds the session idle",
      over: Expected(null),
      seen: observed("idle", null, false, false, true),
      reason: "agentRan",
    },
    {
      row: "Expected never launched, an agent ran and the session settled",
      over: Expected(null),
      seen: observed("failed", settled, false, false, true),
      reason: "agentRan",
    },
    {
      row: "Expected the failed attempt, which ran an agent",
      over: Expected(settled),
      seen: observed("failed", settled, false, false, true),
      reason: null,
    },
    {
      row: "NoLiveAgent, an agent ran and exited",
      over: NoLiveAgent,
      seen: observed("idle", null, false, false, true),
      reason: null,
    },
  ])("$row → $reason", ({ over, seen, reason }) => {
    const refusal = refusalOf(over, seen);
    if (reason === null) expect(refusal).toBeNull();
    else expect(refusal).toMatchObject({ _tag: "MovedOn", status: seen.status, reason });
  });

  it("says an agent ran that the caller did not see apart from a plain move", () => {
    expect(
      refusalError("s-1", {
        _tag: "MovedOn",
        status: "idle",
        settledAt: null,
        reason: "agentRan",
      }),
    ).toMatchObject({
      _tag: "SessionMovedOnError",
      reason: "agentRan",
      message: "an agent already ran in this session · it reads idle · nothing launched again",
    });
  });

  it("says what the session reads now, and keeps the gate's words for a launch under way", () => {
    const movedOn = refusalError("s-1", {
      _tag: "MovedOn",
      status: "failed",
      settledAt: later,
      reason: "settled",
    });
    expect(movedOn._tag).toBe("SessionMovedOnError");
    expect(movedOn.message).toBe(
      "the session moved on · it reads failed · settled 2026-10-19T08:05:00.456Z · nothing launched",
    );
    expect(
      refusalError("s-1", {
        _tag: "MovedOn",
        status: "running",
        settledAt: null,
        reason: "agentLive",
      }).message,
    ).toBe("the session moved on · it reads running · nothing launched");
    const live = refusalError("s-1", {
      _tag: "AgentLive",
      status: "running",
      settledAt: null,
      underWay: false,
    });
    expect(live._tag).toBe("SessionAgentLiveError");
    expect(live.message).toBe(
      "the session's agent is live · nothing restarted · attach to it, or stop it and launch again",
    );
    expect(
      refusalError("s-1", {
        _tag: "AgentLive",
        status: "starting",
        settledAt: null,
        underWay: true,
      }).message,
    ).toBe("starting · a launch of this session is already under way · nothing new started");
  });
});
