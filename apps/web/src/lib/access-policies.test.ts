import { AccessPolicyId } from "@mend/domain";
import { STANDARD_ACCESS_POLICY_RULES } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  automaticHosts,
  bindingOf,
  brokeredBlockedLine,
  ceilingLine,
  deliveryDraftOf,
  deliveryNeedsOwner,
  deliveryOf,
  deliveryProblems,
  deliveryTitle,
  deliveryWords,
  draftElevated,
  draftOf,
  draftProblems,
  enforcementLead,
  enforcementWords,
  hostsOf,
  hostWords,
  policiesIntro,
  policyMarks,
  projectPolicyLine,
  revisionLine,
  revocationScope,
  revocationWhat,
  revokedByLine,
  ruleRows,
  rulesOf,
  runtimeNote,
  runtimeWords,
} from "./access-policies.ts";

const restricted = {
  ...STANDARD_ACCESS_POLICY_RULES,
  mode: "restricted" as const,
  allowHosts: [{ host: "api.vercel.com" }, { host: "registry.example.com", ports: [443, 5000] }],
  gitTransport: "read-only" as const,
  allowBrokeredSecrets: true,
};

describe("a policy's rules, as the pages list them", () => {
  it("names Standard's rules plainly", () => {
    expect(ruleRows(STANDARD_ACCESS_POLICY_RULES).map((row) => [row.label, row.value])).toEqual([
      ["Network", "Standard"],
      ["Allowed hosts", "None listed."],
      ["Private destinations", "None."],
      ["Git", "Fetch and push"],
      ["Executor tools", "Allowed"],
      ["Brokered secrets", "Not allowed"],
      ["VM of its own", "Not required."],
    ]);
  });

  it("lists a Restricted policy's hosts, with ports other than 443, and says the session's needs come too", () => {
    const hosts = ruleRows(restricted).find((row) => row.label === "Allowed hosts");
    expect(hosts?.value).toBe("Only these, besides what each session needs to run:");
    expect(hosts?.list).toEqual(["api.vercel.com", "registry.example.com:443,5000"]);
    expect(ruleRows(restricted).find((row) => row.label === "Git")?.value).toBe("Fetch only");
  });

  it("writes a host's methods and paths beside it", () => {
    expect(hostWords({ host: "api.github.com", methods: ["GET"], pathPrefixes: ["/repos/"] })).toBe(
      "api.github.com (GET, /repos/)",
    );
  });

  it("marks Standard as built in and a policy that brokers as elevated", () => {
    expect(policyMarks({ builtIn: true, elevated: false })).toEqual(["Built in"]);
    expect(policyMarks({ builtIn: false, elevated: true })).toEqual(["Elevated"]);
    expect(policyMarks({ builtIn: false, elevated: false })).toEqual([]);
  });

  it("says Standard can't change, and when another policy last did", () => {
    const updatedAt = new Date("2026-03-02T10:00:00Z");
    expect(revisionLine({ builtIn: true, revision: 1, updatedAt })).toBe(
      "Built into Mend. It can't be edited or removed.",
    );
    expect(revisionLine({ builtIn: false, revision: 3, updatedAt })).toMatch(
      /^Revision 3, changed /,
    );
  });
});

describe("the owner gate, said before anyone acts", () => {
  it("names the owners to everyone else, and tells an owner only owners change these", () => {
    expect(policiesIntro("Northwind", true, [])).toMatch(/Only owners can change these\.$/);
    expect(policiesIntro("Northwind", false, ["Ada", "Grace"])).toMatch(
      /Only an owner can change these: Ada and Grace\.$/,
    );
    expect(policiesIntro("Northwind", false, [])).toMatch(
      /Only an owner of Northwind can change these\.$/,
    );
  });
});

describe("what Restricted egress allows without listing it", () => {
  it("shows each agent's provider hosts, Doppler, and the viewer's own MCP servers", () => {
    const groups = automaticHosts(["mcp.linear.app"]);
    expect(groups.map((group) => group.label)).toEqual([
      "Claude Code",
      "Codex",
      "Antigravity",
      "Doppler",
      "MCP servers",
    ]);
    expect(groups[0]?.hosts).toContain("api.anthropic.com");
    expect(groups[1]?.hosts).toContain("chatgpt.com");
    expect(groups[3]?.hosts).toEqual(["api.doppler.com"]);
    expect(groups[4]?.hosts).toEqual(["mcp.linear.app"]);
  });

  it("says so when the viewer has no MCP servers, or they couldn't be read", () => {
    expect(automaticHosts([]).at(-1)?.when).toMatch(/you have none/);
    expect(automaticHosts(null).at(-1)?.hosts).toEqual([]);
  });
});

