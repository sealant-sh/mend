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
import { Preview, type PreviewTarget, resolvePreviewBinding } from "./preview.ts";
import { Service } from "./service.ts";
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
});
const idle = (owner: Service, recordedCommand = false): PreviewTarget => ({
  service: owner,
  liveAttempt: null,
  recordedCommand,
});

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
    });
  });
  it("binds a starting attempt and refuses a live attempt without a command", () => {
    const web = service();
    expect(resolvePreviewBinding(preview, [live(web, { status: "starting" })])).toEqual({
      _tag: "Bound",
      serviceId: web.id,
      attemptId: SessionProcessId.make("attempt-service"),
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
    const bound = { _tag: "Bound", serviceId: first.id, attemptId: older.liveAttempt?.id };
    expect(resolvePreviewBinding(preview, [newer, older])).toEqual(bound);
    expect(resolvePreviewBinding(preview, [older, newer])).toEqual(bound);
    expect(resolvePreviewBinding(preview, [idle(first, true), newer])).toEqual({
      _tag: "Bound",
      serviceId: second.id,
      attemptId: newer.liveAttempt?.id,
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
          const expected = { _tag: "Bound", serviceId: oldest.serviceId, attemptId: oldest.id };
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
