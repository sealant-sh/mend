import { InstanceRolesRepo, OrganizationsRepo } from "@mend/db";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  evaluateGate,
  exposedServiceHosts,
  TenancyConfig,
  TenancyConfigLive,
  tenancyRefusal,
  type TenancyPosture,
} from "./tenancy.ts";

const build = (env: Record<string, string>, organizationCount: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tenancy = yield* TenancyConfig;
      return tenancy;
    }).pipe(
      Effect.provide(
        TenancyConfigLive.pipe(
          Layer.provide(
            Layer.mock(OrganizationsRepo, { count: () => Effect.succeed(organizationCount) }),
          ),
          Layer.provide(
            Layer.mock(InstanceRolesRepo, { operators: () => Effect.succeed(["alice"]) }),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        ),
      ),
      Effect.result,
    ),
  );

const failing = (posture: TenancyPosture) =>
  evaluateGate(posture)
    .filter((outcome) => !outcome.ok)
    .map((outcome) => outcome.id);

/** Everything configuration can satisfy, set the way multi mode needs it. */
const configured: TenancyPosture = {
  serviceHosts: "127.0.0.1",
  sourcePolicy: "tenant",
  transportBoundToOrigin: true,
  captureRequireSizes: true,
  blobStore: "s3://captures",
  sessionStore: "captured",
  operatorCount: 1,
};

describe("MEND_TENANCY (docs/adr/0003)", () => {
  it("defaults to single, and evaluates the gate there too", async () => {
    const result = await build({}, 1);
    const tenancy = Result.isSuccess(result) ? result.success : null;
    expect(tenancy?.mode).toBe("single");
    expect(tenancy?.gate.map((outcome) => outcome.id)).toContain("source-policy");
  });

  it("refuses multi until the gate passes, naming each failing item with its fix", async () => {
    const result = await build({ MEND_TENANCY: "multi" }, 1);
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toContain("MEND_TENANCY=multi is refused");
    expect(String(result)).toContain("source-policy");
    expect(String(result)).toContain("set MEND_SOURCE_POLICY=tenant");
  });

  it("refuses single when several organizations exist", async () => {
    const result = await build({ MEND_TENANCY: "single" }, 2);
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toContain("2 organizations exist");
  });

  it("refuses an unknown mode", async () => {
    const result = await build({ MEND_TENANCY: "shared" }, 1);
    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("the multi mode gate", () => {
  it("names what configuration still lacks", () => {
    expect(failing({})).toEqual(
      expect.arrayContaining(["source-policy", "upload-length-binding", "operator-present"]),
    );
    expect(failing({ ...configured, serviceHosts: "127.0.0.1,0.0.0.0" })).toContain(
      "raw-service-ports",
    );
    expect(failing({ ...configured, transportBoundToOrigin: false })).toContain(
      "transport-bound-to-origin",
    );
    expect(failing({ ...configured, blobStore: "dir:///var/lib/mend/_blobs" })).toContain(
      "upload-length-binding",
    );
    expect(exposedServiceHosts("127.0.0.1, ::1,localhost")).toEqual([]);
  });

  it("passes with everything configured, and single mode never refuses", () => {
    // The two items that waited on the platform are in: sealantd declares every upload's length
    // (sealantd#82) and lays down the plan's sources beside the worktree (sealantd#83).
    expect(failing(configured)).toEqual([]);
    expect(tenancyRefusal("multi", 1, evaluateGate(configured))).toBeNull();
    expect(tenancyRefusal("multi", 1, evaluateGate({}))).toContain("source-policy");
    expect(tenancyRefusal("single", 1, evaluateGate({}))).toBeNull();
  });
});
