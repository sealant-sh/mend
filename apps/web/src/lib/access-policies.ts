/**
 * Access policies (ADR 0025's 2026-11-24 amendment; agent-home
 * `docs/workspace-isolation-architecture.md` §7–§8): what Organization → Access policies, a
 * project's Workspace page, its Variables and secrets and a worktree's Details say about a policy,
 * and the drafts their dialogs edit. Pure, so every sentence is tested without a server.
 *
 * A policy holds rules only. A project holds its own copy of one; a worktree pins the rules it
 * started with. A Docker container shares the server's kernel, so nothing here calls it isolated.
 */

import type { SessionRuntime } from "@mend/domain";
import {
  type AccessPolicyHost,
  type AccessPolicyMode,
  type AccessPolicyRules,
  accessPolicyNameProblem,
  accessPolicyRulesProblems,
  AGENT_PROVIDER_HOSTS,
  type BrokeredSecretBinding,
  brokeredSecretBindingProblems,
  DOPPLER_HOST,
  type GitTransport,
  isElevatedAccessPolicy,
  STANDARD_ACCESS_POLICY_ID,
} from "@mend/domain/workbench";

import { namesList } from "./organization-general.ts";
import { dayOf } from "./organization.ts";

/** The two network modes, as the pages name them. */
export const MODE_NAMES: Readonly<Record<AccessPolicyMode, string>> = {
  standard: "Standard",
  restricted: "Restricted egress",
};

/** What each mode lets a workspace reach, in a sentence. */
export const MODE_LINES: Readonly<Record<AccessPolicyMode, string>> = {
  standard:
    "The public internet. Private networks, cloud metadata and this server's own addresses stay blocked.",
  restricted:
    "Only the hosts the policy lists, plus what each session needs to run. Everything else is blocked.",
};

/** How far Mend's Git signer goes, as the pages say it. */
export const GIT_TRANSPORT_NAMES: Readonly<Record<GitTransport, string>> = {
  disabled: "Off",
  "read-only": "Fetch only",
  "read-write": "Fetch and push",
};

export const GIT_TRANSPORT_LINES: Readonly<Record<GitTransport, string>> = {
  disabled: "Mend signs no Git request from the workspace.",
  "read-only": "Mend signs fetches, never a push.",
  "read-write": "Mend signs fetches, and pushes to the project's own repository.",
};

export const GIT_TRANSPORT_ORDER: ReadonlyArray<GitTransport> = [
  "read-write",
  "read-only",
  "disabled",
];

/** A host as a policy lists it: `api.example.com`, with its ports when they aren't just 443. */
export const hostWords = (entry: AccessPolicyHost): string => {
  const ports = entry.ports ?? [];
  const portText =
    ports.length === 0 || (ports.length === 1 && ports[0] === 443) ? "" : `:${ports.join(",")}`;
  const extras = [
    ...(entry.methods === undefined ? [] : [entry.methods.join(" ")]),
    ...(entry.pathPrefixes === undefined ? [] : [entry.pathPrefixes.join(" ")]),
  ];
  return `${entry.host}${portText}${extras.length === 0 ? "" : ` (${extras.join(", ")})`}`;
};

/** One rule as a label and its value: words, or a list of machine values in mono. */
export interface RuleRow {
  readonly label: string;
  readonly value: string;
  /** Machine values (hosts, addresses) under the value, each in mono. */
  readonly list: ReadonlyArray<string>;
}

/** Every rule of a policy, in the order the pages list them. */
export const ruleRows = (rules: AccessPolicyRules): ReadonlyArray<RuleRow> => [
  { label: "Network", value: MODE_NAMES[rules.mode], list: [] },
  {
    label: "Allowed hosts",
    value:
      rules.allowHosts.length === 0
        ? rules.mode === "restricted"
          ? "None listed: only what each session needs to run."
          : "None listed."
        : rules.mode === "restricted"
          ? "Only these, besides what each session needs to run:"
          : "Listed for inspection; every public host is reachable anyway:",
    list: rules.allowHosts.map(hostWords),
  },
  {
    label: "Private destinations",
    value: rules.allowedPrivateEgress.length === 0 ? "None." : "These, which the server allows:",
    list: rules.allowedPrivateEgress,
  },
  { label: "Git", value: GIT_TRANSPORT_NAMES[rules.gitTransport], list: [] },
  {
    label: "Executor tools",
    value: rules.allowExecutorTools ? "Allowed" : "Not allowed",
    list: [],
  },
  {
    label: "Brokered secrets",
    value: rules.allowBrokeredSecrets ? "Allowed" : "Not allowed",
    list: [],
  },
  {
    label: "VM of its own",
    value: rules.requireVmIsolation
      ? "Required: a container runtime refuses the launch."
      : "Not required.",
    list: [],
  },
];