describe("the policy editor", () => {
  it("starts a new policy from Standard's rules", () => {
    expect(rulesOf(draftOf(null), [])).toEqual(STANDARD_ACCESS_POLICY_RULES);
  });

  it("round-trips a policy's hosts, ports and destinations through its lines", () => {
    const draft = draftOf({
      name: "Deploys",
      rules: { ...restricted, allowedPrivateEgress: ["10.0.4.0/24"] },
    });
    expect(draft.hosts).toBe("api.vercel.com\nregistry.example.com:443,5000");
    expect(rulesOf(draft, restricted.allowHosts)).toEqual({
      ...restricted,
      allowedPrivateEgress: ["10.0.4.0/24"],
    });
  });

  it("keeps the inspection, methods and paths of a host the editor doesn't show", () => {
    const previous = [{ host: "api.github.com", inspectTls: true, methods: ["GET"] }];
    expect(hostsOf("API.GitHub.com\nnew.example.com:8443", previous)).toEqual([
      { host: "api.github.com", inspectTls: true, methods: ["GET"] },
      { host: "new.example.com", ports: [8443] },
    ]);
  });

  it("refuses a wildcard host, a bad port, a missing name and Standard's name before sending", () => {
    const base = draftOf(null);
    expect(draftProblems({ ...base, name: "" }, [], [])).toContain("A policy needs a name.");
    expect(draftProblems({ ...base, name: "standard" }, [], [])[0]).toMatch(
      /Standard is the built-in/,
    );
    expect(draftProblems({ ...base, name: "X", hosts: "*.example.com" }, [], []).join(" ")).toMatch(
      /allowHosts/,
    );
    expect(draftProblems({ ...base, name: "X", hosts: "a.example.com:http" }, [], [])).toEqual([
      "allowHosts: `a.example.com` has a port that is not a number from 1 to 65535",
    ]);
  });

  it("refuses a private destination outside the server's ceiling, naming the ceiling", () => {
    const draft = { ...draftOf(null), name: "Internal", privateEgress: "10.9.0.0/16" };
    expect(draftProblems(draft, [], [])[0]).toMatch(/this server allows no private destinations/);
    expect(draftProblems(draft, [], ["10.0.0.0/16"])[0]).toMatch(/outside what this server allows/);
    expect(draftProblems({ ...draft, privateEgress: "10.0.4.0/24" }, [], ["10.0.0.0/16"])).toEqual(
      [],
    );
  });

  it("says when the rules make the policy elevated", () => {
    expect(draftElevated(draftOf(null))).toBe(false);
    expect(draftElevated({ ...draftOf(null), allowBrokeredSecrets: true })).toBe(true);
    expect(draftElevated({ ...draftOf(null), privateEgress: "10.0.4.0/24" })).toBe(true);
  });

  it("says what the server lets a policy open", () => {
    expect(ceilingLine([])).toMatch(/MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS/);
    expect(ceilingLine(["10.0.0.0/16", "100.101.0.0/16"])).toMatch(/10\.0\.0\.0\/16, 100\.101/);
  });
});

describe("revocations", () => {
  const people = new Map([["u-ada", "Ada"]]);
  const policies = new Map([[AccessPolicyId.make("p-1"), "Deploys"]]);

  it("says what each takes and which worktrees it reaches", () => {
    expect(revocationWhat({ kind: "host", target: "api.vercel.com" })).toBe("Host api.vercel.com");
    expect(revocationWhat({ kind: "secret", target: "sec-1" })).toBe("Project secret sec-1");
    expect(revocationWhat({ kind: "all", target: null })).toBe("Everything the policy granted");
    expect(revocationScope(null, policies)).toBe("Every worktree");
    expect(revocationScope("p-1", policies)).toBe("Worktrees on Deploys");
    expect(revocationScope("p-gone", policies)).toBe("Worktrees on a policy that was removed");
  });

  it("names who revoked it, or a former member", () => {
    const revokedAt = new Date("2026-11-24T09:00:00Z");
    expect(revokedByLine({ revokedByUserId: "u-ada", revokedAt }, people)).toMatch(
      /^Revoked by Ada on/,
    );
    expect(revokedByLine({ revokedByUserId: "u-x", revokedAt }, people)).toMatch(
      /^Revoked by a former member/,
    );
  });

  it("words each running workspace's answer, a failure with sealant's reason", () => {
    expect(enforcementWords({ enforcement: "enforced", message: null })).toBe("Enforced");
    expect(enforcementWords({ enforcement: "pending", message: null })).toBe("Applying");
    expect(enforcementWords({ enforcement: "next-start", message: "" })).toBe(
      "Takes it at its next start",
    );
    expect(enforcementWords({ enforcement: "failed", message: "proxy unreachable" })).toBe(
      "Failed: proxy unreachable",
    );
    expect(enforcementLead(0, "applied")).toMatch(/^No running workspace needed telling\./);
    expect(enforcementLead(0, "revoked")).toBe(
      "It reached no running workspace. Each workspace it reaches takes it when it next starts.",
    );
    expect(enforcementLead(2, "revoked")).toBe("2 running workspaces answered:");
  });
});

