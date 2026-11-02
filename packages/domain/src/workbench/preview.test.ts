import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  encodePreviewLabel,
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "../ids.ts";
import {
  changePreviewControl,
  previewControlDecider,
  Preview,
  type PreviewBinding,
  PREVIEW_CONTROL_INITIAL,
  type PreviewControlIntent,
  type PreviewControlRead,
  previewGatewayResolution,
  type PreviewNotDelivered,
  previewOpenTarget,
  previewOffersOpen,
  type PreviewGatewayResolution,
  previewResumeCandidate,
  previewStartId,
  previewStartReasonOf,
  type PreviewTarget,
  previewStatusLine,
  PreviewStatus,
  previewUndeliveredLine,
  type PreviewUnboundReason,
  resolvePreviewBinding,
  selectPreviewTarget,
  startedByPreviewRequest,
} from "./preview.ts";
import { Service, serviceStartCorrelation } from "./service.ts";
import { SessionProcess } from "./session-process.ts";

const preview: Preview = {
  id: PreviewId.make("preview"),
  projectId: ProjectId.make("project"),
  worktreeId: WorktreeId.make("worktree"),
  serviceName: "web",
  label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
  state: "kept",
};
const at = new Date("2026-10-24T10:00:00Z");
const service = (id = "service", overrides: Partial<Service> = {}) =>
  new Service({
    id: ServiceId.make(id),
    sessionId: SessionId.make(`session-${id}`),
    name: "web",
    declarationSource: "explicit-run",
    workspacePort: 3000,
    transport: "tcp",
    browserScheme: "http",
    bindAddresses: [],
    preferredHostPort: null,
    currentAttemptId: SessionProcessId.make(`attempt-${id}`),
    currentForwardId: null,
    attemptHistoryComplete: true,
    forwardHistoryComplete: true,
    observationHistoryComplete: true,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
const attempt = (owner: Service, overrides: Partial<SessionProcess> = {}) =>
  new SessionProcess({
    id: SessionProcessId.make(`attempt-${owner.id}`),
    serviceId: owner.id,
    sessionId: owner.sessionId,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace"),
    sealantSessionId: "pty",
    sealantRunId: null,
    launchCorrelationId: null,
    attemptOrdinal: 1,
    kind: "service",
    harness: null,
    providerSessionId: null,
    protocolOptions: null,
    label: "web",
    argv: ["npm", "run", "dev"],
    status: "running",
    exitCode: null,
    workspacePort: 3000,
    protocol: "tcp",
    hostPort: null,
    createdAt: at,
    updatedAt: at,
    exitedAt: null,
    ...overrides,
  });
const unbound = (reason: string) => ({ _tag: "Unbound", reason });
const live = (owner: Service, overrides: Partial<SessionProcess> = {}): PreviewTarget => ({
  service: owner,
  liveAttempt: attempt(owner, overrides),
  recordedCommand: (overrides.argv ?? ["npm"]).length > 0,
  workspaceId: SealantWorkspaceId.make("workspace"),
});
const idle = (owner: Service, recordedCommand = false): PreviewTarget => ({
  service: owner,
  liveAttempt: null,
  recordedCommand,
  workspaceId: SealantWorkspaceId.make("workspace"),
});

const LOOPBACK = { host: "rewrite", dial: "session-bound" } as const;

describe("preview bindings", () => {
  it("does not resolve a removed preview, even with live rows", () => {
    expect(
      resolvePreviewBinding({ ...preview, state: "removed", worktreeId: null }, [live(service())]),
    ).toEqual(unbound("removed"));
  });
  it("names a missing Service and a Service that no longer has a browser scheme", () => {
    expect(resolvePreviewBinding(preview, [idle(service("other", { name: "api" }))])).toEqual(
      unbound("service-missing"),
    );
    expect(resolvePreviewBinding(preview, [idle(service("raw", { browserScheme: null }))])).toEqual(
      unbound("not-browser-service"),
    );
  });
  it("takes the unbound reason from the newest declaration of the name", () => {
    const http = service("http");
    const raw = service("raw", { browserScheme: null, createdAt: new Date(at.getTime() + 1) });
    expect(resolvePreviewBinding(preview, [idle(http, true), live(raw)])).toEqual(
      unbound("not-browser-service"),
    );
    const tls = service("tls", { browserScheme: "https", createdAt: new Date(at.getTime() - 1) });
    expect(resolvePreviewBinding(preview, [idle(http, true), idle(tls)])).toEqual(
      unbound("no-live-attempt"),
    );
  });
  it("an adopted port has no recorded command, regardless of an open forward", () => {
    const adopted = service("adopted", {
      declarationSource: "explicit-adopt",
      currentAttemptId: null,
      currentForwardId: ServiceForwardId.make("open-forward"),
    });
    expect(resolvePreviewBinding(preview, [idle(adopted)])).toEqual(unbound("no-recorded-command"));
    const recipe = service("recipe", { declarationSource: "recipe-file", currentAttemptId: null });
    expect(resolvePreviewBinding(preview, [idle(recipe)])).toEqual(unbound("no-recorded-command"));
    expect(resolvePreviewBinding(preview, [idle(recipe, true)])).toEqual(
      unbound("no-live-attempt"),
    );
  });
  it("refuses HTTPS even when its attempt is live", () => {
    const web = service("https", { browserScheme: "https" });
    expect(resolvePreviewBinding(preview, [live(web)])).toEqual(unbound("https-unsupported"));
    expect(resolvePreviewBinding(preview, [idle(web)])).toEqual(unbound("https-unsupported"));
  });
  it("a Service whose attempts all exited is unbound, whatever its pointer says", () => {
    expect(resolvePreviewBinding(preview, [idle(service(), true)])).toEqual(
      unbound("no-live-attempt"),
    );
  });
  it("an explicit run whose first attempt is not inserted yet is not read as adopted", () => {
    const starting = service("starting", { currentAttemptId: null });
    expect(resolvePreviewBinding(preview, [idle(starting)])).toEqual(unbound("no-live-attempt"));
  });
  it("a live attempt binds before the Service's pointer catches up", () => {
    const first = service("first", { currentAttemptId: null });
    const second = service("second");
    const older = live(first);
    const newer = live(second, { createdAt: new Date(at.getTime() + 1) });
    expect(resolvePreviewBinding(preview, [newer, older])).toEqual({
      _tag: "Bound",
      serviceId: first.id,
      attemptId: older.liveAttempt?.id,
      ...LOOPBACK,
    });
  });
  it("carries the Service's Host policy, and dials a docker Service port-scoped", () => {
    const web = service("service", { hostPolicy: "preserve", address: "docker" });
    expect(resolvePreviewBinding(preview, [live(web)])).toMatchObject({
      _tag: "Bound",
      host: "preserve",
      dial: "port-scoped",
    });
  });
  it("binds a starting attempt and refuses a live attempt without a command", () => {
    const web = service();
    expect(resolvePreviewBinding(preview, [live(web, { status: "starting" })])).toEqual({
      _tag: "Bound",
      serviceId: web.id,
      attemptId: SessionProcessId.make("attempt-service"),
      ...LOOPBACK,
    });
    expect(resolvePreviewBinding(preview, [live(web, { argv: [] })])).toEqual(
      unbound("no-recorded-command"),
    );
  });
  it("the oldest live attempt wins across sessions; an exit lets the next one bind", () => {
    const first = service("first", { createdAt: new Date(at.getTime() + 1000) });
    const second = service("second");
    const older = live(first);
    const newer = live(second, { createdAt: new Date(at.getTime() + 1) });
    const bound = {
      _tag: "Bound",
      serviceId: first.id,
      attemptId: older.liveAttempt?.id,
      ...LOOPBACK,
    };
    expect(resolvePreviewBinding(preview, [newer, older])).toEqual(bound);
    expect(resolvePreviewBinding(preview, [older, newer])).toEqual(bound);
    expect(resolvePreviewBinding(preview, [idle(first, true), newer])).toEqual({
      _tag: "Bound",
      serviceId: second.id,
      attemptId: newer.liveAttempt?.id,
      ...LOOPBACK,
    });
  });
  it("an HTTPS attempt keeps its precedence over a later HTTP Service", () => {
    const first = service("https", { browserScheme: "https" });
    const second = service("http");
    expect(
      resolvePreviewBinding(preview, [
        live(second, { createdAt: new Date(at.getTime() + 1) }),
        live(first),
      ]),
    ).toEqual(unbound("https-unsupported"));
  });
  it("breaks equal timestamps by attempt id, independently of row order", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 10000 }), { minLength: 2, maxLength: 25 }),
        (ids) => {
          const targets = ids.map((id) => live(service(String(id))));
          const oldest = targets
            .flatMap((target) => (target.liveAttempt === null ? [] : [target.liveAttempt]))
            .toSorted((a, b) => (a.id < b.id ? -1 : 1))[0];
          if (oldest === undefined) throw new Error("missing generated attempt");
          const expected = {
            _tag: "Bound",
            serviceId: oldest.serviceId,
            attemptId: oldest.id,
            ...LOOPBACK,
          };
          expect(resolvePreviewBinding(preview, targets)).toEqual(expected);
          expect(resolvePreviewBinding(preview, targets.toReversed())).toEqual(expected);
        },
      ),
    );
  });
});