/** The muted words after a policy's name: Built in, Elevated. */
export const policyMarks = (policy: {
  readonly builtIn: boolean;
  readonly elevated: boolean;
}): ReadonlyArray<string> => [
  ...(policy.builtIn ? ["Built in"] : []),
  ...(policy.elevated ? ["Elevated"] : []),
];

/** What makes a policy elevated, said under it. */
export const ELEVATED_LINE =
  "Elevated: it lets Brokered secrets reach workspaces or opens private destinations. Only an owner can assign it to a project.";

/** A template's revision, and when it last changed. */
export const revisionLine = (policy: {
  readonly builtIn: boolean;
  readonly revision: number;
  readonly updatedAt: Date;
}): string =>
  policy.builtIn
    ? "Built into Mend. It can't be edited or removed."
    : `Revision ${policy.revision}, changed ${dayOf(policy.updatedAt)}.`;

// --- Restricted egress's automatic hosts ---------------------------------------------------------

/** One group of hosts Restricted egress allows without the policy listing them. */
export interface AutomaticHosts {
  readonly label: string;
  readonly when: string;
  readonly hosts: ReadonlyArray<string>;
}

/**
 * What a Restricted worktree reaches without listing it (§7.1): the session's agent's model
 * provider, Doppler when the person starting it uses Doppler, and the hosts of that person's MCP
 * servers. `mcpHosts` is the viewer's own, when the page could read them.
 */
export const automaticHosts = (
  mcpHosts: ReadonlyArray<string> | null,
): ReadonlyArray<AutomaticHosts> => [
  {
    label: "Claude Code",
    when: "when the session runs Claude",
    hosts: AGENT_PROVIDER_HOSTS.claude,
  },
  { label: "Codex", when: "when the session runs Codex", hosts: AGENT_PROVIDER_HOSTS.codex },
  {
    label: "Antigravity",
    when: "when the session runs Antigravity",
    hosts: AGENT_PROVIDER_HOSTS.antigravity,
  },
  {
    label: "Doppler",
    when: "when the person starting the session uses Doppler",
    hosts: [DOPPLER_HOST],
  },
  {
    label: "MCP servers",
    when:
      mcpHosts === null
        ? "the hosts of the MCP servers of the person starting the session"
        : mcpHosts.length === 0
          ? "the hosts of the MCP servers of the person starting the session (you have none)"
          : "the hosts of the MCP servers of the person starting the session; yours are",
    hosts: mcpHosts ?? [],
  },
];

// --- The policy editor -------------------------------------------------------------------------

/** What the editor holds: the rules as fields, hosts and destinations as one per line. */
export interface PolicyDraft {
  readonly name: string;
  readonly mode: AccessPolicyMode;
  readonly hosts: string;
  readonly privateEgress: string;
  readonly gitTransport: GitTransport;
  readonly allowExecutorTools: boolean;
  readonly allowBrokeredSecrets: boolean;
  readonly requireVmIsolation: boolean;
}

const lines = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A host as one line of the editor: `host`, or `host:port,port` when it isn't just 443. */
const hostLine = (entry: AccessPolicyHost): string => {
  const ports = entry.ports ?? [];
  return ports.length === 0 || (ports.length === 1 && ports[0] === 443)
    ? entry.host
    : `${entry.host}:${ports.join(",")}`;
};

/** A new policy starts from Standard's rules, with no name. */
export const draftOf = (
  policy: { readonly name: string; readonly rules: AccessPolicyRules } | null,
): PolicyDraft => {
  const rules = policy?.rules;
  return {
    name: policy?.name ?? "",
    mode: rules?.mode ?? "standard",
    hosts: (rules?.allowHosts ?? []).map(hostLine).join("\n"),
    privateEgress: (rules?.allowedPrivateEgress ?? []).join("\n"),
    gitTransport: rules?.gitTransport ?? "read-write",
    allowExecutorTools: rules?.allowExecutorTools ?? true,
    allowBrokeredSecrets: rules?.allowBrokeredSecrets ?? false,
    requireVmIsolation: rules?.requireVmIsolation ?? false,
  };
};

