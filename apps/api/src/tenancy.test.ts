import { InstanceRolesRepo, OrganizationsRepo } from "@mend/db";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  evaluateGate,
  exposedServiceHosts,
  peopleCreateOrganizations,
  TenancyConfig,
  TenancyConfigLive,
  tenancyRefusal,
  type TenancyPosture,
} from "./tenancy.ts";

/** How many times the operator accounts were counted. */
const reads = { count: 0 };

const build = (
  env: Record<string, string>,
  organizationCount: number,
  operators: () => ReadonlyArray<string> = () => ["alice"],
) =>
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
            Layer.mock(InstanceRolesRepo, {
              operatorCount: () =>
                Effect.sync(() => {
                  reads.count += 1;
                  return operators().length;
                }),
            }),
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
    const gate = tenancy === null ? [] : await Effect.runPromise(tenancy.gate);
    expect(gate.map((outcome) => outcome.id)).toContain("source-policy");
  });

  it("reads the operator accounts on each read, so the first account counts once it registers", async () => {
    let operators: ReadonlyArray<string> = [];
    const result = await build({}, 1, () => operators);
    const tenancy = Result.isSuccess(result) ? result.success : null;
    const operatorPresent = async () =>
      tenancy === null
        ? undefined
        : (await Effect.runPromise(tenancy.gate)).find(
            (outcome) => outcome.id === "operator-present",
          );
    expect(await operatorPresent()).toMatchObject({ ok: false, detail: "0 operator account(s)" });
    operators = ["first-account"];
    const before = reads.count;
    expect(await operatorPresent()).toMatchObject({ ok: true, detail: "1 operator account(s)" });
    // One read is one count of the operator accounts, never their list.
    expect(reads.count - before).toBe(1);
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

describe("MEND_ORGANIZATION_CREATION", () => {
  it("lets anyone create one unless the operator keeps it, and refuses an unknown value", async () => {
    const creation = async (env: Record<string, string>) => {
      const result = await build(env, 1);
      return Result.isSuccess(result) ? result.success.organizationCreation : "refused";
    };
    expect(await creation({})).toBe("anyone");
    expect(await creation({ MEND_ORGANIZATION_CREATION: "operator" })).toBe("operator");
    expect(await creation({ MEND_ORGANIZATION_CREATION: "members" })).toBe("refused");
  });

  it("offers a person creation only in multi, while anyone may, and never through an access key", () => {
    const person = { accessKey: false };
    expect(
      peopleCreateOrganizations({ mode: "multi", organizationCreation: "anyone" }, person),
    ).toBe(true);
    expect(
      peopleCreateOrganizations({ mode: "single", organizationCreation: "anyone" }, person),
    ).toBe(false);
    expect(
      peopleCreateOrganizations({ mode: "multi", organizationCreation: "operator" }, person),
    ).toBe(false);
    expect(
      peopleCreateOrganizations(
        { mode: "multi", organizationCreation: "anyone" },
        { accessKey: true },
      ),
    ).toBe(false);
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

  it.each<[string, Partial<TenancyPosture>, Record<string, unknown>]>([
    ["cross-organization-authorization", {}, { reason: "built-in", ok: true }],
    ["per-account-resources", {}, { reason: "built-in", ok: true }],
    ["folders-reach-workspaces", {}, { reason: "captured", ok: true }],
    ["folders-reach-workspaces", { sessionStore: "colocated" }, { reason: "colocated", ok: true }],
    ["source-policy", {}, { reason: "tenant", ok: true }],
    ["source-policy", { sourcePolicy: "operator" }, { reason: "operator", ok: false }],
    ["source-address-pinning", {}, { reason: "tenant", ok: true }],
    ["source-address-pinning", { sourcePolicy: "operator" }, { reason: "operator", ok: false }],
    ["transport-bound-to-origin", {}, { reason: "bound", ok: true }],
    [
      "transport-bound-to-origin",
      { transportBoundToOrigin: false },
      { reason: "unbound", ok: false },
    ],
    ["upload-length-binding", {}, { reason: "enforced", ok: true }],
    ["upload-length-binding", { captureRequireSizes: false }, { reason: "no-sizes", ok: false }],
    [
      "upload-length-binding",
      { blobStore: "dir:///var/lib/mend/_blobs" },
      { reason: "directory-store", ok: false },
    ],
    ["daemon-declares-sizes", {}, { reason: "built-in", ok: true }],
    ["raw-service-ports", {}, { reason: "loopback", ok: true }],
    [
      "raw-service-ports",
      { serviceHosts: "127.0.0.1,0.0.0.0,10.0.0.5" },
      { reason: "exposed", addresses: ["0.0.0.0", "10.0.0.5"], ok: false },
    ],
    ["operator-present", {}, { reason: "operators", count: 1, ok: true }],
    ["operator-present", { operatorCount: 0 }, { reason: "operators", count: 0, ok: false }],
  ])("names %s's case and its data: %j", (id, change, expected) => {
    expect(
      evaluateGate({ ...configured, ...change }).find((outcome) => outcome.id === id),
    ).toMatchObject({
      id,
      ...expected,
    });
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
