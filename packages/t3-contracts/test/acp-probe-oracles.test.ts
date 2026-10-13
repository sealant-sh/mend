import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { describe, expect, it } from "vitest";

import { AcpRegistryOperationError, AcpRegistryProbeResult } from "../src/acpRegistry.ts";

const authMethod = { id: "oauth", name: "Browser login", description: null, type: "agent" };
const model = { id: "default", name: "Default", description: "Agent-selected model" };
// Every negative changes one field of this complete, independently decoded valid probe.
const validProbe = {
  instanceId: "acpRegistry_example",
  ready: true,
  icon: null,
  authMethods: [authMethod],
  models: [model],
  currentModelId: "default",
  configOptions: [],
  sessionManagement: {
    canList: false,
    canLoad: false,
    canResume: false,
    canLogout: false,
    canDelete: false,
    canConfigureProviders: false,
  },
};
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const issuesOf = (schema: Schema.ConstraintDecoder<unknown>, input: unknown) => {
  const parsed = Schema.decodeUnknownResult(schema)(input, { errors: "all" });
  if (Result.isSuccess(parsed))
    throw new Error("Expected the named contract constraint to reject this input");
  return formatIssues(parsed.failure.issue).issues;
};

const invalidProbes = [
  {
    name: "authMethods count above 32",
    field: { authMethods: Array.from({ length: 33 }, () => authMethod) },
    issue: { path: ["authMethods"], message: "Expected a value with a length of at most 32" },
  },
  {
    name: "unsupported auth method type",
    field: { authMethods: [{ ...authMethod, type: "passive" }] },
    issue: {
      path: ["authMethods", 0, "type"],
      message: 'Expected "agent" | "env_var" | "terminal"',
    },
  },
  {
    name: "models count above 256",
    field: { models: Array.from({ length: 257 }, () => model) },
    issue: { path: ["models"], message: "Expected a value with a length of at most 256" },
  },
];

describe("local ACP probe constraint oracles", () => {
  it("decodes the complete baseline without relying on missing-field errors", () => {
    expect(Schema.decodeUnknownSync(AcpRegistryProbeResult)(validProbe)).toEqual(validProbe);
  });

  it.each(invalidProbes)("rejects only $name at its intended issue path", ({ field, issue }) => {
    expect(Schema.decodeUnknownSync(AcpRegistryProbeResult)(validProbe)).toEqual(validProbe);
    expect(issuesOf(AcpRegistryProbeResult, { ...validProbe, ...field })).toEqual([issue]);
  });

  it("accepts exactly 32 auth methods and 256 models", () => {
    const boundary = {
      ...validProbe,
      authMethods: Array.from({ length: 32 }, () => authMethod),
      models: Array.from({ length: 256 }, () => model),
    };
    expect(Schema.decodeUnknownSync(AcpRegistryProbeResult)(boundary)).toEqual(boundary);
  });

  it.each(["agent", "env_var", "terminal"])("accepts the supported auth method type %s", (type) => {
    const probe = { ...validProbe, authMethods: [{ ...authMethod, type }] };
    expect(Schema.decodeUnknownSync(AcpRegistryProbeResult)(probe)).toEqual(probe);
  });

  it("reports missing configOptions separately from the three probe constraints", () => {
    const { configOptions: _configOptions, ...missingConfig } = validProbe;
    expect(issuesOf(AcpRegistryProbeResult, missingConfig)).toEqual([
      { path: ["configOptions"], message: "Missing key" },
    ]);
  });

  it("checks the authentication error envelope independently from successful probe metadata", () => {
    const error = {
      _tag: "AcpRegistryOperationError",
      reason: "authentication_failed",
      message: "Authentication required.",
      authMethods: Array.from({ length: 32 }, () => authMethod),
    };
    expect(Schema.decodeUnknownSync(AcpRegistryOperationError)(error)).toMatchObject(error);
    expect(
      issuesOf(AcpRegistryOperationError, {
        ...error,
        authMethods: Array.from({ length: 33 }, () => authMethod),
      }),
    ).toEqual([{ path: ["authMethods"], message: "Expected a value with a length of at most 32" }]);
  });
});