/**
 * The hosts the editor's lines name. A line is `host` or `host:port,port`; a host the policy
 * listed before keeps the inspection, methods and paths it had, which the editor doesn't show.
 * A port that isn't a number is kept as written, so the server's check names the line.
 */
export const hostsOf = (
  text: string,
  previous: ReadonlyArray<AccessPolicyHost>,
): ReadonlyArray<AccessPolicyHost> =>
  lines(text).map((line) => {
    const colon = line.lastIndexOf(":");
    const host = (colon === -1 ? line : line.slice(0, colon)).trim().toLowerCase();
    const portText = colon === -1 ? "" : line.slice(colon + 1);
    const ports = portText
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map(Number);
    const before = previous.find((entry) => entry.host.toLowerCase() === host);
    return {
      ...(before === undefined
        ? {}
        : {
            ...(before.inspectTls === undefined ? {} : { inspectTls: before.inspectTls }),
            ...(before.methods === undefined ? {} : { methods: before.methods }),
            ...(before.pathPrefixes === undefined ? {} : { pathPrefixes: before.pathPrefixes }),
          }),
      host,
      ...(ports.length === 0 ? {} : { ports }),
    };
  });

/** The rules a draft says, for the server. */
export const rulesOf = (
  draft: PolicyDraft,
  previous: ReadonlyArray<AccessPolicyHost>,
): AccessPolicyRules => ({
  mode: draft.mode,
  allowHosts: [...hostsOf(draft.hosts, previous)],
  gitTransport: draft.gitTransport,
  allowExecutorTools: draft.allowExecutorTools,
  allowBrokeredSecrets: draft.allowBrokeredSecrets,
  requireVmIsolation: draft.requireVmIsolation,
  allowedPrivateEgress: [...lines(draft.privateEgress)],
});

/**
 * Every problem with a draft, checked by the same rules the server applies, so a bad host never
 * goes out. A port that is not a whole number from 1 to 65535 is named here.
 */
export const draftProblems = (
  draft: PolicyDraft,
  previous: ReadonlyArray<AccessPolicyHost>,
  ceiling: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const rules = rulesOf(draft, previous);
  const name = accessPolicyNameProblem(draft.name);
  const ports = rules.allowHosts.flatMap((entry) =>
    (entry.ports ?? [])
      .filter((port) => !Number.isInteger(port) || port < 1 || port > 65535)
      .map(() => `allowHosts: \`${entry.host}\` has a port that is not a number from 1 to 65535`),
  );
  if (ports.length > 0) return [...(name === null ? [] : [name]), ...ports];
  return [...(name === null ? [] : [name]), ...accessPolicyRulesProblems(rules, ceiling)];
};

/** Whether the draft's rules would make the policy elevated. */
export const draftElevated = (draft: PolicyDraft): boolean =>
  isElevatedAccessPolicy(rulesOf(draft, []));

/** The sentence under Private destinations: what this server lets a policy open. */
export const ceilingLine = (ceiling: ReadonlyArray<string>): string =>
  ceiling.length === 0
    ? "This server allows no private destinations, so no policy here can open one. An operator sets MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS to allow some."
    : `An operator lets policies here open addresses inside ${ceiling.join(", ")}, and nothing else private.`;

// --- Who can change it --------------------------------------------------------------------------

/** The intro under the page's title, for an owner or for anyone else, naming the owners. */
export const policiesIntro = (
  organization: string,
  owner: boolean,
  owners: ReadonlyArray<string>,
): string => {
  const lead = `What workspaces in ${organization} may reach, and what Mend may do for them. Each project keeps its own copy of one policy, and each worktree keeps the rules it started with.`;
  if (owner) return `${lead} Only owners can change these.`;
  return owners.length === 0
    ? `${lead} Only an owner of ${organization} can change these.`
    : `${lead} Only an owner can change these: ${namesList(owners)}.`;
};

// --- Revocations --------------------------------------------------------------------------------

/** What a revocation takes away, as one line. */
export const revocationWhat = (revocation: {
  readonly kind: "host" | "secret" | "all";
  readonly target: string | null;
}): string => {
  switch (revocation.kind) {
    case "host":
      return `Host ${revocation.target ?? ""}`;
    case "secret":
      return `Project secret ${revocation.target ?? ""}`;
    case "all":
      return "Everything the policy granted";
  }
};

