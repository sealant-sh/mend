import { describe, expect, it } from "vitest";

import { AccessPolicyId } from "../ids.ts";
import {
  accessPolicyRulesProblems,
  type AccessPolicyRules,
  brokeredSecretBindingProblems,
  canonicalAccessPolicyJson,
  effectiveAccessPolicyRules,
  isElevatedAccessPolicy,
  parseOperatorPrivateEgressCeiling,
  STANDARD_ACCESS_POLICY_RULES,
  STANDARD_PROJECT_ACCESS_POLICY,
  widensAccessPolicy,
  withinPrivateEgressCeiling,
} from "./access-policy.ts";

const rules = (over: Partial<AccessPolicyRules>): AccessPolicyRules => ({
  ...STANDARD_ACCESS_POLICY_RULES,
  ...over,
});

describe("an Access policy's rules", () => {
  it("is elevated when it lets Brokered secrets through or opens a private destination", () => {
    expect(isElevatedAccessPolicy(STANDARD_ACCESS_POLICY_RULES)).toBe(false);
    expect(isElevatedAccessPolicy(rules({ mode: "restricted" }))).toBe(false);
    expect(isElevatedAccessPolicy(rules({ allowBrokeredSecrets: true }))).toBe(true);
    expect(isElevatedAccessPolicy(rules({ allowedPrivateEgress: ["10.0.4.0/24"] }))).toBe(true);
  });

  it("reads the same whatever order its lists come in", () => {
    const one = rules({
      mode: "restricted",
      allowHosts: [{ host: "b.example.com", ports: [443, 22] }, { host: "A.example.com" }],
    });
    const two = rules({
      mode: "restricted",
      allowHosts: [{ host: "a.example.com" }, { host: "b.example.com", ports: [22, 443] }],
    });
    expect(canonicalAccessPolicyJson(one)).toBe(canonicalAccessPolicyJson(two));
  });

  it("widens when it grants anything the base does not", () => {
    const base = rules({
      mode: "restricted",
      gitTransport: "read-only",
      allowExecutorTools: false,
      requireVmIsolation: true,
      allowHosts: [{ host: "api.example.com", ports: [443] }],
    });
    expect(widensAccessPolicy(base, base)).toBe(false);
    expect(widensAccessPolicy(base, { ...base, mode: "standard" })).toBe(true);
    expect(widensAccessPolicy(base, { ...base, gitTransport: "read-write" })).toBe(true);
    expect(widensAccessPolicy(base, { ...base, gitTransport: "disabled" })).toBe(false);
    expect(widensAccessPolicy(base, { ...base, allowExecutorTools: true })).toBe(true);
    expect(widensAccessPolicy(base, { ...base, requireVmIsolation: false })).toBe(true);
    expect(widensAccessPolicy(base, { ...base, allowHosts: [{ host: "other.example.com" }] })).toBe(
      true,
    );
    expect(
      widensAccessPolicy(base, { ...base, allowHosts: [{ host: "api.example.com", ports: [22] }] }),
    ).toBe(true);
    expect(widensAccessPolicy(base, { ...base, allowHosts: [] })).toBe(false);
  });

  it("names every problem, hosts by sealant's rules and private destinations by the ceiling", () => {
    const ceiling = parseOperatorPrivateEgressCeiling("10.0.0.0/16, 100.101.102.103, not-a-cidr");
    expect(ceiling).toEqual(["10.0.0.0/16", "100.101.102.103"]);
    expect(withinPrivateEgressCeiling("10.0.4.0/24", ceiling)).toBe(true);
    expect(withinPrivateEgressCeiling("10.1.0.0/24", ceiling)).toBe(false);
    expect(withinPrivateEgressCeiling("100.101.102.103", ceiling)).toBe(true);
    const problems = accessPolicyRulesProblems(
      rules({
        mode: "restricted",
        allowHosts: [
          { host: "*.example.com" },
          { host: "a.example.com" },
          { host: "a.example.com" },
        ],
        allowedPrivateEgress: ["10.1.0.0/24", "10.0.4.1/24"],
      }),
      ceiling,
    );
    expect(problems.join("\n")).toContain("wildcard");
    expect(problems.join("\n")).toContain("listed twice");
    expect(problems.join("\n")).toContain("outside what this server allows");
    expect(problems.join("\n")).toContain("not an address or a block");
    expect(
      accessPolicyRulesProblems(rules({ allowedPrivateEgress: ["10.0.4.0/24"] }), []).join(),
    ).toContain("MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS is unset");
  });
});

describe("a worktree's rules less its revocations", () => {
  const pin = {
    rules: rules({
      mode: "restricted",
      allowBrokeredSecrets: true,
      allowHosts: [{ host: "api.vercel.com" }, { host: "github.com" }],
    }),
    source: { policyId: AccessPolicyId.make("ap_deploy"), name: "Deploy", revision: 2 },
  };

  it("drops a revoked host, and everything for `all`, only from the policy it names", () => {
    expect(
      effectiveAccessPolicyRules(pin, [{ policyId: null, kind: "host", target: "API.vercel.com." }])
        .allowHosts,
    ).toEqual([{ host: "github.com" }]);
    expect(
      effectiveAccessPolicyRules(pin, [
        { policyId: AccessPolicyId.make("ap_other"), kind: "all", target: null },
      ]),
    ).toEqual(pin.rules);
    const all = effectiveAccessPolicyRules(pin, [
      { policyId: AccessPolicyId.make("ap_deploy"), kind: "all", target: null },
    ]);
    expect(all.allowHosts).toEqual([]);
    expect(all.allowBrokeredSecrets).toBe(false);
    expect(effectiveAccessPolicyRules(STANDARD_PROJECT_ACCESS_POLICY, [])).toEqual(
      STANDARD_ACCESS_POLICY_RULES,
    );
  });
});

describe("a Brokered secret's binding", () => {
  it("takes one header that neither frames nor routes, and exact bind hosts", () => {
    expect(
      brokeredSecretBindingProblems({ headerName: "Authorization", bindHosts: ["api.vercel.com"] }),
    ).toEqual([]);
    expect(
      brokeredSecretBindingProblems({ headerName: "Host", bindHosts: ["*.vercel.com"] }).length,
    ).toBe(2);
    expect(brokeredSecretBindingProblems({ headerName: "X-Api-Key", bindHosts: [] })).toEqual([
      "bindHosts must name at least one host",
    ]);
    expect(
      brokeredSecretBindingProblems({ headerName: "X-Api-Key", bindHosts: ["10.0.0.5"] }).join(),
    ).toContain("IP address");
  });
});