it("labels accept only canonical 128-bit lowercase base32", () => {
  const valid = Schema.is(PreviewLabel);
  expect(valid("aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
  expect(valid("77777777777777777777777774")).toBe(true);
  for (const label of [
    "a".repeat(25),
    "a".repeat(27),
    "A".repeat(26),
    "0".repeat(26),
    `${"a".repeat(25)}b`,
    `project-${"a".repeat(26)}`,
  ]) {
    expect(valid(label), label).toBe(false);
  }
});

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

it("encodes all-zero, all-one and counting bytes without padding", () => {
  expect(encodePreviewLabel(new Uint8Array(16))).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(encodePreviewLabel(new Uint8Array(16).fill(255))).toBe("77777777777777777777777774");
  expect(encodePreviewLabel(Uint8Array.from({ length: 16 }, (_, index) => index))).toBe(
    "aaaqeayeaudaocajbifqydiob4",
  );
});

it("a label preserves all 128 input bits and leaves only two zero padding bits", () => {
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (bytes) => {
      const label = encodePreviewLabel(bytes);
      expect(Schema.is(PreviewLabel)(label)).toBe(true);
      const encodedBits = [...label]
        .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
        .join("");
      const inputBits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
      expect(encodedBits).toBe(`${inputBits}00`);
    }),
  );
});

