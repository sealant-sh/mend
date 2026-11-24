import {
  brokeredHeaderNameProblem,
  networkPolicyProblems,
  policyHostProblem,
} from "@sealant/api-contracts/network-policy";
import { Schema } from "effect";

import { AccessPolicyId, OrganizationId, ProjectSecretId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * Access policies (agent-home `docs/workspace-isolation-architecture.md` §7–§8, ADR 0025's
 * 2026-11-24 amendment). An organization holds templates of rules under Organization → Access
 * policies; a project holds its own copy of one; a worktree pins the rules it started with. Rules
 * only: a policy never holds a secret value, which stays in Project → Variables and secrets.
 */

/** `standard`: the public internet less private, metadata and host addresses. `restricted`: only what the policy lists. */
export const AccessPolicyMode = Schema.Literals(["standard", "restricted"]);
export type AccessPolicyMode = typeof AccessPolicyMode.Type;

/**
 * How far Mend's Git signer goes for a worktree: `disabled` signs nothing, `read-only` signs
 * fetches and archives, `read-write` signs those and pushes to the project's own repository.
 */
export const GitTransport = Schema.Literals(["disabled", "read-only", "read-write"]);
export type GitTransport = typeof GitTransport.Type;

/** One host a policy allows, as sealant's network policy names it. */
export const AccessPolicyHost = Schema.Struct({
  /** An exact host name or IP literal, lowercase. Never a wildcard. */
  host: Schema.String,
  /** Allowed ports; absent means 443. */
  ports: Schema.optional(Schema.Array(Schema.Int)),
  /** Terminate and inspect TLS to this host (always so for a brokered secret's bind host). */
  inspectTls: Schema.optional(Schema.Boolean),
  /** Allowed HTTP methods, uppercase; inspected hosts only. */
  methods: Schema.optional(Schema.Array(Schema.String)),
  /** Allowed path prefixes, each starting with `/`; inspected hosts only. */
  pathPrefixes: Schema.optional(Schema.Array(Schema.String)),
});
export type AccessPolicyHost = typeof AccessPolicyHost.Type;

/** The rules of one Access policy. */
export const AccessPolicyRules = Schema.Struct({
  mode: AccessPolicyMode,
  /** Hosts beyond what the mode already allows: under `restricted`, the only ones reachable. */
  allowHosts: Schema.Array(AccessPolicyHost),
  gitTransport: GitTransport,
  /** Whether the session's agents may call the organization's Executor tools (ADR 0022). */
  allowExecutorTools: Schema.Boolean,
  /** Whether the project's Brokered secrets reach its workspaces (through their egress proxy). */
  allowBrokeredSecrets: Schema.Boolean,
  /** The workspace must run in a VM of its own; a container runtime refuses the launch. */
  requireVmIsolation: Schema.Boolean,
  /**
   * Private addresses and blocks (`10.0.4.0/24`, `100.101.102.103`) the workspace may reach,
   * each inside the server's ceiling, `MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS`.
   */
  allowedPrivateEgress: Schema.Array(Schema.String),
});
export type AccessPolicyRules = typeof AccessPolicyRules.Type;

/** The built-in policy's id: Standard is no stored row, and every organization has it. */
export const STANDARD_ACCESS_POLICY_ID = AccessPolicyId.make("standard");
export const STANDARD_ACCESS_POLICY_NAME = "Standard";
/** Standard never changes, so its one revision is 1. */
export const STANDARD_ACCESS_POLICY_REVISION = 1;

/** `Standard`: what every project and worktree has until an owner assigns another policy. */
export const STANDARD_ACCESS_POLICY_RULES: AccessPolicyRules = {
  mode: "standard",
  allowHosts: [],
  gitTransport: "read-write",
  allowExecutorTools: true,
  allowBrokeredSecrets: false,
  requireVmIsolation: false,
  allowedPrivateEgress: [],
};

/**
 * Whether a policy is elevated: it lets Brokered project secrets reach the workspace, or opens
 * private destinations beyond Standard's public internet. Assigning one to a project takes an
 * Organization Owner and writes an Audit log entry.
 */
export const isElevatedAccessPolicy = (rules: AccessPolicyRules): boolean =>
  rules.allowBrokeredSecrets || rules.allowedPrivateEgress.length > 0;

/** An organization's Access policy template: Standard, or one an owner made. */
export class AccessPolicy extends Schema.Class<AccessPolicy>("AccessPolicy")({
  id: AccessPolicyId,
  organizationId: OrganizationId,
  name: Schema.String,
  /** Standard: built in, never edited or removed. */
  builtIn: Schema.Boolean,
  /** Bumped by every edit of the rules; projects record which one they copied. */
  revision: Schema.Int,
  rules: AccessPolicyRules,
  elevated: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** Where a copied policy came from: the template and revision, so a revocation reaches it. */
export const AccessPolicySource = Schema.Struct({
  policyId: AccessPolicyId,
  /** The template's name when it was copied. */
  name: Schema.String,
  revision: Schema.Int,
});
export type AccessPolicySource = typeof AccessPolicySource.Type;

/** A project's own policy: a copy of a template, never a live link to it. */
export const ProjectAccessPolicy = Schema.Struct({
  rules: AccessPolicyRules,
  source: AccessPolicySource,
});
export type ProjectAccessPolicy = typeof ProjectAccessPolicy.Type;

/** The policy a project has until an owner assigns another: a copy of Standard. */
export const STANDARD_PROJECT_ACCESS_POLICY: ProjectAccessPolicy = {
  rules: STANDARD_ACCESS_POLICY_RULES,
  source: {
    policyId: STANDARD_ACCESS_POLICY_ID,
    name: STANDARD_ACCESS_POLICY_NAME,
    revision: STANDARD_ACCESS_POLICY_REVISION,
  },
};

/**
 * The rules a worktree pinned when it was created, with their canonical hash. Every session in
 * the worktree shares them. Editing the project's policy or the template never changes a pin;
 * "Apply updated policy" re-pins it, and a revocation always applies on top.
 */
export const WorktreeAccessPolicyPin = Schema.Struct({
  rules: AccessPolicyRules,
  source: AccessPolicySource,
  /** `accessPolicyHash` of `rules`. */
  policyHash: Schema.String,
  pinnedAt: Timestamp,
});
export type WorktreeAccessPolicyPin = typeof WorktreeAccessPolicyPin.Type;

/** What an organization-level revocation takes away. */
export const AccessRevocationKind = Schema.Literals(["host", "secret", "all"]);
export type AccessRevocationKind = typeof AccessRevocationKind.Type;

/**
 * A durable revocation: stored before anything else happens, it wins over every pin, every
 * re-pin and every policy applied later. `policyId` scopes it to worktrees whose policy came from
 * that template; null reaches every worktree in the organization.
 */
export class AccessRevocation extends Schema.Class<AccessRevocation>("AccessRevocation")({
  id: Schema.String,
  organizationId: OrganizationId,
  policyId: Schema.NullOr(AccessPolicyId),
  kind: AccessRevocationKind,
  /** The host (`host`) or project secret id (`secret`); null for `all`. */
  target: Schema.NullOr(Schema.String),
  revokedByUserId: Schema.String,
  revokedAt: Timestamp,
}) {}

/** Whether `revocation` reaches a worktree whose policy came from `source`. */
export const revocationReaches = (
  revocation: Pick<AccessRevocation, "policyId">,
  source: AccessPolicySource,
): boolean => revocation.policyId === null || revocation.policyId === source.policyId;

/** A host as a revocation compares it: lowercase, no trailing dot. */
export const canonicalPolicyHost = (host: string): string =>
  host.trim().toLowerCase().replace(/\.$/, "");

/**
 * The rules a worktree may use now: its pin less every revocation that reaches it. A host
 * revocation drops that host; `all` drops every host, every private destination and the
 * brokered secrets. (A secret revocation drops one secret, which `revokedSecretIds` answers.)
 */
export const effectiveAccessPolicyRules = (
  pin: Pick<WorktreeAccessPolicyPin, "rules" | "source">,
  revocations: ReadonlyArray<Pick<AccessRevocation, "policyId" | "kind" | "target">>,
): AccessPolicyRules => {
  const reaching = revocations.filter((revocation) => revocationReaches(revocation, pin.source));
  if (reaching.some((revocation) => revocation.kind === "all")) {
    return { ...pin.rules, allowHosts: [], allowBrokeredSecrets: false, allowedPrivateEgress: [] };
  }
  const hosts = new Set(
    reaching
      .filter((revocation) => revocation.kind === "host" && revocation.target !== null)
      .map((revocation) => canonicalPolicyHost(revocation.target ?? "")),
  );
  if (hosts.size === 0) return pin.rules;
  return {
    ...pin.rules,
    allowHosts: pin.rules.allowHosts.filter((entry) => !hosts.has(canonicalPolicyHost(entry.host))),
    allowedPrivateEgress: pin.rules.allowedPrivateEgress.filter(
      (entry) => !hosts.has(canonicalPolicyHost(entry)),
    ),
  };
};

/** The project secrets a worktree's revocations take away, by id. */
export const revokedSecretIds = (
  source: AccessPolicySource,
  revocations: ReadonlyArray<Pick<AccessRevocation, "policyId" | "kind" | "target">>,
): ReadonlySet<string> =>
  new Set(
    revocations
      .filter(
        (revocation) =>
          revocation.kind === "secret" &&
          revocation.target !== null &&
          revocationReaches(revocation, source),
      )
      .map((revocation) => revocation.target ?? ""),
  );

/** Hosts a worktree's revocations take away, canonical. */
export const revokedHosts = (
  source: AccessPolicySource,
  revocations: ReadonlyArray<Pick<AccessRevocation, "policyId" | "kind" | "target">>,
): ReadonlyArray<string> =>
  revocations
    .filter(
      (revocation) =>
        revocation.kind === "host" &&
        revocation.target !== null &&
        revocationReaches(revocation, source),
    )
    .map((revocation) => canonicalPolicyHost(revocation.target ?? ""));

const sortedStrings = (values: ReadonlyArray<string> | undefined): Array<string> | undefined =>
  values === undefined ? undefined : [...new Set(values)].toSorted();

const sortedPorts = (values: ReadonlyArray<number> | undefined): Array<number> | undefined =>
  values === undefined ? undefined : [...new Set(values)].toSorted((a, b) => a - b);

/**
 * The rules in one canonical form: hosts lowercase and sorted, every list sorted and without
 * repeats, absent optional fields left out. Two policies that allow the same things read the
 * same, so their hash is the same.
 */
export const canonicalAccessPolicyRules = (rules: AccessPolicyRules): AccessPolicyRules => ({
  mode: rules.mode,
  allowHosts: rules.allowHosts
    .map((entry) => {
      const ports = sortedPorts(entry.ports);
      const methods = sortedStrings(entry.methods?.map((method) => method.toUpperCase()));
      const pathPrefixes = sortedStrings(entry.pathPrefixes);
      return {
        host: canonicalPolicyHost(entry.host),
        ...(ports === undefined ? {} : { ports }),
        ...(entry.inspectTls === true ? { inspectTls: true } : {}),
        ...(methods === undefined ? {} : { methods }),
        ...(pathPrefixes === undefined ? {} : { pathPrefixes }),
      };
    })
    .toSorted((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)),
  gitTransport: rules.gitTransport,
  allowExecutorTools: rules.allowExecutorTools,
  allowBrokeredSecrets: rules.allowBrokeredSecrets,
  requireVmIsolation: rules.requireVmIsolation,
  allowedPrivateEgress: sortedStrings(rules.allowedPrivateEgress) ?? [],
});

/** The canonical JSON a policy hash is taken over; keys in a fixed order. */
export const canonicalAccessPolicyJson = (rules: AccessPolicyRules): string =>
  JSON.stringify(canonicalAccessPolicyRules(rules));

const GIT_RANK: Readonly<Record<GitTransport, number>> = {
  disabled: 0,
  "read-only": 1,
  "read-write": 2,
};

const DEFAULT_PORTS: ReadonlyArray<number> = [443];

/** Whether `wide` allows every port, method and path `narrow` does on the same host. */
const hostCovers = (wide: AccessPolicyHost, narrow: AccessPolicyHost): boolean => {
  const widePorts = wide.ports ?? DEFAULT_PORTS;
  if (!(narrow.ports ?? DEFAULT_PORTS).every((port) => widePorts.includes(port))) return false;
  if (wide.methods !== undefined) {
    if (narrow.methods === undefined) return false;
    if (!narrow.methods.every((method) => wide.methods?.includes(method.toUpperCase()))) {
      return false;
    }
  }
  if (wide.pathPrefixes !== undefined) {
    if (narrow.pathPrefixes === undefined) return false;
    if (
      !narrow.pathPrefixes.every((prefix) =>
        wide.pathPrefixes?.some((widePrefix) => prefix.startsWith(widePrefix)),
      )
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Whether `candidate` grants anything `base` does not: a wider mode, a host, port, method or
 * path `base` does not list, a wider Git cap, Executor tools, Brokered secrets, a private
 * destination, or dropping a VM requirement. A worktree may pin a policy other than its
 * project's only when it does not widen it.
 */
export const widensAccessPolicy = (
  base: AccessPolicyRules,
  candidate: AccessPolicyRules,
): boolean => {
  if (base.mode === "restricted" && candidate.mode === "standard") return true;
  if (GIT_RANK[candidate.gitTransport] > GIT_RANK[base.gitTransport]) return true;
  if (candidate.allowExecutorTools && !base.allowExecutorTools) return true;
  if (candidate.allowBrokeredSecrets && !base.allowBrokeredSecrets) return true;
  if (base.requireVmIsolation && !candidate.requireVmIsolation) return true;
  const basePrivate = new Set(base.allowedPrivateEgress.map(canonicalPolicyHost));
  if (
    candidate.allowedPrivateEgress.some((entry) => !basePrivate.has(canonicalPolicyHost(entry)))
  ) {
    return true;
  }
  return candidate.allowHosts.some((entry) => {
    const matches = base.allowHosts.filter(
      (baseEntry) => canonicalPolicyHost(baseEntry.host) === canonicalPolicyHost(entry.host),
    );
    // Under Standard every public host is reachable already; a listed one adds inspection only.
    if (matches.length === 0) return base.mode === "restricted";
    return !matches.some((baseEntry) => hostCovers(baseEntry, entry));
  });
};

// ---------------------------------------------------------------------------------------------
// What Restricted egress allows without listing it (§7.1).

/**
 * The hosts each agent's model provider needs, which a Restricted worktree reaches without its
 * policy listing them. A launch adds the session's own agent's; a harness that can use either
 * provider gets Claude's and Codex's.
 */
export const AGENT_PROVIDER_HOSTS: Readonly<{
  readonly claude: ReadonlyArray<string>;
  readonly codex: ReadonlyArray<string>;
  readonly antigravity: ReadonlyArray<string>;
}> = {
  claude: ["api.anthropic.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com"],
  codex: ["chatgpt.com", "api.openai.com", "auth.openai.com"],
  antigravity: [
    "cloudcode-pa.googleapis.com",
    "generativelanguage.googleapis.com",
    "oauth2.googleapis.com",
  ],
};

/** Doppler's API, which a Restricted worktree reaches when the person starting it uses Doppler. */
export const DOPPLER_HOST = "api.doppler.com";

// ---------------------------------------------------------------------------------------------
// Private destinations and the operator's ceiling.

type Cidr = { readonly family: 4 | 6; readonly bits: bigint; readonly prefix: number };

const parseIpv4 = (value: string): bigint | null => {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
};

const groupsOf = (half: string): Array<string> => (half === "" ? [] : half.split(":"));

const parseIpv6 = (value: string): bigint | null => {
  if (value.length === 0 || value.includes(":::")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  const expand = (groups: Array<string>): Array<number> | null => {
    const out: Array<number> = [];
    for (const [index, group] of groups.entries()) {
      if (index === groups.length - 1 && group.includes(".")) {
        const v4 = parseIpv4(group);
        if (v4 === null) return null;
        out.push(Number(v4 >> 16n), Number(v4 & 0xffffn));
      } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
        out.push(Number.parseInt(group, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const headGroups = expand(head);
  const tailGroups = expand(tail);
  if (headGroups === null || tailGroups === null) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...headGroups, ...Array<number>(Math.max(0, missing)).fill(0), ...tailGroups];
  return all.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
};

/** An address or block (`10.0.4.0/24`, `fd00::/8`, `100.101.102.103`), or null when it is none. */
export const parsePrivateEgressEntry = (entry: string): Cidr | null => {
  const [address = "", prefixText, ...rest] = entry.trim().split("/");
  if (rest.length > 0) return null;
  const v4 = parseIpv4(address);
  const family: 4 | 6 | null = v4 !== null ? 4 : parseIpv6(address) !== null ? 6 : null;
  if (family === null) return null;
  const bits = (family === 4 ? v4 : parseIpv6(address)) ?? 0n;
  const width = family === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (prefix > width) return null;
  const hostMask = (1n << BigInt(width - prefix)) - 1n;
  // A block with host bits set reads as a typo, as sealant reads it.
  if ((bits & hostMask) !== 0n) return null;
  return { family, bits, prefix };
};

const contains = (outer: Cidr, inner: Cidr): boolean => {
  if (outer.family !== inner.family || inner.prefix < outer.prefix) return false;
  const width = outer.family === 4 ? 32 : 128;
  const shift = BigInt(width - outer.prefix);
  return outer.bits >> shift === inner.bits >> shift;
};

/** The server's ceiling, `MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS`: comma-separated entries. */
export const parseOperatorPrivateEgressCeiling = (raw: string | undefined): ReadonlyArray<string> =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && parsePrivateEgressEntry(entry) !== null);

/** Whether every entry lies inside one of the operator's ceiling entries. */
export const withinPrivateEgressCeiling = (
  entry: string,
  ceiling: ReadonlyArray<string>,
): boolean => {
  const inner = parsePrivateEgressEntry(entry);
  if (inner === null) return false;
  return ceiling.some((allowed) => {
    const outer = parsePrivateEgressEntry(allowed);
    return outer !== null && contains(outer, inner);
  });
};

/**
 * Every rule a policy breaks, in sentences a page can show; empty when it breaks none. Hosts are
 * checked with sealant's own rules, so a policy Mend stores is one sealant takes.
 */
export const accessPolicyRulesProblems = (
  rules: AccessPolicyRules,
  operatorCeiling: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const problems: Array<string> = networkPolicyProblems({
    mode: rules.mode,
    policyHash: "check",
    allowHosts: rules.allowHosts,
  }).map((problem) => problem.replace(/^networkPolicy\./, ""));
  const hosts = rules.allowHosts.map((entry) => canonicalPolicyHost(entry.host));
  const twice = hosts.find((host, index) => hosts.indexOf(host) !== index);
  if (twice !== undefined) problems.push(`allowHosts: \`${twice}\` is listed twice`);
  for (const entry of rules.allowedPrivateEgress) {
    if (parsePrivateEgressEntry(entry) === null) {
      problems.push(
        `allowedPrivateEgress: \`${entry}\` is not an address or a block (such as 10.0.4.0/24)`,
      );
    } else if (!withinPrivateEgressCeiling(entry, operatorCeiling)) {
      problems.push(
        operatorCeiling.length === 0
          ? `allowedPrivateEgress: this server allows no private destinations (MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS is unset), so \`${entry}\` cannot be opened`
          : `allowedPrivateEgress: \`${entry}\` is outside what this server allows (${operatorCeiling.join(", ")})`,
      );
    }
  }
  return problems;
};

/** An Access policy name: what a page lists it by. */
export const accessPolicyNameProblem = (name: string): string | null => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "A policy needs a name.";
  if (trimmed.length > 80) return "A policy's name is at most 80 characters.";
  if (trimmed.toLowerCase() === STANDARD_ACCESS_POLICY_NAME.toLowerCase()) {
    return "Standard is the built-in policy's name; give this one another.";
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Brokered project secrets.

/** How a project secret reaches the workspace. */
export const ProjectSecretDelivery = Schema.Literals(["direct", "brokered"]);
export type ProjectSecretDelivery = typeof ProjectSecretDelivery.Type;

/**
 * Where a Brokered secret's real value goes: only into `headerName`, only on HTTPS requests to
 * one of `bindHosts`. The workspace holds `placeholder` in the secret's variable instead.
 */
export const BrokeredSecretBinding = Schema.Struct({
  headerName: Schema.String,
  bindHosts: Schema.Array(Schema.String),
  methods: Schema.optional(Schema.Array(Schema.String)),
  pathPrefixes: Schema.optional(Schema.Array(Schema.String)),
});
export type BrokeredSecretBinding = typeof BrokeredSecretBinding.Type;

/** The placeholder every Brokered secret's variable holds: `mend_sec_` and 24 random characters. */
export const BROKERED_PLACEHOLDER_PATTERN = /^mend_sec_[a-z0-9]{24}$/;

/** Every rule a binding breaks, in sentences; empty when it breaks none. */
export const brokeredSecretBindingProblems = (
  binding: BrokeredSecretBinding,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const header = brokeredHeaderNameProblem(binding.headerName);
  if (header !== undefined) problems.push(header);
  if (binding.bindHosts.length === 0) problems.push("bindHosts must name at least one host");
  for (const host of binding.bindHosts) {
    const problem = policyHostProblem(host, { allowIp: false });
    if (problem !== undefined) problems.push(`bindHosts: ${problem}`);
  }
  for (const method of binding.methods ?? []) {
    if (!/^[A-Z]+$/.test(method))
      problems.push(`methods: \`${method}\` is not an uppercase HTTP method`);
  }
  for (const prefix of binding.pathPrefixes ?? []) {
    if (!prefix.startsWith("/") || prefix.includes("?") || prefix.includes("#")) {
      problems.push(`pathPrefixes: \`${prefix}\` must start with \`/\` and hold no query`);
    }
  }
  return problems;
};

/** A project secret's delivery as the API shows it: never the value. */
export const ProjectSecretDeliveryView = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("direct") }),
  Schema.Struct({
    mode: Schema.Literal("brokered"),
    binding: BrokeredSecretBinding,
    /** What the workspace's variable holds; worthless anywhere but through the egress proxy. */
    placeholder: Schema.String,
  }),
]);
export type ProjectSecretDeliveryView = typeof ProjectSecretDeliveryView.Type;

/** A Brokered secret as a launch hands it to sealant (§8.4), the value resolved separately. */
export interface BrokeredSecretLaunch {
  readonly secretId: ProjectSecretId;
  readonly name: string;
  readonly placeholder: string;
  readonly binding: BrokeredSecretBinding;
}
