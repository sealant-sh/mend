import { it } from "@effect/vitest";
import { BOAT_SUPPORT, DOCKER_SUPPORT } from "@mend/domain/runtime-support-fixtures";
import type { WorkspaceRuntimes as SdkWorkspaceRuntimes } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { SealantClients, toWorkspaceRuntimes } from "./client.ts";
import { SealantPlatformError } from "./errors.ts";
import { WorkspaceRuntimesReport, WorkspaceRuntimesReportLive } from "./workspace-runtimes.ts";

/** sealant's wire answer, as the SDK hands it over: plain objects, not Mend's classes. */
const sdkReport: SdkWorkspaceRuntimes = JSON.parse(
  JSON.stringify({ default: "docker", runtimes: [DOCKER_SUPPORT, BOAT_SUPPORT] }),
);

const reportOver = (answers: Array<"answer" | "fail">) => {
  const asked = { count: 0 };
  const layer = WorkspaceRuntimesReportLive.pipe(
    Layer.provide(
      Layer.mock(SealantClients, {
        connectedAccounts: () => {
          throw new Error("not read by the report");
        },
        sshKeys: () => {
          throw new Error("not read by the report");
        },
        workspaceRuntimes: () =>
          Effect.suspend(() => {
            const answer = answers[asked.count] ?? "answer";
            asked.count += 1;
            return answer === "answer"
              ? Effect.succeed(toWorkspaceRuntimes(sdkReport))
              : Effect.fail(
                  new SealantPlatformError({
                    code: "unreachable",
                    status: 0,
                    cause: null,
                    message: "connect ECONNREFUSED",
                  }),
                );
          }),
      }),
    ),
  );
  return { asked, layer };
};

describe("WorkspaceRuntimesReport", () => {
  it("maps sealant's answer to Mend's own type, field for field", () => {
    const mapped = toWorkspaceRuntimes(sdkReport);
    expect(mapped.default).toBe("docker");
    expect(mapped.runtimes).toEqual([DOCKER_SUPPORT, BOAT_SUPPORT]);
  });

  it.effect("keeps an answer a minute, then asks sealant again", () => {
    const { asked, layer } = reportOver(["answer", "answer"]);
    return Effect.gen(function* () {
      const report = yield* WorkspaceRuntimesReport;
      const first = yield* report.read();
      expect(first.state).toBe("observed");
      yield* TestClock.adjust("59 seconds");
      yield* report.read();
      expect(asked.count).toBe(1);
      yield* TestClock.adjust("2 seconds");
      yield* report.read();
      expect(asked.count).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reads as unread with the reason when sealant does not answer, and asks again soon",
    () => {
      const { asked, layer } = reportOver(["fail", "answer"]);
      return Effect.gen(function* () {
        const report = yield* WorkspaceRuntimesReport;
        // sealant's own text can name internal hosts; the reading says only what any member may read.
        expect(yield* report.read()).toEqual({
          state: "unread",
          reason: "Sealant could not be reached",
        });
        yield* TestClock.adjust("10 seconds");
        expect((yield* report.read()).state).toBe("unread");
        yield* TestClock.adjust("6 seconds");
        expect((yield* report.read()).state).toBe("observed");
        expect(asked.count).toBe(2);
      }).pipe(Effect.provide(layer));
    },
  );
});