describe("previewStatusLine", () => {
  const observedAt = new Date("2026-10-30T12:00:00.000Z");
  const now = new Date(observedAt.getTime() + 4_000);
  const lines: ReadonlyArray<readonly [PreviewStatus, string]> = [
    [
      { _tag: "Observed", service: "web", reachable: true, httpStatus: 200, observedAt },
      "preview · web · answered HTTP 200 · observed 4 s ago",
    ],
    [
      { _tag: "Observed", service: "web", reachable: true, httpStatus: null, observedAt },
      "preview · web · reachable · observed 4 s ago",
    ],
    [
      { _tag: "Observed", service: "web", reachable: false, httpStatus: null, observedAt },
      "preview · web · unreachable · observed 4 s ago",
    ],
    [{ _tag: "Starting", service: "web", phase: "setup" }, "preview · web · starting · setup"],
    [{ _tag: "Starting", service: "web", phase: "depends" }, "preview · web · starting · depends"],
    [{ _tag: "Starting", service: "web", phase: "service" }, "preview · web · starting · web"],
    [
      { _tag: "Stopped", service: "web", by: { _tag: "Person", name: "Maria" } },
      "preview · web · stopped by Maria",
    ],
    [
      { _tag: "Stopped", service: "web", by: { _tag: "Idle", minutes: 30 } },
      "preview · web · stopped after 30 min idle",
    ],
    [
      { _tag: "NotPrepared", service: null, why: { _tag: "NotCaptured" } },
      "preview not prepared · change not captured",
    ],
    [
      { _tag: "NotPrepared", service: null, why: { _tag: "SessionEnded" } },
      "preview not prepared · session ended",
    ],
    [
      {
        _tag: "NotPrepared",
        service: "web",
        why: { _tag: "Refused", words: "mend.toml refuses web: web · cwd · is absolute\nnotices" },
      },
      "preview not prepared · web · mend.toml refuses web: web · cwd · is absolute",
    ],
    [{ _tag: "SetupInputsChanged" }, "setup inputs changed · restart to apply"],
  ];

  it.each(lines)("states %j as the ADR writes it", (status, line) => {
    expect(previewStatusLine(status, { now })).toBe(line);
  });

  it("ages an observation by the time it is worded, not when it was read", () => {
    const status: PreviewStatus = {
      _tag: "Observed",
      service: "web",
      reachable: true,
      httpStatus: 200,
      observedAt,
    };
    expect(previewStatusLine(status, { now: new Date(observedAt.getTime() + 90_000) })).toBe(
      "preview · web · answered HTTP 200 · observed 1 min ago",
    );
  });

  it("words a fact the same at any time and after any repeat of its check, when asked to be stable", () => {
    for (const [status, line] of lines) {
      const stable = line.replace(/ · observed 4 s ago$/u, " · observed");
      expect(previewStatusLine(status, { stable: true })).toBe(stable);
      if (status._tag === "Observed") {
        const later = { ...status, observedAt: new Date(observedAt.getTime() + 86_400_000) };
        expect(previewStatusLine(later, { stable: true })).toBe(stable);
      }
    }
  });

  it("travels the JSON wire as facts a client words again", () => {
    const wire = Schema.toCodecJson(Schema.Array(PreviewStatus));
    const facts = lines.map(([status]) => status);
    const decoded = Schema.decodeUnknownSync(wire)(
      JSON.parse(JSON.stringify(Schema.encodeSync(wire)(facts))),
    );
    expect(decoded.map((status) => previewStatusLine(status, { now }))).toEqual(
      lines.map(([, line]) => line),
    );
  });
});

