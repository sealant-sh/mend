import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  Service,
  ServiceEndpoint,
  ServiceForward,
  ServiceObservation,
  ServiceRecipe,
  ServiceView,
  SessionProcess,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { WorktreePreviewsDto } from "./api.ts";
import {
  commandOf,
  fileRecipes,
  lastLogLine,
  logLines,
  previewFact,
  readPreviews,
  serviceOpen,
  serviceState,
  shownService,
  workspaceServices,
} from "./workspace-services.ts";

const SESSION = SessionId.make("session-1");
const SIBLING = SessionId.make("session-2");
const ELSEWHERE = SessionId.make("session-9");
const at = new Date("2026-11-18T09:00:00.000Z");
const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000);

const service = (
  name: string,
  options: {
    readonly sessionId?: SessionId;
    readonly scheme?: "http" | "https" | null;
    readonly argv?: ReadonlyArray<string>;
    readonly ended?: { readonly code: number | null; readonly status?: "exited" | "stopped" };
    readonly observed?: "reachable" | "unreachable" | null;
    readonly status?: "starting" | "running";
    readonly scope?: "loopback" | "private";
    readonly updatedAt?: Date;
    readonly port?: number;
  } = {},
): ServiceView => {
  const {
    sessionId = SESSION,
    scheme = "http",
    argv = ["sh", "-c", "pnpm dev"],
    ended,
    observed = "reachable",
    status = "running",
    scope = "loopback",
    updatedAt = at,
    port = 3000,
  } = options;
  const serviceId = ServiceId.make(`service-${name}-${sessionId}`);
  const attemptId = SessionProcessId.make(`process-${name}-${sessionId}`);
  const forwardId = ServiceForwardId.make(`forward-${name}-${sessionId}`);
  const address = scope === "loopback" ? "127.0.0.1" : "10.0.0.40";
  return new ServiceView({
    service: new Service({
      id: serviceId,
      sessionId,
      name,
      declarationSource: "recipe-file",
      workspacePort: port,
      transport: "tcp",
      browserScheme: scheme,
      bindAddresses: [address],
      preferredHostPort: null,
      currentAttemptId: attemptId,
      currentForwardId: forwardId,
      attemptHistoryComplete: true,
      forwardHistoryComplete: true,
      observationHistoryComplete: true,
      createdAt: at,
      updatedAt,
    }),
    attempts: [
      new SessionProcess({
        id: attemptId,
        sessionId,
        sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
        sealantSessionId: argv.length === 0 ? null : "pty-1",
        sealantRunId: null,
        launchCorrelationId: null,
        serviceId,
        attemptOrdinal: 1,
        kind: "service",
        harness: null,
        providerSessionId: null,
        protocolOptions: null,
        label: name,
        argv,
        status: ended === undefined ? status : (ended.status ?? "exited"),
        exitCode: ended === undefined ? null : ended.code,
        workspacePort: port,
        protocol: "tcp",
        hostPort: 41000,
        createdAt: at,
        exitedAt: ended === undefined ? null : updatedAt,
        updatedAt,
      }),
    ],
    currentForward: new ServiceForward({
      id: forwardId,
      serviceId,
      sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
      preferredHostPort: null,
      hostPort: 41000,
      boundAddresses: [address],
      state: ended === undefined ? "bound" : "closed",
      error: null,
      supersedesForwardId: null,
      createdAt: at,
      boundAt: at,
      closedAt: ended === undefined ? null : updatedAt,
      updatedAt,
    }),
    previousForward: null,
    latestObservation:
      observed === null
        ? null
        : new ServiceObservation({
            id: ServiceObservationId.make(`observation-${name}`),
            serviceId,
            forwardId,
            state: observed,
            source: "probe",
            error: null,
            firstObservedAt: at,
            lastObservedAt: at,
          }),
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    endpoints:
      ended === undefined
        ? [
            new ServiceEndpoint({
              address,
              authority: `${address}:41000`,
              hostPort: 41000,
              transport: "tcp",
              scope,
              browserUrl: scheme === null ? null : `${scheme}://${address}:41000/`,
              mendAuthentication: "none",
            }),
          ]
        : [],
    previousEndpoints: [],
  });
};

