import { AccessPolicyId, ProjectSecretId } from "@mend/domain";
import {
  type AccessPolicyRules,
  STANDARD_ACCESS_POLICY_RULES,
  STANDARD_PROJECT_ACCESS_POLICY,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  accessPolicyAdmissionRefusal,
  launchAccessPolicyOf,
  launchNeedsNetworkPolicy,
  networkPolicyFor,
  policyMirrorsOf,
  providerHostsFor,
} from "../src/access-policy.ts";

const source = { policyId: AccessPolicyId.make("ap_deploy"), name: "Deploy", revision: 4 };
const rules = (over: Partial<AccessPolicyRules>): AccessPolicyRules => ({
  ...STANDARD_ACCESS_POLICY_RULES,
  ...over,
});
const vercel = {
  secretId: ProjectSecretId.make("sec_1"),
  name: "VERCEL_TOKEN",
  placeholder: "mend_sec_abcdefghijklmnopqrstuvwx",
  binding: { headerName: "Authorization", bindHosts: ["api.vercel.com"] },
};

describe("a launch's network policy", () => {
  it("is none under Standard, as before Access policies", () => {
    const standard = launchAccessPolicyOf(STANDARD_PROJECT_ACCESS_POLICY, []);
    expect(standard.fingerprintHash).toBeNull();
    expect(launchNeedsNetworkPolicy(standard, 0)).toBe(false);
    expect(launchNeedsNetworkPolicy(standard, 1)).toBe(true);
    const revoked = launchAccessPolicyOf(STANDARD_PROJECT_ACCESS_POLICY, [
      { policyId: null, kind: "host", target: "evil.example.com" },
    ]);
    expect(launchNeedsNetworkPolicy(revoked, 0)).toBe(true);
  });

  it("lists pinned, auto-allowed and bind hosts under Restricted, never a revoked one", () => {
    const policy = launchAccessPolicyOf(
      {
        rules: rules({
          mode: "restricted",
          allowBrokeredSecrets: true,
          allowHosts: [{ host: "github.com" }, { host: "registry.npmjs.org" }],
        }),
        source,
      },
      [{ policyId: AccessPolicyId.make("ap_deploy"), kind: "host", target: "registry.npmjs.org" }],
    );
    const network = networkPolicyFor({
      policy,
      autoHosts: providerHostsFor("claude"),
      mirrors: policyMirrorsOf({
        npm: "http://npm-mirror:4873/",
        docker: "http://docker-mirror:5000",
      }),
      brokered: [vercel],
    });
    expect(network.mode).toBe("restricted");
    expect(network.sourcePolicyId).toBe("ap_deploy");
    expect(network.sourcePolicyRevision).toBe(4);
    const hosts = network.allowHosts?.map((entry) => entry.host);
    expect(hosts).toContain("github.com");
    expect(hosts).toContain("api.anthropic.com");
    expect(hosts).not.toContain("registry.npmjs.org");
    expect(network.allowHosts?.find((entry) => entry.host === "api.vercel.com")?.inspectTls).toBe(
      true,
    );
    expect(network.allowMirrors).toEqual([
      { name: "npm", host: "npm-mirror", port: 4873 },
      { name: "docker", host: "docker-mirror", port: 5000 },
    ]);
  });

  it("adds no provider hosts under Standard, where every public host is reachable", () => {
    const network = networkPolicyFor({
      policy: launchAccessPolicyOf({ rules: rules({ allowBrokeredSecrets: true }), source }, []),
      autoHosts: providerHostsFor("codex"),
      mirrors: [],
      brokered: [vercel],
    });
    expect(network.mode).toBe("standard");
    expect(network.allowHosts?.map((entry) => entry.host)).toEqual(["api.vercel.com"]);
    expect(network.allowMirrors).toBeUndefined();
  });
});

const refusal = (over: Partial<Parameters<typeof accessPolicyAdmissionRefusal>[0]>) =>
  accessPolicyAdmissionRefusal({
    rules: STANDARD_ACCESS_POLICY_RULES,
    runtime: "docker",
    dockerInside: false,
    brokeredCount: 0,
    brokeredNames: [],
    ...over,
  });
describe("admission under an Access policy", () => {
  it("admits Standard anywhere", () => {
    expect(refusal({})).toBeNull();
    expect(refusal({ runtime: "boat", dockerInside: true })).toBeNull();
  });

  it("refuses, never downgrades, what the runtime cannot hold to", () => {
    expect(refusal({ rules: rules({ requireVmIsolation: true }) })).toContain("VM of its own");
    expect(refusal({ rules: rules({ requireVmIsolation: true }), runtime: null })).toContain(
      "VM of its own",
    );
    expect(refusal({ rules: rules({ requireVmIsolation: true }), runtime: "host-vm" })).toBeNull();
    expect(refusal({ rules: rules({ mode: "restricted" }), dockerInside: true })).toContain(
      "restricts egress",
    );
    expect(
      refusal({ rules: rules({ mode: "restricted" }), dockerInside: true, runtime: "host-vm" }),
    ).toBeNull();
    const brokered = { brokeredCount: 1, brokeredNames: ["VERCEL_TOKEN"] };
    expect(refusal(brokered)).toContain("VERCEL_TOKEN is Brokered");
    expect(
      refusal({ ...brokered, rules: rules({ allowBrokeredSecrets: true }), runtime: "boat" }),
    ).toContain("egress proxy of its own");
    expect(refusal({ ...brokered, rules: rules({ allowBrokeredSecrets: true }) })).toBeNull();
  });
});