describe("previewUndeliveredLine", () => {
  it.each([
    [
      "web",
      { _tag: "DidNotStart", holdMs: 180_000, reason: "setup failed" },
      "preview · web · did not start · setup failed · your request was not delivered",
    ],
    [
      "web",
      { _tag: "DidNotStart", holdMs: 45_000, reason: previewStartReasonOf("start-expired") },
      "preview · web · did not start in 45 s · start timed out · your request was not delivered",
    ],
    [
      "web",
      { _tag: "Stopped", by: "Carol" },
      "preview · web · Carol stopped the preview · your request was not delivered",
    ],
  ] satisfies ReadonlyArray<readonly [string, PreviewNotDelivered, string]>)(
    "states %s %j as the ADR writes it",
    (name, why, line) => {
      expect(previewUndeliveredLine(name, why)).toBe(line);
    },
  );
});

describe("previewOpenTarget", () => {
  const bound: PreviewBinding = {
    _tag: "Bound",
    serviceId: ServiceId.make("service"),
    attemptId: SessionProcessId.make("attempt"),
    host: "rewrite",
    dial: "session-bound",
  };

  it("opens a bound preview, and an ended one the gateway starts on a request", () => {
    expect(previewOpenTarget({ preview, binding: bound })).toBe(
      "/preview-auth?preview=preview&path=%2F",
    );
    expect(
      previewOpenTarget({ preview, binding: { _tag: "Unbound", reason: "no-live-attempt" } }),
    ).toBe("/preview-auth?preview=preview&path=%2F");
  });

  it.each([
    "https-unsupported",
    "no-recorded-command",
    "not-browser-service",
    "service-missing",
    "removed",
  ] satisfies ReadonlyArray<PreviewUnboundReason>)(
    "offers nothing the gateway refuses: %s",
    (reason) => {
      expect(previewOpenTarget({ preview, binding: { _tag: "Unbound", reason } })).toBeNull();
    },
  );
});

describe("previewControlDecider", () => {
  it("is any person, owner or steerer, and never the session's own workspace or Mend", () => {
    expect(previewControlDecider({ kind: "person", userId: "owner" })).toBe("owner");
    expect(previewControlDecider({ kind: "person", userId: "steerer" })).toBe("steerer");
    expect(previewControlDecider({ kind: "workspace" })).toBe(null);
    expect(previewControlDecider({ kind: "workspace", runsAs: "owner" })).toBe(null);
    expect(previewControlDecider({ kind: "system", reason: "idle" })).toBe(null);
    expect(previewControlDecider({ kind: "system", runsAs: null })).toBe(null);
  });
});