/** Which worktrees a revocation reaches: every one, or those whose policy came from a template. */
export const revocationScope = (
  policyId: string | null,
  policyNames: ReadonlyMap<string, string>,
): string =>
  policyId === null
    ? "Every worktree"
    : `Worktrees on ${policyNames.get(policyId) ?? "a policy that was removed"}`;

/** Who revoked it, and when. */
export const revokedByLine = (
  revocation: { readonly revokedByUserId: string; readonly revokedAt: Date },
  people: ReadonlyMap<string, string>,
): string =>
  `Revoked by ${people.get(revocation.revokedByUserId) ?? "a former member"} on ${dayOf(revocation.revokedAt)}`;

/** What the revoke dialog says before anything is stored. */
export const REVOKE_WARNING =
  "A revocation lasts. Mend stores it first, then tells every running workspace it reaches. It wins over every worktree's pinned policy at once, and over any policy applied later.";

/** A running workspace's answer to a revocation or an applied policy. */
export const enforcementWords = (view: {
  readonly enforcement: "enforced" | "pending" | "next-start" | "failed";
  readonly message: string | null;
}): string => {
  const words = {
    enforced: "Enforced",
    pending: "Applying",
    "next-start": "Takes it at its next start",
    failed: "Failed",
  }[view.enforcement];
  return view.message === null || view.message === "" ? words : `${words}: ${view.message}`;
};

/** The line over a list of workspace answers, or the sentence when no workspace was running. */
export const enforcementLead = (count: number): string =>
  count === 0
    ? "No running workspace needed telling. Mend holds to its own rules (Git, Executor tools) at once, and each workspace takes the rest when it next starts."
    : count === 1
      ? "The running workspace answered:"
      : `${count} running workspaces answered:`;

// --- A project's copy ---------------------------------------------------------------------------

/** Where a project's copy came from, in a sentence. */
export const projectPolicyLine = (view: {
  readonly policy: {
    readonly source: {
      readonly policyId: string;
      readonly name: string;
      readonly revision: number;
    };
  };
  readonly latestRevision: number | null;
  readonly sourceRemoved: boolean;
}): string => {
  const { source } = view.policy;
  if (source.policyId === STANDARD_ACCESS_POLICY_ID)
    return "A copy of Standard, the built-in policy.";
  if (view.sourceRemoved)
    return `A copy of ${source.name} at revision ${source.revision}. ${source.name} was removed from the organization's Access policies since; this project keeps its copy.`;
  if (view.latestRevision !== null)
    return `A copy of ${source.name} at revision ${source.revision}. ${source.name} is at revision ${view.latestRevision} now; this project keeps its copy until someone updates it.`;
  return `A copy of ${source.name} at revision ${source.revision}, its latest.`;
};

/** What assigning or updating a project's policy does, said before it is done. */
export const ASSIGN_LINE =
  "Mend copies the policy's rules into the project. New worktrees start with the copy. Worktrees that exist keep the rules they started with until someone applies the update on each, so nothing running gets wider access by itself.";

// --- A worktree ---------------------------------------------------------------------------------

/** Where a worktree's workspaces run, said plainly. Docker shares the server's kernel. */
export const runtimeWords = (runtime: SessionRuntime | null): string => {
  switch (runtime) {
    case "host-vm":
      return "A virtual machine of its own per workspace, on this server's KVM";
    case "docker":
      return "A Docker container on this server, sharing the server's Linux kernel";
    case "boat":
      return "A Boat virtual machine, away from this server";
    case null:
      return "Where Sealant on this server put it when the worktree was made";
  }
};

/** The line under the runtime about what the workspace is kept from. */
export const runtimeNote = (runtime: SessionRuntime | null): string | null => {
  switch (runtime) {
    case "docker":
      return "Containers share the server's kernel, so a workspace is not kept apart from the server the way a VM is.";
    case "host-vm":
      return "Each workspace has its own Linux kernel and disks.";
    default:
      return null;
  }
};

// --- Brokered secrets ---------------------------------------------------------------------------

/** What a secret's delivery editor holds. */
export interface DeliveryDraft {
  readonly mode: "direct" | "brokered";
  readonly headerName: string;
  readonly bindHosts: string;
  readonly methods: string;
  readonly pathPrefixes: string;
}

const words = (text: string): ReadonlyArray<string> =>
  text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");