describe("a project's copy", () => {
  const source = { policyId: "p-1", name: "Deploys", revision: 2 };

  it("says Standard is the built-in", () => {
    expect(
      projectPolicyLine({
        policy: { source: { policyId: "standard", name: "Standard", revision: 1 } },
        latestRevision: null,
        sourceRemoved: false,
      }),
    ).toBe("A copy of Standard, the built-in policy.");
  });

  it("says when the template moved on, or was removed", () => {
    expect(
      projectPolicyLine({ policy: { source }, latestRevision: 4, sourceRemoved: false }),
    ).toMatch(/Deploys is at revision 4 now/);
    expect(
      projectPolicyLine({ policy: { source }, latestRevision: null, sourceRemoved: true }),
    ).toMatch(/was removed .* this project keeps its copy/);
    expect(
      projectPolicyLine({ policy: { source }, latestRevision: null, sourceRemoved: false }),
    ).toBe("A copy of Deploys at revision 2, its latest.");
  });
});

describe("where a worktree's workspaces run", () => {
  it("never calls a Docker container isolated", () => {
    expect(runtimeWords("docker")).toBe(
      "A Docker container on this server, sharing the server's Linux kernel",
    );
    expect(runtimeNote("docker")).toMatch(/not kept apart from the server the way a VM is/);
    for (const runtime of ["docker", "host-vm", "boat", null] as const) {
      expect(`${runtimeWords(runtime)} ${runtimeNote(runtime) ?? ""}`).not.toMatch(/isolat/i);
    }
  });

  it("says a host VM is a machine of its own, and Boat is away from the server", () => {
    expect(runtimeWords("host-vm")).toMatch(/virtual machine of its own per workspace/);
    expect(runtimeWords("boat")).toMatch(/Boat virtual machine/);
    expect(runtimeWords(null)).toMatch(/Sealant/);
  });
});

describe("a secret's delivery", () => {
  const brokered = {
    mode: "brokered" as const,
    binding: { headerName: "Authorization", bindHosts: ["api.vercel.com"] },
  };

  it("starts Direct, with Authorization ready for Brokered", () => {
    expect(deliveryDraftOf(null)).toMatchObject({ mode: "direct", headerName: "Authorization" });
    expect(deliveryOf(deliveryDraftOf(null))).toEqual({ mode: "direct" });
  });

  it("sends a Brokered binding with methods uppercase and empty lists left out", () => {
    const draft = {
      mode: "brokered" as const,
      headerName: " X-API-Key ",
      bindHosts: "API.example.com\napi2.example.com",
      methods: "get, post",
      pathPrefixes: "",
    };
    expect(bindingOf(draft)).toEqual({
      headerName: "X-API-Key",
      bindHosts: ["api.example.com", "api2.example.com"],
      methods: ["GET", "POST"],
    });
  });

  it("refuses a wildcard host, a query in a path and a missing host before sending", () => {
    const draft = { ...deliveryDraftOf(brokered) };
    expect(deliveryProblems(draft)).toEqual([]);
    expect(deliveryProblems({ ...draft, bindHosts: "*.vercel.com" }).join(" ")).toMatch(
      /bindHosts/,
    );
    expect(deliveryProblems({ ...draft, bindHosts: "" })).toContain(
      "bindHosts must name at least one host",
    );
    expect(deliveryProblems({ ...draft, pathPrefixes: "/v1?token=x" }).join(" ")).toMatch(
      /hold no query/,
    );
    expect(deliveryProblems({ ...draft, mode: "direct", bindHosts: "*" })).toEqual([]);
  });

  it("takes an Organization Owner to go back to Direct or move where the value goes", () => {
    const same = deliveryDraftOf(brokered);
    expect(deliveryNeedsOwner(brokered, same)).toBe(false);
    expect(deliveryNeedsOwner(brokered, { ...same, mode: "direct" })).toBe(true);
    expect(deliveryNeedsOwner(brokered, { ...same, bindHosts: "evil.example.com" })).toBe(true);
    expect(deliveryNeedsOwner(brokered, { ...same, headerName: "X-API-Key" })).toBe(true);
    expect(deliveryNeedsOwner(brokered, { ...same, headerName: "authorization" })).toBe(false);
    // Making a Direct secret Brokered narrows where its value goes: anyone who manages may.
    expect(deliveryNeedsOwner({ mode: "direct" }, same)).toBe(false);
  });

  it("says a secret's delivery in its row", () => {
    expect(deliveryWords({ mode: "direct" })).toBe("Direct");
    expect(deliveryWords(brokered)).toBe("Brokered to api.vercel.com");
    expect(deliveryTitle(brokered)).toBe(
      "Brokered: the value goes in Authorization, only to api.vercel.com",
    );
  });

  it("warns that sessions won't start when the policy doesn't allow Brokered secrets", () => {
    const standard = {
      rules: { allowBrokeredSecrets: false },
      source: { name: "Standard" },
    };
    expect(brokeredBlockedLine("checkout-api", standard, 1)).toMatch(
      /^checkout-api's Access policy \(Standard\) doesn't let Brokered secrets reach its workspaces, so no session in checkout-api starts/,
    );
    expect(brokeredBlockedLine("checkout-api", standard, 0)).toBeNull();
    expect(
      brokeredBlockedLine(
        "checkout-api",
        { ...standard, rules: { allowBrokeredSecrets: true } },
        2,
      ),
    ).toBeNull();
    expect(brokeredBlockedLine("checkout-api", null, 2)).toBeNull();
  });
});