describe("changePreviewControl", () => {
  const stop: Extract<PreviewControlIntent, { readonly _tag: "Stop" }> = {
    _tag: "Stop",
    by: "owner",
    at,
    seq: 1,
  };
  it("moves the revision on each change of state, and on nothing else", () => {
    const stopped = changePreviewControl(PREVIEW_CONTROL_INITIAL, stop);
    expect(stopped).toEqual({ _tag: "Stopped", revision: 1, by: "owner", at, seq: 1 });
    const again = new Date(0);
    expect(changePreviewControl(stopped, { ...stop, by: "again", at: again, seq: 2 })).toEqual({
      _tag: "Stopped",
      revision: 1,
      by: "again",
      at: again,
      seq: 2,
    });
    const started = changePreviewControl(stopped, { _tag: "Start", seq: 3 });
    expect(started).toEqual({ _tag: "Automatic", revision: 2 });
    expect(changePreviewControl(started, { _tag: "Start", seq: 4 })).toBe(started);
    expect(changePreviewControl(PREVIEW_CONTROL_INITIAL, { _tag: "Start", seq: 5 })).toBe(
      PREVIEW_CONTROL_INITIAL,
    );
  });

  it("never lets a Start asked before a Stop clear that Stop", () => {
    const stopped = changePreviewControl(PREVIEW_CONTROL_INITIAL, { ...stop, seq: 7 });
    expect(changePreviewControl(stopped, { _tag: "Start", seq: 6 })).toBe(stopped);
    expect(changePreviewControl(stopped, { _tag: "Start", seq: 8 })).toEqual({
      _tag: "Automatic",
      revision: 2,
    });
  });
});

describe("preview start correlation", () => {
  const request = {
    previewId: PreviewId.make("preview"),
    revision: 3,
    sourceAttemptId: SessionProcessId.make("source"),
  };
  it("names the preview, the revision and the source, under the Service's start key", () => {
    const correlation = serviceStartCorrelation("service", previewStartId(request));
    expect(correlation).toBe("service-start:service:preview-start:preview:3:source");
    expect(startedByPreviewRequest("service", correlation)).toBe(true);
    expect(startedByPreviewRequest("other", correlation)).toBe(false);
    expect(
      startedByPreviewRequest("service", serviceStartCorrelation("service", crypto.randomUUID())),
    ).toBe(false);
    expect(startedByPreviewRequest("service", null)).toBe(false);
  });
});

describe("gateway resolution", () => {
  const web = service("web", { currentAttemptId: null });
  const ran = (id: string, seconds: number, overrides: Partial<SessionProcess> = {}) =>
    attempt(web, {
      id: SessionProcessId.make(id),
      createdAt: new Date(at.getTime() + seconds * 1000),
      exitedAt: new Date(at.getTime() + seconds * 1000 + 500),
      status: "exited",
      ...overrides,
    });
  const byRequest = (id: string) =>
    serviceStartCorrelation(
      web.id,
      previewStartId({
        previewId: preview.id,
        revision: 0,
        sourceAttemptId: SessionProcessId.make(id),
      }),
    );
  const dormant = selectPreviewTarget(preview, [idle(web, true)]);
  const stopped: PreviewControlRead = {
    _tag: "Stopped",
    revision: 1,
    by: "steerer",
    at,
    seq: 1,
    byName: "Steerer",
  };

  it("refuses a removed preview whatever its control", () => {
    const removed = selectPreviewTarget({ ...preview, state: "removed", worktreeId: null }, []);
    expect(previewGatewayResolution(stopped, removed, [])).toEqual({
      _tag: "Refused",
      reason: "service-missing",
    });
  });
  it("a person's Stop keeps requests from starting the Service, and serves a run the agent started", () => {
    const bound = selectPreviewTarget(preview, [live(web)]);
    expect(previewGatewayResolution(stopped, bound, [])).toMatchObject({
      _tag: "Bound",
      revision: 1,
    });
    expect(
      previewGatewayResolution(stopped, dormant, [{ attempt: ran("source", 1), reachable: true }]),
    ).toEqual({
      _tag: "Stopped",
      control: stopped,
    });
  });
  it("binds a running attempt with its workspace, port and platform session", () => {
    const bound = selectPreviewTarget(preview, [live(web)]);
    expect(previewGatewayResolution({ _tag: "Automatic", revision: 4 }, bound, [])).toEqual({
      _tag: "Bound",
      revision: 4,
      attempt: {
        serviceId: web.id,
        attemptId: SessionProcessId.make("attempt-web"),
        sessionId: web.sessionId,
        workspaceId: SealantWorkspaceId.make("workspace"),
        port: 3000,
        platformSessionId: "pty",
        ...LOOPBACK,
      },
    });
    const unhandled = selectPreviewTarget(preview, [live(web, { sealantSessionId: null })]);
    expect(previewGatewayResolution(PREVIEW_CONTROL_INITIAL, unhandled, [])).toEqual({
      _tag: "Refused",
      reason: "process-binding-unavailable",
    });
  });
  it("a starting attempt is waited on, before its process handle is recorded too", () => {
    for (const sealantSessionId of [null, "pty"]) {
      const starting = selectPreviewTarget(preview, [
        live(web, { status: "starting", sealantSessionId }),
      ]);
      expect(previewGatewayResolution({ _tag: "Automatic", revision: 4 }, starting, [])).toEqual({
        _tag: "Starting",
        revision: 4,
        attemptId: SessionProcessId.make("attempt-web"),
        workspaceId: SealantWorkspaceId.make("workspace"),
      });
    }
  });
  it("a request's start that never answered keeps its source; one that answered replaces it", () => {
    const source = ran("source", 1);
    const failed = ran("failed", 2, { launchCorrelationId: byRequest("source") });
    const history = [
      { attempt: failed, reachable: false },
      { attempt: source, reachable: false },
    ];
    expect(previewResumeCandidate(dormant)).toBe(web);
    expect(previewGatewayResolution(PREVIEW_CONTROL_INITIAL, dormant, history)).toEqual({
      _tag: "Dormant",
      revision: 0,
      source: { serviceId: web.id, sourceAttemptId: source.id },
      workspaceId: SealantWorkspaceId.make("workspace"),
    });
    const answered = ran("answered", 3, { launchCorrelationId: byRequest("source") });
    expect(
      previewGatewayResolution(PREVIEW_CONTROL_INITIAL, dormant, [
        ...history,
        { attempt: answered, reachable: true },
      ]),
    ).toMatchObject({ source: { sourceAttemptId: answered.id } });
  });
  it("a dormant Service with no attempt to run again has no recorded command", () => {
    const adopted = ran("adopted", 1, { argv: [] });
    const failed = ran("failed", 2, { launchCorrelationId: byRequest("adopted") });
    expect(
      previewGatewayResolution(PREVIEW_CONTROL_INITIAL, dormant, [
        { attempt: adopted, reachable: true },
        { attempt: failed, reachable: false },
      ]),
    ).toEqual({ _tag: "Refused", reason: "no-recorded-command" });
  });
  it("names every other unbound reason as its refusal", () => {
    const tls = selectPreviewTarget(preview, [idle(service("tls", { browserScheme: "https" }))]);
    expect(previewResumeCandidate(tls)).toBeNull();
    expect(previewGatewayResolution(PREVIEW_CONTROL_INITIAL, tls, [])).toEqual({
      _tag: "Refused",
      reason: "https-unsupported",
    });
    expect(
      previewGatewayResolution(PREVIEW_CONTROL_INITIAL, selectPreviewTarget(preview, []), []),
    ).toEqual({
      _tag: "Refused",
      reason: "service-missing",
    });
  });
});

