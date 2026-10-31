import { makeScreensMemory } from "@mend/db";
import { SealantWorkspaceId, SessionProcessId } from "@mend/domain";
import { SessionProcess } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, type HarnessUser } from "../../test/support/tenancy-harness.ts";

const sessionId = ids("shared-a").session;
const route = `/api/sessions/${sessionId}/screen/wake`;

describe("wake a session's screen", () => {
  it.each([
    { user: "alice", shared: false, status: 200 },
    { user: "carol", shared: true, status: 200 },
    { user: "carol", shared: false, status: 403 },
    { user: "bob", shared: true, status: 404 },
  ] satisfies ReadonlyArray<{ user: HarnessUser; shared: boolean; status: number }>)(
    "$user, shared control $shared: $status",
    async ({ user, shared, status }) => {
      const woken: string[] = [];
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: {
              launchUnderWay: () => false,
              wakeScreen: (id) =>
                Effect.sync(() => {
                  woken.push(id);
                }),
            },
          },
        },
      );
      try {
        if (shared) {
          expect(
            (
              await api.request("alice", "PUT", `/api/sessions/${sessionId}/shared-control`, {
                enabled: true,
              })
            ).status,
          ).toBe(200);
        }
        const response = await api.request(user, "POST", route);
        expect(response.status).toBe(status);
        expect(woken).toEqual(status === 200 ? [sessionId] : []);
        expect(api.world.calls).not.toContain("engine.sendMessage");
        expect(api.world.calls).not.toContain("engine.submitTurn");
      } finally {
        await api.dispose();
      }
    },
  );

  it("keeps a released screen in the Desktop tab's read, then reads its new start", async () => {
    const screens = makeScreensMemory();
    const screen = await Effect.runPromise(
      screens.reserve({ sessionId, workspaceId: SealantWorkspaceId.make("workspace-stopped") }),
    );
    await Effect.runPromise(
      screens.setLife(screen.id, { life: { _tag: "Ended", reason: "idle" } }),
    );
    await Effect.runPromise(screens.release(screen.id));
    const api = await createTenancyApi(
      {},
      {
        processes: [
          new SessionProcess({
            id: SessionProcessId.make("screen-woken"),
            sessionId,
            sealantWorkspaceId: SealantWorkspaceId.make("workspace-woken"),
            sealantSessionId: "pty-screen-woken",
            sealantRunId: null,
            launchCorrelationId: null,
            serviceId: null,
            attemptOrdinal: null,
            kind: "screen",
            harness: null,
            providerSessionId: null,
            protocolOptions: null,
            label: "screen",
            argv: ["mend-screen"],
            status: "stopped",
            exitCode: 0,
            workspacePort: null,
            protocol: "tcp",
            hostPort: null,
            createdAt: new Date("2026-10-31T13:31:51Z"),
            exitedAt: new Date("2026-10-31T13:31:52Z"),
            updatedAt: new Date("2026-10-31T13:31:52Z"),
          }),
        ],
        implement: {
          screensRepo: screens,
          engine: {
            launchUnderWay: () => false,
            wakeScreen: (id) =>
              screens
                .reserve({ sessionId: id, workspaceId: SealantWorkspaceId.make("workspace-woken") })
                .pipe(
                  Effect.flatMap((next) =>
                    screens
                      .setLife(next.id, {
                        life: { _tag: "Starting" },
                        processId: SessionProcessId.make("screen-woken"),
                      })
                      .pipe(Effect.orDie),
                  ),
                  Effect.asVoid,
                ),
          },
        },
      },
    );
    try {
      for (const user of ["alice", "carol"] satisfies ReadonlyArray<HarnessUser>) {
        const stopped = await api.request(user, "GET", `/api/sessions/${sessionId}/screen`);
        expect(stopped.status).toBe(200);
        expect(await stopped.json()).toMatchObject({
          _tag: "Screen",
          processId: null,
          life: { _tag: "Ended", reason: "idle" },
        });
      }
      expect((await api.request("alice", "POST", route)).status).toBe(200);
      const starting = await api.request("alice", "GET", `/api/sessions/${sessionId}/screen`);
      expect(await starting.json()).toMatchObject({
        _tag: "Screen",
        processId: "screen-woken",
        life: { _tag: "Starting" },
      });
      const current = await Effect.runPromise(screens.ofSession(sessionId));
      if (current === null) throw new Error("no screen after wake");
      await Effect.runPromise(
        screens.setLife(current.id, { life: { _tag: "Ended", reason: "idle" } }),
      );
      const ended = await api.request("alice", "GET", `/api/sessions/${sessionId}/screen`);
      expect(await ended.json()).toMatchObject({
        processId: "screen-woken",
        life: { _tag: "Ended", reason: "idle" },
      });
    } finally {
      await api.dispose();
    }
  });

  it("conceals missing and private sessions and requires authentication", async () => {
    const api = await createTenancyApi();
    try {
      expect((await api.request(null, "POST", route)).status).toBe(401);
      expect((await api.request("alice", "POST", "/api/sessions/unknown/screen/wake")).status).toBe(
        404,
      );
      expect(
        (
          await api.request(
            "alice",
            "POST",
            `/api/sessions/${ids("private-carol").session}/screen/wake`,
          )
        ).status,
      ).toBe(404);
      expect(api.world.calls).not.toContain("engine.wakeScreen");
    } finally {
      await api.dispose();
    }
  });
});
