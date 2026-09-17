import { OrganizationsRepo } from "@mend/db";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  exposedServiceHosts,
  TenancyConfig,
  TenancyConfigLive,
  tenancyRefusal,
} from "./tenancy.ts";

const build = (env: Record<string, string>, organizationCount: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const tenancy = yield* TenancyConfig;
      return tenancy.mode;
    }).pipe(
      Effect.provide(
        TenancyConfigLive.pipe(
          Layer.provide(
            Layer.mock(OrganizationsRepo, { count: () => Effect.succeed(organizationCount) }),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        ),
      ),
      Effect.result,
    ),
  );

describe("MEND_TENANCY (docs/adr/0003)", () => {
  it("defaults to single", async () => {
    const result = await build({}, 1);
    expect(Result.isSuccess(result) ? result.success : null).toBe("single");
  });

  it("refuses multi until the gate is complete, naming what is missing", async () => {
    const result = await build({ MEND_TENANCY: "multi" }, 1);
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toContain("MEND_TENANCY=multi is refused");
    expect(tenancyRefusal("multi", 1)).toContain("pinned against DNS rebinding");
    expect(tenancyRefusal("multi", 1)).toContain("set MEND_SOURCE_POLICY=tenant");
    expect(tenancyRefusal("multi", 1, { sourcePolicy: "tenant" })).not.toContain(
      "MEND_SOURCE_POLICY",
    );
    expect(tenancyRefusal("multi", 1, { transportBoundToOrigin: false })).toContain(
      "unset MEND_GIT_TRANSPORT_BIND_ORIGIN",
    );
    expect(tenancyRefusal("multi", 1)).toContain("set MEND_CAPTURE_REQUIRE_SIZES=true");
    expect(
      tenancyRefusal("multi", 1, { captureRequireSizes: true, blobStore: "s3://captures" }),
    ).not.toMatch(/MEND_CAPTURE_REQUIRE_SIZES|MEND_BLOB_STORE/);
    expect(tenancyRefusal("multi", 1)).not.toContain("raw service listeners");
  });

  it("refuses single when several organizations exist", async () => {
    const result = await build({ MEND_TENANCY: "single" }, 2);
    expect(Result.isFailure(result)).toBe(true);
    expect(String(result)).toContain("2 organizations exist");
  });

  it("names raw service listeners off loopback among what multi is missing", () => {
    expect(exposedServiceHosts("127.0.0.1, ::1,localhost")).toEqual([]);
    expect(exposedServiceHosts("127.0.0.1,0.0.0.0")).toEqual(["0.0.0.0"]);
    expect(tenancyRefusal("multi", 1, { serviceHosts: "0.0.0.0" })).toContain(
      "raw service listeners on 0.0.0.0 (unset MEND_SERVICE_HOSTS)",
    );
  });

  it("refuses an unknown mode", async () => {
    const result = await build({ MEND_TENANCY: "shared" }, 1);
    expect(Result.isFailure(result)).toBe(true);
  });
});
