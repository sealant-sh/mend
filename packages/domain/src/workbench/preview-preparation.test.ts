import { describe, expect, it } from "vitest";

import {
  AgentTurnId,
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  ServiceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "../ids.ts";
import { AgentTurn } from "./agent-protocol.ts";
import {
  coveredTurns,
  type PreviewFacts,
  type PreviewPreparation,
  type PreviewPreparationLeft,
  type PreviewPreparationState,
  previewPhaseOf,
  previewStatusesOf,
  unpreparedStatusOf,
} from "./preview-preparation.ts";
import { type Preview, type PreviewGatewayResolution, previewStatusLine } from "./preview.ts";
import { ServiceStartProgress, ServiceStartSetup, ServiceStartStep } from "./service-recipe.ts";

const T0 = new Date("2026-10-30T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const web: Preview = {
  id: PreviewId.make("preview-web"),
  projectId: ProjectId.make("project"),
  worktreeId: WorktreeId.make("worktree"),
  serviceName: "web",
  label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
  state: "kept",
};

const bound: PreviewGatewayResolution = {
  _tag: "Bound",
  revision: 0,
  attempt: {
    serviceId: ServiceId.make("service-web"),
    attemptId: SessionProcessId.make("attempt-2"),
    sessionId: SessionId.make("session"),
    workspaceId: SealantWorkspaceId.make("ws"),
    port: 3000,
    platformSessionId: "pty",
    host: "rewrite",
    dial: "session-bound",
  },
};

const dormant: PreviewGatewayResolution = {
  _tag: "Dormant",
  revision: 0,
  source: {
    serviceId: ServiceId.make("service-web"),
    sourceAttemptId: SessionProcessId.make("attempt-1"),
  },
  workspaceId: null,
};

const factsWith = (overrides: Partial<PreviewFacts> = {}): PreviewFacts => ({
  preview: web,
  resolution: dormant,
  observation: null,
  attemptStartedAt: null,
  ...overrides,
});

const prepared = (state: PreviewPreparationState, claimedAt = at(0)): PreviewPreparation => ({
  turnId: AgentTurnId.make("turn"),
  sessionId: SessionId.make("session"),
  worktreeId: WorktreeId.make("worktree"),
  claimedAt,
  state,
});

const decided = (
  decision: Extract<PreviewPreparationState, { readonly _tag: "Decided" }>["decision"],
  decidedAt = at(10),
) => prepared({ _tag: "Decided", decision, decidedAt });

const lines = (facts: PreviewFacts, preparation: PreviewPreparation | null, now = at(64)) =>
  previewStatusesOf(facts, preparation).map((status) => previewStatusLine(status, { now }));

describe("a preview's status lines", () => {
  it("says what the bound Service's ready check answered, and when", () => {
    expect(
      lines(
        factsWith({
          resolution: bound,
          observation: { state: "reachable", httpStatus: 200, lastObservedAt: at(60) },
        }),
        null,
      ),
    ).toEqual(["preview · web · answered HTTP 200 · observed 4 s ago"]);
  });

  it("names the person whose Stop holds it, whatever a preparation recorded", () => {
    const stopped: PreviewGatewayResolution = {
      _tag: "Stopped",
      control: { _tag: "Stopped", revision: 1, by: "u-maria", at: T0, seq: 3, byName: "Maria" },
    };
    expect(
      lines(
        factsWith({ resolution: stopped }),
        decided({ _tag: "Stopped", service: "web", previewId: web.id }),
      ),
    ).toEqual(["preview · web · stopped by Maria"]);
  });

  it("says the phase of the start under way, setup before any attempt exists", () => {
    const starting = prepared({
      _tag: "Starting",
      service: "web",
      previewId: web.id,
      phase: "setup",
      note: null,
    });
    expect(lines(factsWith(), starting)).toEqual(["preview · web · starting · setup"]);
    expect(
      lines(
        factsWith({
          resolution: {
            _tag: "Starting",
            revision: 0,
            attemptId: SessionProcessId.make("attempt-2"),
            workspaceId: SealantWorkspaceId.make("ws"),
          },
        }),
        null,
      ),
    ).toEqual(["preview · web · starting · web"]);
  });

  it("adds a running preview's note only while it runs the attempt the turn saw", () => {
    const leftAlone = decided({
      _tag: "Running",
      service: "web",
      previewId: web.id,
      note: "setup-inputs-changed",
    });
    const running = (attemptStartedAt: Date) =>
      factsWith({
        resolution: bound,
        observation: { state: "reachable", httpStatus: 200, lastObservedAt: at(60) },
        attemptStartedAt,
      });
    expect(lines(running(at(-300)), leftAlone)).toEqual([
      "preview · web · answered HTTP 200 · observed 4 s ago",
      "setup inputs changed · restart to apply",
    ]);
    expect(lines(running(at(30)), leftAlone)).toEqual([
      "preview · web · answered HTTP 200 · observed 4 s ago",
    ]);
  });

  it("says why a stopped-running preview was not prepared, and only for its own Service", () => {
    const refused = decided({
      _tag: "Refused",
      service: "web",
      previewId: web.id,
      reason: "setup failed",
    });
    expect(lines(factsWith(), refused)).toEqual(["preview not prepared · web · setup failed"]);
    expect(lines(factsWith({ preview: { ...web, serviceName: "docs" } }), refused)).toEqual([]);
  });

  it("drops a refusal once a Start began an attempt after it, running or not", () => {
    const refused = decided(
      { _tag: "Refused", service: "web", previewId: web.id, reason: "setup failed" },
      at(10),
    );
    expect(lines(factsWith({ attemptStartedAt: at(20) }), refused)).toEqual([]);
    expect(lines(factsWith({ attemptStartedAt: at(5) }), refused)).toEqual([
      "preview not prepared · web · setup failed",
    ]);
  });

  it("says nothing past a later decision that read the change, whatever came before it", () => {
    expect(lines(factsWith(), decided({ _tag: "NoChange" }))).toEqual([]);
    expect(unpreparedStatusOf([web], decided({ _tag: "NoChange" }))).toBeNull();
  });

  it("states a refusal that named no Service, from a mend.toml it could not read", () => {
    const status = unpreparedStatusOf(
      [web],
      decided({ _tag: "Refused", service: null, previewId: null, reason: "mend.toml: bad\nmore" }),
    );
    expect(status === null ? null : previewStatusLine(status, { now: at(0) })).toBe(
      "preview not prepared · mend.toml: bad",
    );
  });
});

describe("the worktree's own line", () => {
  it("states a change that was not captured, which names no preview", () => {
    const status = unpreparedStatusOf([web], decided({ _tag: "NotCaptured" }));
    expect(status === null ? null : previewStatusLine(status, { now: at(0) })).toBe(
      "preview not prepared · change not captured",
    );
  });

  it("states a refusal before any preview of the Service exists, and leaves a kept one's to it", () => {
    const refused = decided({
      _tag: "Refused",
      service: "web",
      previewId: null,
      reason: "setup failed",
    });
    const status = unpreparedStatusOf([], refused);
    expect(status === null ? null : previewStatusLine(status, { now: at(0) })).toBe(
      "preview not prepared · web · setup failed",
    );
    expect(unpreparedStatusOf([web], refused)).toBeNull();
  });

  it("says nothing for a question, a skipped turn, or a project without [preview]", () => {
    for (const decision of [
      { _tag: "NoChange" },
      { _tag: "NoPreview" },
      { _tag: "Skipped", why: "ended long ago" },
    ] as const) {
      expect(unpreparedStatusOf([], decided(decision))).toBeNull();
    }
  });
});

const progress = (
  setup: ServiceStartSetup["state"] | null,
  db: ServiceStartStep["state"],
  target: ServiceStartStep["state"],
) =>
  new ServiceStartProgress({
    service: "web",
    state: "running",
    steps: [
      new ServiceStartStep({ name: "db", port: 5432, state: db, reason: null }),
      new ServiceStartStep({ name: "web", port: 3000, state: target, reason: null }),
    ],
    message: null,
    setup:
      setup === null ? null : new ServiceStartSetup({ state: setup, step: null, reason: null }),
  });

const turnAt = (ordinal: number) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${ordinal}`),
    sessionId: SessionId.make("session"),
    processId: SessionProcessId.make("process"),
    ordinal,
    author: "alice",
    input: "fix it",
    status: "completed",
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: at(ordinal * 60),
    startedAt: at(ordinal * 60),
    endedAt: at(ordinal * 60 + 30),
  });

describe("coveredTurns", () => {
  const turns = [0, 1, 2, 3].map(turnAt);
  const ordinals = (left: ReadonlyMap<AgentTurnId, PreviewPreparationLeft>, last: number) =>
    coveredTurns(turns, left, turnAt(last)).map((turn) => turn.ordinal);

  it("reaches back over turns a later turn superseded, or none decided, to the last one decided", () => {
    const left = new Map<AgentTurnId, PreviewPreparationLeft>([
      [AgentTurnId.make("turn-0"), "decided"],
      [AgentTurnId.make("turn-1"), "superseded"],
    ]);
    expect(ordinals(left, 3)).toEqual([1, 2, 3]);
    expect(ordinals(new Map(), 3)).toEqual([0, 1, 2, 3]);
    expect(ordinals(new Map([[AgentTurnId.make("turn-2"), "decided"]]), 3)).toEqual([3]);
  });
});

describe("previewPhaseOf", () => {
  it("is setup, then the dependencies, then the Service", () => {
    expect(previewPhaseOf(progress("running", "waiting", "waiting"))).toBe("setup");
    expect(previewPhaseOf(progress("ran", "starting", "waiting"))).toBe("depends");
    expect(previewPhaseOf(progress("unchanged", "ready", "starting"))).toBe("service");
    expect(previewPhaseOf(progress(null, "ready", "ready"))).toBeNull();
  });
});

it("describes an idle source, but a live attempt and a person's Stop take precedence", () => {
  const facts: PreviewFacts = {
    preview: web,
    resolution: dormant,
    observation: null,
    attemptStartedAt: T0,
    idleStop: { minutes: 30 },
  };
  expect(
    previewStatusesOf(facts, null).map((status) => previewStatusLine(status, { now: T0 })),
  ).toEqual(["preview · web · stopped after 30 min idle"]);
  expect(previewStatusesOf({ ...facts, resolution: bound }, null)).toEqual([]);
});
