import { type BoatFailure, type BoatKeyHolder, boatProblemText } from "@mend/domain/workbench";
import { toPlatformError } from "@mend/sealant";
import { SealantBoatError } from "@sealant/sdk";
import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { launchOnce, lifecycleLayer, ubuntu } from "./engine/capture-fixture.ts";
import { withEngineEffect } from "./engine/fixture.ts";

/**
 * A Boat launch Boat refused ends with the Boat failure table's words for the key that decided
 * (SLNT-793, SLNT-797). The engine hands Boat's failure kind to the table unchanged, so it proves
 * one launch per key holder, each with a different class of failure: a refused key, an account
 * problem with Boat's billing link, and a retryable one with Boat's time. The table's own tests
 * (`boat-failure-words.test.ts`) give every kind its words for every holder, and the SDK's
 * conversion keeps every kind (`boat-failure-conversion.test.ts`).
 */

/** What Core 872's `workspace.ready()` rejects with when Boat refused the launch's VM. */
const boatRefusal = (kind: BoatFailure["kind"], extra: Record<string, unknown> = {}) =>
  new SealantBoatError(
    'Workspace ws-boat reached terminal status "failed" before becoming ready: {"provider":"boat","code":"api_key_expired","requestId":"req_engine1"}',
    {
      kind,
      retryable: kind === "rate-limited" || kind === "no-machine" || kind === "no-answer",
      operation: "create",
      status: 403,
      code: "api_key_planted",
      requestId: "req_engine1",
      ...extra,
    },
    { code: "workspace_not_ready" },
  );

const CASES: ReadonlyArray<{
  readonly holder: BoatKeyHolder;
  readonly kind: BoatFailure["kind"];
  readonly extra?: Record<string, unknown>;
  /** What the words must carry from Boat's answer. */
  readonly carries: ReadonlyArray<string>;
}> = [
  {
    holder: "organization",
    kind: "key-expired",
    carries: ["The organization's Boat key has expired", "Settings, Organization, Boat"],
  },
  {
    holder: "server",
    kind: "billing-required",
    extra: { status: 402, billingUrl: "https://boat.dev/billing" },
    carries: ["this server's Boat key", "https://boat.dev/billing"],
  },
  {
    holder: "person",
    kind: "rate-limited",
    extra: { status: 429, retryAt: "2026-11-13T14:05:00.000Z" },
    carries: ["the session owner's own Boat key", "after 14:05 UTC"],
  },
];

describe("a Boat launch Boat refused, in the table's words for the key that decided", () => {
  for (const { holder, kind, extra, carries } of CASES) {
    it(`ends a launch refused for ${kind} on the ${holder}'s key`, async () => {
      const logs: Array<string> = [];
      const captureLogs = Logger.layer([
        Logger.make(({ message }) => {
          logs.push(Array.isArray(message) ? message.join(" ") : String(message));
        }),
      ]);
      await Effect.runPromise(
        withEngineEffect(
          (world, tmp) =>
            Effect.gen(function* () {
              const { engine, session } = yield* launchOnce(world, tmp);
              const error = yield* engine.launch(session.id, ["codex"]).pipe(Effect.flip);
              if (error._tag !== "SealantPlatformError")
                throw new Error("launch lost its platform failure");
              const failure = error.boat;
              if (failure === undefined) throw new Error("launch lost Boat's reason");
              const words = boatProblemText({ kind, failure }, { holder, place: "launch" });
              expect(error.message).toBe(words);
              for (const part of carries) expect(words).toContain(part);
              const summary = world.sessions.get(session.id)?.summary ?? "";
              expect(summary).toBe(`launch failed · ${words}`);
              const [first] = summary.split("\n");
              expect(first).toMatch(/^launch failed · .*this session's VM did not start\.$/);
              for (const secret of ["api_key_planted", "req_engine1", "terminal status"])
                expect(summary).not.toContain(secret);
            }),
          {
            sessionRuntime: "boat",
            workspaceImage: ubuntu,
            ...(holder === "server"
              ? {}
              : { boatAccounts: new Map([["org-test", "core-boat-acme"]]) }),
            // The session's owner's own key decides over the organization's (SLNT-797).
            ...(holder === "person"
              ? { personBoatAccounts: new Map([["org-test/user-fixture", "core-boat-own"]]) }
              : {}),
            sealantLayer: lifecycleLayer([], {
              captureOps: {
                beforeCreate: () => Effect.fail(toPlatformError(boatRefusal(kind, extra))),
              },
            }),
          },
        ).pipe(Effect.provide(captureLogs)),
      );
      expect(logs.join("\n")).toContain(
        `boat refused · ${kind} · api_key_planted · request req_engine1 · create · ${String(extra?.["status"] ?? 403)}`,
      );
    });
  }
});
