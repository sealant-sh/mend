import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  ServiceId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import type { PreviewBinding, PreviewView, PreviewGatewayResolution } from "@mend/domain/workbench";
import { Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { type HarnessProject, ids, phoneBearerOf } from "../../test/support/tenancy-harness.ts";
import type { PreviewSetup } from "../preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "../preview-gateway-settings.ts";
import { PreviewPoolFull } from "../preview-identity.ts";
import { type PreviewOrigin, previewOriginOf } from "../preview-routing.ts";

const GATEWAY = { bind: "127.0.0.1", port: 3200, ...PREVIEW_GATEWAY_DEFAULTS };
const DOMAIN = {
  _tag: "On",
  routing: { mode: "domain-https", domain: "previews.example.net", port: 443 },
  gateway: GATEWAY,
} as const satisfies PreviewSetup;
const LOOPBACK: PreviewSetup = {
  _tag: "On",
  routing: { mode: "loopback-http", port: 3200 },
  gateway: GATEWAY,
};
const LABEL = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");
const ORIGIN = previewOriginOf(DOMAIN.routing, { label: LABEL, tailnetPort: null });
if (ORIGIN === null) throw new Error("a domain routing addresses every preview");
const TICKET = "mut_phone-ticket-for-the-preview-open-test";

const viewIn = (project: HarnessProject, binding: PreviewBinding): PreviewView => ({
  preview: {
    id: PreviewId.make(`preview-${project}`),
    projectId: ProjectId.make(ids(project).project),
    worktreeId: WorktreeId.make(ids(project).worktree),
    serviceName: "web",
    label: LABEL,
    state: "kept",
  },
  binding,
});

const BOUND: PreviewBinding = {
  _tag: "Bound",
  serviceId: ServiceId.make(ids("shared-a").service),
  attemptId: SessionProcessId.make(ids("shared-a").process),
  host: "rewrite",
  dial: "session-bound",
};

const opened = async (input: {
  readonly view: PreviewView;
  readonly previews?: PreviewSetup;
  readonly issue?: () => Effect.Effect<
    { readonly origin: PreviewOrigin; readonly ticket: Redacted.Redacted<string> },
    PreviewPoolFull
  >;
  readonly phoneOf?: "alice" | "carol" | "bob";
}) => {
  const openers: Array<unknown> = [];
  const binding = input.view.binding;
  const resolution: PreviewGatewayResolution =
    binding._tag === "Bound"
      ? {
          _tag: "Bound",
          revision: 0,
          attempt: {
            serviceId: binding.serviceId,
            attemptId: binding.attemptId,
            sessionId: SessionId.make(ids("shared-a").session),
            workspaceId: SealantWorkspaceId.make("ws"),
            port: 3000,
            platformSessionId: "pty",
            host: binding.host,
            dial: binding.dial,
          },
        }
      : {
          _tag: "Dormant",
          revision: 0,
          source: {
            serviceId: ServiceId.make(ids("shared-a").service),
            sourceAttemptId: SessionProcessId.make(ids("shared-a").process),
          },
          workspaceId: null,
        };
  const snapshot = { preview: input.view.preview, resolution };
  const api = await createTenancyApi(
    {},
    {
      previews: input.previews ?? DOMAIN,
      implement: {
        previews: {
          resolveById: (id) => Effect.succeed(id === input.view.preview.id ? input.view : null),
          ensureForWorktree: () => Effect.succeed([input.view]),
          gatewaySnapshots: () => Effect.succeed(new Map([[input.view.preview.id, snapshot]])),
          gatewaySnapshot: () => Effect.succeed(snapshot),
          activityOf: () => Effect.succeed(null),
        },
        preparations: { latestForWorktree: () => Effect.succeed(null) },
        observations: { latestForService: () => Effect.succeed(null) },
        previewIdentity: {
          issueTicket: (request) =>
            Effect.suspend(() => {
              openers.push(request.opener);
              return (
                input.issue?.() ?? Effect.succeed({ origin: ORIGIN, ticket: Redacted.make(TICKET) })
              );
            }),
        },
      },
    },
  );
  const authorization = `Bearer ${phoneBearerOf(input.phoneOf ?? "carol")}`;
  try {
    const listed = await api.request(
      null,
      "GET",
      `/api/worktrees/${input.view.preview.worktreeId}/previews`,
      undefined,
      { authorization },
    );
    const read: { previews?: ReadonlyArray<{ open: string | null }>; routing?: string | null } =
      await listed.json();
    const response = await api.request(
      null,
      "POST",
      `/api/previews/${input.view.preview.id}/open`,
      undefined,
      { authorization },
    );
    const body: unknown = await response.json();
    return {
      status: response.status,
      body,
      openers,
      read: { open: read.previews?.[0]?.open ?? null, routing: read.routing ?? null },
    };
  } finally {
    await api.dispose();
  }
};

describe("POST /previews/:id/open", () => {
  it("hands a paired phone the URL that signs it in to the preview, minted with the phone's own credential", async () => {
    const reply = await opened({ view: viewIn("shared-a", BOUND) });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      url: `${ORIGIN}/__mend/auth?ticket=${encodeURIComponent(TICKET)}&path=%2F`,
    });
    expect(reply.openers).toEqual([{ userId: "carol", credential: "device:carol-phone" }]);
  });

  it("offers no Open and mints no ticket for a stopped explicit run", async () => {
    const reply = await opened({
      view: viewIn("shared-a", { _tag: "Unbound", reason: "no-live-attempt" }),
    });
    expect(reply.status).toBe(409);
    expect(reply.read.open).toBeNull();
    expect(reply.openers).toEqual([]);
  });

  it("refuses on loopback routing, which a phone cannot reach, before minting anything", async () => {
    const reply = await opened({ view: viewIn("shared-a", BOUND), previews: LOOPBACK });
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({
      _tag: "PreviewNotOpenable",
      reason: "loopback",
      message: expect.stringContaining(
        "served at *.localhost, which only the Mend machine reaches",
      ),
    });
    expect(reply.openers).toEqual([]);
  });

  it("refuses while previews are off", async () => {
    const reply = await opened({ view: viewIn("shared-a", BOUND), previews: { _tag: "Off" } });
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({
      _tag: "PreviewNotOpenable",
      reason: "previews-off",
      message: "Previews are off on this Mend server.",
    });
    expect(reply.openers).toEqual([]);
  });

  it("refuses what the previews read gives no Open, saying what the gateway found", async () => {
    const reply = await opened({
      view: viewIn("shared-a", { _tag: "Unbound", reason: "service-missing" }),
    });
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({
      _tag: "PreviewNotOpenable",
      reason: "not-served",
      message: "web · no Service of this name in its worktree · nothing to open",
    });
    expect(reply.openers).toEqual([]);
  });

  it("answers a person who cannot see the project as it answers a preview that does not exist", async () => {
    const hidden = await opened({ view: viewIn("private-alice", BOUND) });
    const outsider = await opened({ view: viewIn("shared-a", BOUND), phoneOf: "bob" });
    expect(hidden).toMatchObject({
      status: 404,
      body: { _tag: "NotFound", id: "preview-private-alice" },
      openers: [],
    });
    expect(outsider).toMatchObject({
      status: 404,
      body: { _tag: "NotFound", id: "preview-shared-a" },
      openers: [],
    });
  });

  it("says when every tailnet port is held, and when the next frees", async () => {
    const reply = await opened({
      view: viewIn("shared-a", BOUND),
      issue: () =>
        Effect.fail(new PreviewPoolFull({ size: 4, nextFreeAt: new Date("2026-10-30T14:04:30Z") })),
    });
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({
      _tag: "PreviewsUnavailable",
      message: expect.stringContaining("No preview port is free. All 4 ports"),
    });
  });

  it.each([
    ["bound", DOMAIN, BOUND],
    ["stopped explicit run", DOMAIN, { _tag: "Unbound", reason: "no-live-attempt" }],
    ["previews off", { _tag: "Off" }, BOUND],
    ["no Service of the name", DOMAIN, { _tag: "Unbound", reason: "service-missing" }],
    ["https", DOMAIN, { _tag: "Unbound", reason: "https-unsupported" }],
    ["no browser page", DOMAIN, { _tag: "Unbound", reason: "not-browser-service" }],
    ["no recorded command", DOMAIN, { _tag: "Unbound", reason: "no-recorded-command" }],
  ] satisfies ReadonlyArray<readonly [string, PreviewSetup, PreviewBinding]>)(
    "opens exactly what the previews read offers an Open: %s",
    async (_case, previews, binding) => {
      const reply = await opened({ view: viewIn("shared-a", binding), previews });
      if (reply.read.open === null) {
        expect(reply).toMatchObject({ status: 409, body: { _tag: "PreviewNotOpenable" } });
        expect(reply.openers).toEqual([]);
      } else {
        expect(reply.status).toBe(200);
        expect(reply.openers).toHaveLength(1);
      }
    },
  );

  it("refuses on loopback what the read offers, as the read's routing says", async () => {
    const reply = await opened({ view: viewIn("shared-a", BOUND), previews: LOOPBACK });
    expect(reply.read).toEqual({
      open: "/preview-auth?preview=preview-shared-a&path=%2F",
      routing: "loopback-http",
    });
    expect(reply.body).toMatchObject({ reason: "loopback" });
  });
});