const recipe = (name: string, source: "file" | "project", shadowedBy: "file" | null = null) =>
  new ServiceRecipe({
    name,
    command: "pnpm dev",
    port: 3000,
    protocol: "tcp",
    browserScheme: "http",
    source,
    shadowedBy,
  });

const both = new Set<string>([SESSION, SIBLING]);

describe("the workspace's services", () => {
  it("lists every session's Services in the worktree, and no other worktree's", () => {
    const listed = workspaceServices(
      [
        service("web"),
        service("api", { sessionId: SIBLING }),
        service("docs", { sessionId: ELSEWHERE }),
      ],
      both,
    );
    expect(listed.map((each) => [each.name, each.sessionId])).toEqual([
      ["web", SESSION],
      ["api", SIBLING],
    ]);
  });

  it("puts live Services first and keeps the latest three that ended, one per name", () => {
    const listed = workspaceServices(
      [
        service("old", { ended: { code: 0 }, updatedAt: later(1) }),
        service("a", { ended: { code: 0 }, updatedAt: later(2) }),
        service("b", { ended: { code: 1 }, updatedAt: later(3) }),
        service("c", { ended: { code: 0 }, updatedAt: later(4) }),
        service("web"),
        // An ended Service named like a live one is left to the live row.
        service("web", { sessionId: SIBLING, ended: { code: 0 }, updatedAt: later(5) }),
      ],
      both,
    );
    expect(listed.map((each) => each.name)).toEqual(["web", "c", "b", "a"]);
  });

  it("says each state as observed", () => {
    expect(serviceState(service("web"))).toEqual({ word: "Running", tone: "run" });
    expect(serviceState(service("web", { observed: null, status: "starting" }))).toEqual({
      word: "Starting",
      tone: "run",
    });
    expect(serviceState(service("web", { observed: "unreachable" })).word).toBe("Not answering");
    expect(serviceState(service("web", { ended: { code: 0 } })).word).toBe("Stopped");
    expect(serviceState(service("web", { ended: { code: 137, status: "stopped" } })).word).toBe(
      "Stopped",
    );
    expect(serviceState(service("web", { ended: { code: 1 } }))).toEqual({
      word: "Exited with code 1",
      tone: "bad",
    });
  });

  it("names what runs, as it was typed, and nothing for an adopted port", () => {
    expect(commandOf(["sh", "-c", "python3 -m http.server 8000"])).toBe(
      "python3 -m http.server 8000",
    );
    expect(commandOf(["pnpm", "dev"])).toBe("pnpm dev");
    expect(commandOf([])).toBeNull();
    const [adopted] = workspaceServices([service("db", { argv: [] })], both);
    expect(adopted?.command).toBeNull();
    expect(adopted?.logProcessId).toBeNull();
  });
});

describe("the recipes the view offers", () => {
  it("offers only the file's recipes that nothing shown runs (decision D8)", () => {
    const shown = workspaceServices([service("web")], both);
    expect(
      fileRecipes(
        [recipe("web", "file"), recipe("worker", "file"), recipe("saved", "project")],
        shown,
      ).map((each) => each.name),
    ).toEqual(["worker"]);
  });
});

describe("the Service the view shows and its tab's port", () => {
  const listed = workspaceServices(
    [
      service("db", { scheme: null, port: 5432 }),
      service("web"),
      service("old", { ended: { code: 0 } }),
    ],
    both,
  );

  it("shows the one picked, else the first web page that runs", () => {
    expect(shownService(listed, null)?.name).toBe("web");
    expect(shownService(listed, "db")?.name).toBe("db");
    expect(shownService(listed, "gone")?.name).toBe("web");
    expect(shownService([], null)).toBeNull();
  });

  it("gives the tab the shown Service's port while it runs", () => {
    expect(previewFact(shownService(listed, null))).toBe(":3000");
    expect(previewFact(shownService(listed, "db"))).toBe(":5432");
    expect(previewFact(shownService(listed, "old"))).toBeUndefined();
  });
});

