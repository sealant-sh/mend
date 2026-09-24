import { describe, expect, it } from "vitest";

import type { ServiceViewDto, SessionProcessDto } from "#/lib/api";
import { processFixture } from "#/lib/fixtures";
import { serviceFacts } from "#/lib/services";

const attempt = (patch: Partial<SessionProcessDto> = {}): SessionProcessDto =>
  processFixture({
    id: "attempt-1",
    sessionId: "session-1",
    serviceId: "service-1",
    attemptOrdinal: 1,
    launchCorrelationId: null,
    sealantWorkspaceId: "workspace-1",
    sealantSessionId: "pty-1",
    sealantRunId: "run-1",
    kind: "service",
    harness: null,
    providerSessionId: null,
    label: "web",
    argv: ["pnpm", "dev"],
    status: "running",
    exitCode: null,
    workspacePort: 5173,
    protocol: "tcp",
    hostPort: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    exitedAt: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...patch,
  });

const view = (patch: Partial<ServiceViewDto> = {}): ServiceViewDto => ({
  service: {
    id: "service-1",
    sessionId: "session-1",
    name: "web",
    declarationSource: "recipe-file",
    workspacePort: 5173,
    transport: "tcp",
    browserScheme: "http",
    currentAttemptId: "attempt-1",
    currentForwardId: "forward-1",
    bindAddresses: null,
    preferredHostPort: null,
    attemptHistoryComplete: true,
    forwardHistoryComplete: true,
    observationHistoryComplete: true,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  attempts: [attempt()],
  currentForward: {
    id: "forward-1",
    serviceId: "service-1",
    sealantWorkspaceId: "workspace-1",
    preferredHostPort: null,
    hostPort: 43127,
    boundAddresses: ["127.0.0.1"],
    state: "bound",
    error: null,
    supersedesForwardId: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    boundAt: "2026-08-20T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
  },
  previousForward: null,
  latestObservation: {
    id: "observation-1",
    serviceId: "service-1",
    forwardId: "forward-1",
    state: "reachable",
    source: "probe",
    error: null,
    firstObservedAt: "2026-08-20T00:00:00.000Z",
    lastObservedAt: "2026-08-20T00:00:00.000Z",
  },
  workspaceExpiresAt: "2026-08-20T12:00:00.000Z",
  workspaceTtlRenewedAt: "2026-08-20T00:00:00.000Z",
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  endpoints: [
    {
      address: "127.0.0.1",
      authority: "127.0.0.1:43127",
      hostPort: 43127,
      transport: "tcp",
      scope: "loopback",
      browserUrl: "http://127.0.0.1:43127",
      mendAuthentication: "none",
    },
  ],
  previousEndpoints: [],
  ...patch,
});

describe("desktop Service facts", () => {
  it("offers process actions for supervised Services without merging independent facts", () => {
    const facts = serviceFacts(view());
    expect(facts.actions).toEqual(["open", "copy", "logs", "restart", "stop"]);
    expect(facts.process?.word).toBe("Process running · attempt 1");
    expect(facts.forward.word).toBe("Forward bound to 127.0.0.1:43127");
    expect(facts.target?.word).toBe("TCP accepted on :5173");
    expect(facts.attention).toBeNull();
  });

  it("gives an adopted raw Service only Copy and Remove forward", () => {
    const facts = serviceFacts(
      view({
        service: {
          ...view().service,
          declarationSource: "explicit-adopt",
          browserScheme: null,
          currentAttemptId: null,
        },
        attempts: [],
        latestObservation: null,
        endpoints: [{ ...view().endpoints[0]!, browserUrl: null }],
      }),
    );
    expect(facts.actions).toEqual(["copy", "remove-forward"]);
    expect(facts.process).toBeNull();
    expect(facts.target).toBeNull();
  });

  it("reports endpoint movement and renewal failure as attention without verdict words", () => {
    const facts = serviceFacts(
      view({
        workspaceTtlRenewalFailedAt: "2026-08-20T01:00:00.000Z",
        workspaceTtlRenewalError: "platform unavailable",
        previousEndpoints: [
          { ...view().endpoints[0]!, authority: "127.0.0.1:42000", hostPort: 42000 },
        ],
      }),
    );
    expect(facts.movedFrom).toBe("127.0.0.1:42000");
    expect(facts.attention?.word).toBe("Workspace TTL renewal failed");
    const words = [
      facts.process?.word,
      facts.forward.word,
      facts.target?.word,
      facts.attention?.word,
    ]
      .filter((word) => word !== undefined)
      .join(" ");
    expect(words).not.toMatch(/healthy|ready|authenticated|working|safe/i);
  });

  it("does not claim UDP reachability before a reply observation exists", () => {
    const original = view();
    const facts = serviceFacts(
      view({
        service: { ...original.service, transport: "udp", browserScheme: null },
        attempts: [attempt({ protocol: "udp" })],
        latestObservation: null,
        endpoints: [{ ...original.endpoints[0]!, transport: "udp", browserUrl: null }],
      }),
    );
    expect(facts.target).toBeNull();
    expect(facts.actions).not.toContain("open");
  });
  it("gives a loopback-only Service the CLI's tunnel command when the server is elsewhere", () => {
    const facts = serviceFacts(view(), false);
    expect(facts.reach).toEqual({ kind: "tunnel" });
    expect(facts.browserUrl).toBeNull();
    expect(facts.actions).toEqual(["copy-command", "logs", "restart", "stop"]);
    expect(facts.connectCommand).toBe("mend service connect web");
    // A private-interface endpoint answers a remote desktop on that network: Open stays.
    const reachable = serviceFacts(
      view({
        endpoints: [
          ...view().endpoints,
          {
            ...view().endpoints[0]!,
            address: "100.64.0.7",
            authority: "100.64.0.7:43127",
            scope: "private",
            browserUrl: "http://100.64.0.7:43127/",
          },
        ],
      }),
      false,
    );
    expect(reachable.browserUrl).toBe("http://100.64.0.7:43127/");
    expect(reachable.actions).toEqual(["open", "copy", "logs", "restart", "stop"]);
  });
});