describe("offering Open for a preview", () => {
  const dormant: PreviewGatewayResolution = {
    _tag: "Dormant",
    revision: 0,
    source: {
      serviceId: ServiceId.make("before"),
      sourceAttemptId: SessionProcessId.make("before"),
    },
    workspaceId: null,
  };

  it("does not offer a stopped explicit run, even though its command was recorded", () => {
    expect(previewOffersOpen(dormant, { declarationSource: "explicit-run" }, false)).toBe(false);
    expect(previewOffersOpen(dormant, null, false)).toBe(false);
  });

  it("keeps Open while setup prepares a preview without a live attempt yet", () => {
    expect(
      previewOffersOpen({ _tag: "Refused", reason: "no-recorded-command" }, null, false, true),
    ).toBe(true);
  });

  it("offers recipe wake and preserves the wake of an idle-stopped explicit run", () => {
    expect(previewOffersOpen(dormant, { declarationSource: "recipe-file" }, false)).toBe(true);
    expect(previewOffersOpen(dormant, { declarationSource: "recipe-project" }, false)).toBe(true);
    expect(previewOffersOpen(dormant, { declarationSource: "explicit-run" }, true)).toBe(true);
  });

  it("offers a starting run, but never a person's Stop or a refused preview", () => {
    expect(
      previewOffersOpen(
        { _tag: "Starting", revision: 0, attemptId: null, workspaceId: null },
        null,
        false,
      ),
    ).toBe(true);
    expect(
      previewOffersOpen(
        {
          _tag: "Stopped",
          control: { _tag: "Stopped", revision: 1, by: "maria", byName: "Maria", at, seq: 1 },
        },
        { declarationSource: "recipe-file" },
        true,
      ),
    ).toBe(false);
    expect(previewOffersOpen({ _tag: "Refused", reason: "no-recorded-command" }, null, false)).toBe(
      false,
    );
    expect(previewOffersOpen(null, null, false)).toBe(false);
  });
});