const previewsOf = (open: string | null): WorktreePreviewsDto => ({
  previews: [
    {
      preview: {
        id: PreviewId.make("pv-web"),
        projectId: ProjectId.make("project-1"),
        worktreeId: WorktreeId.make("worktree-1"),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
        scope: "worktree",
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
      status: [],
      facts: [],
      open,
      boundTo: null,
    },
  ],
  unprepared: null,
  starting: false,
  routing: null,
  frameSite: null,
});

describe("where a Service opens", () => {
  const [web] = workspaceServices([service("web")], both);
  if (web === undefined) throw new Error("no fixture");

  it("opens through Mend's preview link when the worktree has one", () => {
    const read = readPreviews(
      { data: previewsOf("/preview-auth?preview=pv-web&path=%2F"), isError: false },
      SESSION,
      [web],
      [],
    );
    expect(serviceOpen(web, read, false)).toEqual({
      _tag: "Open",
      href: "/preview-auth?preview=pv-web&path=%2F",
    });
  });

  it("opens its own address on Mend's machine, and asks for the tunnel anywhere else", () => {
    const read = readPreviews({ data: previewsOf(null), isError: false }, SESSION, [web], []);
    expect(serviceOpen(web, read, true)).toEqual({ _tag: "Open", href: "http://127.0.0.1:41000/" });
    expect(serviceOpen(web, read, false)).toEqual({ _tag: "Tunnel" });
  });

  it("waits while the previews are read, and says why a page that isn't web has no address", () => {
    const reading = readPreviews({ data: undefined, isError: false }, SESSION, [web], []);
    expect(serviceOpen(web, reading, true)._tag).toBe("Waiting");
    const [db] = workspaceServices([service("db", { scheme: null, scope: "private" })], both);
    if (db === undefined) throw new Error("no fixture");
    const read = readPreviews({ data: previewsOf(null), isError: false }, SESSION, [db], []);
    const open = serviceOpen(db, read, false);
    expect(open._tag === "None" && open.why).toContain('browserScheme = "http"');
  });

  it("no longer vouches for a preview link once a refresh failed", () => {
    const read = readPreviews(
      { data: previewsOf("/preview-auth?preview=pv-web&path=%2F"), isError: true },
      SESSION,
      [web],
      [],
    );
    expect(read._tag).toBe("Unknown");
  });
});

const chunk = (text: string) => ({
  dataBase64: btoa(String.fromCharCode(...new TextEncoder().encode(text))),
});

describe("a Service's log", () => {
  it("joins the chunks, drops colours and keeps a redrawn line as last drawn", () => {
    const lines = logLines([
      chunk("Serving HTTP on 0.0.0.0 port 8000\r\n\u001b[32mGET /\u001b[0m 200\n"),
      chunk("building 10%\rbuilding 100%\n"),
    ]);
    expect(lines).toEqual(["Serving HTTP on 0.0.0.0 port 8000", "GET / 200", "building 100%"]);
    expect(lastLogLine(lines)).toBe("building 100%");
  });

  it("decodes a character split between two chunks", () => {
    const bytes = new TextEncoder().encode("café\n");
    const first = btoa(String.fromCharCode(...bytes.slice(0, 4)));
    const second = btoa(String.fromCharCode(...bytes.slice(4)));
    expect(logLines([{ dataBase64: first }, { dataBase64: second }])).toEqual(["café"]);
  });

  it("has no last line before the Service printed anything", () => {
    expect(lastLogLine(logLines([]))).toBeNull();
  });
});