export const deliveryDraftOf = (
  delivery:
    | { readonly mode: "direct" }
    | { readonly mode: "brokered"; readonly binding: BrokeredSecretBinding }
    | null,
): DeliveryDraft =>
  delivery === null || delivery.mode === "direct"
    ? { mode: "direct", headerName: "Authorization", bindHosts: "", methods: "", pathPrefixes: "" }
    : {
        mode: "brokered",
        headerName: delivery.binding.headerName,
        bindHosts: delivery.binding.bindHosts.join("\n"),
        methods: (delivery.binding.methods ?? []).join(" "),
        pathPrefixes: (delivery.binding.pathPrefixes ?? []).join("\n"),
      };

/** The binding a Brokered draft says: methods uppercase, empty lists left out. */
export const bindingOf = (draft: DeliveryDraft): BrokeredSecretBinding => {
  const methods = words(draft.methods).map((method) => method.toUpperCase());
  const pathPrefixes = words(draft.pathPrefixes);
  return {
    headerName: draft.headerName.trim(),
    bindHosts: words(draft.bindHosts).map((host) => host.toLowerCase()),
    ...(methods.length === 0 ? {} : { methods }),
    ...(pathPrefixes.length === 0 ? {} : { pathPrefixes }),
  };
};

/** The delivery a draft asks the server for. */
export const deliveryOf = (
  draft: DeliveryDraft,
):
  | { readonly mode: "direct" }
  | { readonly mode: "brokered"; readonly binding: BrokeredSecretBinding } =>
  draft.mode === "direct" ? { mode: "direct" } : { mode: "brokered", binding: bindingOf(draft) };

/**
 * Every problem with a Brokered draft, by the server's own rules (no wildcard host, no query in a
 * path, one header that may carry a credential). Empty for Direct.
 */
export const deliveryProblems = (draft: DeliveryDraft): ReadonlyArray<string> =>
  draft.mode === "direct" ? [] : brokeredSecretBindingProblems(bindingOf(draft));

/** Whether two lists hold the same values, in any order. */
const sameValues = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): boolean => [...(a ?? [])].toSorted().join("\n") === [...(b ?? [])].toSorted().join("\n");

/** Whether a delivery change takes an Organization Owner: back to Direct, or a new destination. */
export const deliveryNeedsOwner = (
  current:
    | { readonly mode: "direct" }
    | { readonly mode: "brokered"; readonly binding: BrokeredSecretBinding },
  next: DeliveryDraft,
): boolean => {
  if (current.mode !== "brokered") return false;
  if (next.mode === "direct") return true;
  const wanted = bindingOf(next);
  return !(
    current.binding.headerName.toLowerCase() === wanted.headerName.toLowerCase() &&
    sameValues(
      current.binding.bindHosts.map((host) => host.toLowerCase()),
      wanted.bindHosts,
    ) &&
    sameValues(current.binding.methods, wanted.methods) &&
    sameValues(current.binding.pathPrefixes, wanted.pathPrefixes)
  );
};

type DeliveryView =
  | { readonly mode: "direct" }
  | { readonly mode: "brokered"; readonly binding: BrokeredSecretBinding };

/** A secret's delivery as its row says it, short enough for the row: where its value may go. */
export const deliveryWords = (delivery: DeliveryView): string =>
  delivery.mode === "direct" ? "Direct" : `Brokered to ${delivery.binding.bindHosts.join(", ")}`;

/** The whole of it, for the row's tooltip: the header too. */
export const deliveryTitle = (delivery: DeliveryView): string =>
  delivery.mode === "direct"
    ? "Direct: the value reaches the workspace's environment"
    : `Brokered: the value goes in ${delivery.binding.headerName}, only to ${delivery.binding.bindHosts.join(", ")}`;

/**
 * The warning when a Brokered secret meets a project policy that doesn't allow Brokered secrets:
 * launch admission refuses every session until one side changes. Null when they agree.
 */
export const brokeredBlockedLine = (
  projectName: string,
  policy: {
    readonly rules: { readonly allowBrokeredSecrets: boolean };
    readonly source: { readonly name: string };
  } | null,
  brokeredCount: number,
): string | null => {
  if (policy === null || policy.rules.allowBrokeredSecrets || brokeredCount === 0) return null;
  return `${projectName}'s Access policy (${policy.source.name}) doesn't let Brokered secrets reach its workspaces, so no session in ${projectName} starts while a secret here is Brokered. An owner can assign a policy that allows them on the Workspace page.`;
};
