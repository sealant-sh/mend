import { accessPolicyHash, AccessPoliciesRepo, SessionsRepo, WorktreesRepo } from "@mend/db";
import type { SessionId, SessionRuntime } from "@mend/domain";
import {
  type AccessPolicyRules,
  type BrokeredSecretBinding,
  revocationReaches,
  type AccessPolicySource as PolicySource,
  type AccessRevocation,
  type BrokeredSecretLaunch,
  effectiveAccessPolicyRules,
  type ProjectAccessPolicy,
  revokedHosts,
  revokedSecretIds,
  STANDARD_ACCESS_POLICY_RULES,
  STANDARD_PROJECT_ACCESS_POLICY,
  type WorktreeAccessPolicyPin,
} from "@mend/domain/workbench";
import type { BrokeredSecret, NetworkPolicy, NetworkPolicyAllowHost } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * How far Mend's Git signer goes for a worktree (agent-home `workspace-isolation-architecture.md`
 * §7.4, ADR 0025's 2026-11-24 amendment): `disabled` signs nothing, `read-only` signs fetches and
 * archives, `read-write` signs those and pushes to the project's own repository. A cap on the
 * signer only: the person's Account Git access mode still chooses how they sign.
 */
export type GitTransportCeiling = "disabled" | "read-only" | "read-write";

/** The rules of a worktree's Access policy that Mend enforces in its own process. */
export interface WorktreeAccessPolicy {
  readonly gitTransport: GitTransportCeiling;
  /** Whether the session's agents may call the organization's Executor tools (ADR 0022). */
  readonly allowExecutorTools: boolean;
}

/** `Standard`: what every worktree has until an Access policy says otherwise. */
export const STANDARD_ACCESS_POLICY: WorktreeAccessPolicy = {
  gitTransport: "read-write",
  allowExecutorTools: true,
};

/** Where a session's worktree policy is read from. */
export interface AccessPolicySource {
  readonly forSession: (sessionId: SessionId) => Effect.Effect<WorktreeAccessPolicy>;
}

/**
 * The one place Mend's enforcement points read a session's worktree policy: the Git signer and
 * the MCP dispatcher's Executor tools. Without stored policies (a test's world) every session
 * reads `STANDARD_ACCESS_POLICY`; the server provides `AccessPoliciesFromDatabase`, which reads
 * the worktree's pin less the organization's revocations.
 */
export const AccessPolicies: Context.Reference<AccessPolicySource> =
  Context.Reference<AccessPolicySource>("@mend/sessions/AccessPolicies", {
    defaultValue: () => ({ forSession: () => Effect.succeed(STANDARD_ACCESS_POLICY) }),
  });

/** What a launch reads of a project's stored policy and its organization's revocations. */
export interface AccessPolicyStoreShape {
  readonly projectPolicy: (
    projectId: Parameters<AccessPoliciesRepo["Service"]["projectPolicy"]>[0],
  ) => Effect.Effect<ProjectAccessPolicy>;
  readonly revocationsForProject: (
    projectId: Parameters<AccessPoliciesRepo["Service"]["revocationsForProject"]>[0],
  ) => Effect.Effect<ReadonlyArray<AccessRevocation>>;
}

/**
 * The stored policies a launch reads. Without a database (a test's world): every project holds
 * Standard and nothing is revoked, which is what every install had before Access policies.
 */
export const AccessPolicyStore: Context.Reference<AccessPolicyStoreShape> =
  Context.Reference<AccessPolicyStoreShape>("@mend/sessions/AccessPolicyStore", {
    defaultValue: () => ({
      projectPolicy: () => Effect.succeed(STANDARD_PROJECT_ACCESS_POLICY),
      revocationsForProject: () => Effect.succeed([]),
    }),
  });

/** A worktree's pin, or Standard for a worktree from before Access policies. */
export const pinOrStandard = (
  pin: WorktreeAccessPolicyPin | null,
): Pick<WorktreeAccessPolicyPin, "rules" | "source"> => pin ?? STANDARD_PROJECT_ACCESS_POLICY;

/**
 * What one launch of a worktree runs under: its pin less every revocation that reaches it, the
 * hash of those rules, and the secret ids and hosts revoked.
 */
export interface LaunchAccessPolicy {
  readonly rules: AccessPolicyRules;
  readonly source: PolicySource;
  readonly policyHash: string;
  /** Null under exactly Standard's rules: what a hot-pool fingerprint leaves out. */
  readonly fingerprintHash: string | null;
  readonly revokedSecretIds: ReadonlySet<string>;
  readonly revokedHosts: ReadonlyArray<string>;
  /** An `all` revocation reaches the worktree: every grant is gone, the automatic ones too. */
  readonly revokedAll: boolean;
}

const STANDARD_HASH = accessPolicyHash(STANDARD_ACCESS_POLICY_RULES);

export const launchAccessPolicyOf = (
  pin: Pick<WorktreeAccessPolicyPin, "rules" | "source">,
  revocations: ReadonlyArray<Pick<AccessRevocation, "policyId" | "kind" | "target">>,
): LaunchAccessPolicy => {
  const rules = effectiveAccessPolicyRules(pin, revocations);
  const hosts = revokedHosts(pin.source, revocations);
  const policyHash = accessPolicyHash(rules);
  const secretIds = revokedSecretIds(pin.source, revocations);
  const all = revocations.some(
    (revocation) => revocation.kind === "all" && revocationReaches(revocation, pin.source),
  );
  // The fingerprint names what a standby holds that a revocation took back since: a standby made
  // before a revocation never serves a claim after it (§8.3).
  const revoked = [
    ...(all ? ["all"] : []),
    ...[...hosts].toSorted().map((host) => `host:${host}`),
    ...[...secretIds].toSorted().map((id) => `secret:${id}`),
  ];
  return {
    rules,
    source: pin.source,
    policyHash,
    fingerprintHash:
      policyHash === STANDARD_HASH && revoked.length === 0
        ? null
        : revoked.length === 0
          ? policyHash
          : `${policyHash}+revoked:${revoked.join(",")}`,
    revokedSecretIds: secretIds,
    revokedHosts: hosts,
    revokedAll: all,
  };
};

/**
 * The project secrets a launch under `policy` delivers: Direct ones to the environment, Brokered
 * ones to the egress proxy with every revoked host taken out of their bind hosts. A revoked
 * secret goes nowhere, nor one whose bind hosts are all revoked, nor any Brokered secret once
 * everything is revoked; none falls back to the environment.
 */
export const deliverableSecrets = <
  S extends {
    readonly id: string;
    readonly brokered: {
      readonly binding: BrokeredSecretBinding;
      readonly placeholder: string;
    } | null;
  },
>(
  sealed: ReadonlyArray<S>,
  policy: Pick<LaunchAccessPolicy, "revokedSecretIds" | "revokedHosts" | "revokedAll">,
): { readonly direct: ReadonlyArray<S>; readonly brokered: ReadonlyArray<S> } => {
  const revokedHostSet = new Set(policy.revokedHosts);
  const direct: Array<S> = [];
  const brokered: Array<S> = [];
  for (const secret of sealed) {
    if (policy.revokedSecretIds.has(secret.id)) continue;
    if (secret.brokered === null) {
      direct.push(secret);
      continue;
    }
    if (policy.revokedAll) continue;
    const bindHosts = secret.brokered.binding.bindHosts.filter(
      (host) => !revokedHostSet.has(host.toLowerCase().replace(/\.$/, "")),
    );
    if (bindHosts.length === 0) continue;
    brokered.push({
      ...secret,
      brokered: { ...secret.brokered, binding: { ...secret.brokered.binding, bindHosts } },
    });
  }
  return { direct, brokered };
};

/**
 * What a new workspace is told is revoked, right after its create and before anything runs in
 * it: sealant holds a revocation per workspace, so one made after the organization's revocation
 * needs telling. Null when nothing reaches the worktree.
 */
export const revocationsToCarry = (
  policy: Pick<LaunchAccessPolicy, "revokedSecretIds" | "revokedHosts" | "revokedAll">,
):
  | { readonly all: true }
  | { readonly hosts?: ReadonlyArray<string>; readonly secretIds?: ReadonlyArray<string> }
  | null => {
  if (policy.revokedAll) return { all: true };
  const hosts = [...policy.revokedHosts];
  const secretIds = [...policy.revokedSecretIds];
  if (hosts.length === 0 && secretIds.length === 0) return null;
  return {
    ...(hosts.length === 0 ? {} : { hosts }),
    ...(secretIds.length === 0 ? {} : { secretIds }),
  };
};

/**
 * The hosts a Restricted worktree reaches without listing them, shown on its page: what the
 * session's agent needs to run (its model provider), Doppler when the person uses it, and the
 * hosts of the person's MCP servers (agent-home `workspace-isolation-architecture.md` §7.1).
 */
const PROVIDER_HOSTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claude: ["api.anthropic.com", "claude.ai", "console.anthropic.com", "statsig.anthropic.com"],
  codex: ["chatgpt.com", "api.openai.com", "auth.openai.com"],
  antigravity: [
    "cloudcode-pa.googleapis.com",
    "generativelanguage.googleapis.com",
    "oauth2.googleapis.com",
  ],
};

const ANY_PROVIDER_HOSTS: ReadonlyArray<string> = [
  ...(PROVIDER_HOSTS["claude"] ?? []),
  ...(PROVIDER_HOSTS["codex"] ?? []),
];

export const DOPPLER_HOST = "api.doppler.com";

/** Every model provider's hosts: what a standby, which any harness may claim, reaches. */
export const allProviderHosts = (): ReadonlyArray<string> => [
  ...new Set(Object.values(PROVIDER_HOSTS).flat()),
];

/** The model-provider hosts a harness needs; a harness that can use any provider gets both. */
export const providerHostsFor = (harness: string): ReadonlyArray<string> =>
  harness === "shell" ? [] : (PROVIDER_HOSTS[harness] ?? ANY_PROVIDER_HOSTS);

/** The host of an MCP server's URL, or null for a local (stdio) server or one that is not a URL. */
export const mcpServerHost = (url: string | null): string | null => {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
};

/** A mirror a Restricted workspace may still reach (`MEND_NPM_MIRROR_URL`, the Docker mirror). */
export interface PolicyMirror {
  readonly name: "npm" | "docker";
  readonly host: string;
  readonly port: number;
}

const policyMirror = (name: "npm" | "docker", raw: string | undefined): Array<PolicyMirror> => {
  const first = raw?.split(",")[0]?.trim();
  if (first === undefined || first === "") return [];
  try {
    const url = new URL(first);
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return [{ name, host: url.hostname.toLowerCase(), port }];
  } catch {
    return [];
  }
};

/** The mirrors in `MEND_NPM_MIRROR_URL` and `SEALANT_DOCKER_REGISTRY_MIRRORS`, as policy names them. */
export const policyMirrorsOf = (env: {
  readonly npm?: string | undefined;
  readonly docker?: string | undefined;
}): ReadonlyArray<PolicyMirror> => {
  return [...policyMirror("npm", env.npm), ...policyMirror("docker", env.docker)];
};

/**
 * Whether a launch under `policy` needs the workspace's egress proxy, and so a network policy
 * on its create: Restricted egress, a VM requirement, a Brokered secret, or a revoked host (only
 * a proxy refuses a host). Otherwise the create carries none, as before Access policies.
 */
export const launchNeedsNetworkPolicy = (
  policy: Pick<LaunchAccessPolicy, "rules" | "revokedHosts" | "revokedAll">,
  brokeredCount: number,
): boolean =>
  policy.rules.mode === "restricted" ||
  policy.rules.requireVmIsolation ||
  brokeredCount > 0 ||
  policy.revokedHosts.length > 0 ||
  policy.revokedAll;

/**
 * The network policy a create or "Apply updated policy" hands sealant: the pinned hosts, under
 * Restricted the hosts the session needs to run (`autoHosts`) and the mirrors, and every Brokered
 * secret's bind hosts with TLS inspected. A revoked host is never listed.
 */
export const networkPolicyFor = (input: {
  readonly policy: LaunchAccessPolicy;
  readonly autoHosts: ReadonlyArray<string>;
  readonly mirrors: ReadonlyArray<PolicyMirror>;
  readonly brokered: ReadonlyArray<BrokeredSecretLaunch>;
}): NetworkPolicy => {
  const revoked = new Set(input.policy.revokedHosts);
  const hosts = new Map<string, NetworkPolicyAllowHost>();
  const add = (entry: NetworkPolicyAllowHost) => {
    const host = entry.host.toLowerCase();
    if (revoked.has(host)) return;
    const existing = hosts.get(host);
    hosts.set(
      host,
      existing === undefined
        ? { ...entry, host }
        : { ...existing, ...(entry.inspectTls === true ? { inspectTls: true } : {}) },
    );
  };
  for (const entry of input.policy.rules.allowHosts) {
    add({
      host: entry.host,
      ...(entry.ports === undefined ? {} : { ports: entry.ports }),
      ...(entry.inspectTls === undefined ? {} : { inspectTls: entry.inspectTls }),
      ...(entry.methods === undefined ? {} : { methods: entry.methods }),
      ...(entry.pathPrefixes === undefined ? {} : { pathPrefixes: entry.pathPrefixes }),
    });
  }
  // Everything revoked: not even what a session needs to run is let through.
  if (input.policy.rules.mode === "restricted" && !input.policy.revokedAll) {
    for (const host of input.autoHosts) add({ host });
  }
  for (const secret of input.brokered) {
    for (const host of secret.binding.bindHosts) add({ host, inspectTls: true });
  }
  const allowHosts = [...hosts.values()].toSorted((a, b) => (a.host < b.host ? -1 : 1));
  return {
    mode: input.policy.rules.mode,
    policyHash: input.policy.policyHash,
    sourcePolicyId: input.policy.source.policyId,
    sourcePolicyRevision: input.policy.source.revision,
    ...(input.policy.rules.requireVmIsolation ? { requireVmIsolation: true } : {}),
    ...(allowHosts.length === 0 ? {} : { allowHosts }),
    ...(input.policy.rules.mode === "restricted" &&
    !input.policy.revokedAll &&
    input.mirrors.length > 0
      ? { allowMirrors: input.mirrors.map((mirror) => ({ ...mirror })) }
      : {}),
  };
};

/** The project's Brokered secrets as sealant takes them: the secret's id names its value. */
export const brokeredSecretsFor = (
  brokered: ReadonlyArray<BrokeredSecretLaunch>,
): ReadonlyArray<BrokeredSecret> =>
  brokered.map((secret) => ({
    secretId: secret.secretId,
    name: secret.name,
    placeholder: secret.placeholder,
    secretRef: secret.secretId,
    headerName: secret.binding.headerName,
    bindHosts: secret.binding.bindHosts,
    ...(secret.binding.methods === undefined ? {} : { methods: secret.binding.methods }),
    ...(secret.binding.pathPrefixes === undefined
      ? {}
      : { pathPrefixes: secret.binding.pathPrefixes }),
  }));

/** The runtimes that run a workspace behind an egress proxy of its own, in sealant 0.40.0-next.936. */
const PROXY_RUNTIMES: ReadonlySet<SessionRuntime> = new Set(["docker", "host-vm"]);

/**
 * Why a launch is refused before anything is created, or null when it may go on. Admission is
 * fail-closed: a worktree never runs with less than its policy asks for (§8.3). `runtime` null is
 * an install where sealant picks, which on a local install is this server's Docker.
 */
export const accessPolicyAdmissionRefusal = (input: {
  readonly rules: AccessPolicyRules;
  readonly runtime: SessionRuntime | null;
  readonly dockerInside: boolean;
  readonly brokeredCount: number;
  /** Brokered secrets the policy does not allow, by name. */
  readonly brokeredNames: ReadonlyArray<string>;
  /** A host or `all` revocation reaches the worktree: only an egress proxy refuses a host. */
  readonly revokesHosts?: boolean;
}): string | null => {
  const runtime = input.runtime ?? "docker";
  if (input.brokeredCount > 0 && !input.rules.allowBrokeredSecrets) {
    return `This project's Access policy does not let Brokered secrets reach its workspaces, and ${input.brokeredNames.join(", ")} ${input.brokeredNames.length === 1 ? "is" : "are"} Brokered. An Organization Owner can assign a policy that allows them, or the secret can be made Direct.`;
  }
  if (input.rules.requireVmIsolation && runtime === "docker") {
    return "This worktree's Access policy needs a VM of its own for every workspace, and its sessions run in containers on this server's Docker, which share the server's kernel. An Organization Owner can switch Organization → Runtime to this server's KVM.";
  }
  if (input.rules.mode === "restricted" && input.dockerInside && runtime === "docker") {
    return "This worktree's Access policy restricts egress, and its workspace image runs Docker inside the workspace, which a container on this server's Docker cannot keep behind the policy. Turn Docker off in the workspace image, or switch Organization → Runtime to this server's KVM.";
  }
  if (input.brokeredCount > 0 && !PROXY_RUNTIMES.has(runtime)) {
    return `Brokered secrets reach a workspace only through an egress proxy of its own, which sessions on ${runtime === "boat" ? "Boat" : runtime} do not have. Make the secrets Direct, or run this organization's sessions on this server's Docker or KVM.`;
  }
  // sealant runs a Docker workspace's proxy only for Restricted egress or a Brokered secret; a
  // host VM always has one.
  const runsProxy =
    runtime === "host-vm" ||
    (runtime === "docker" && (input.rules.mode === "restricted" || input.brokeredCount > 0));
  if (input.revokesHosts === true && !runsProxy) {
    return "An Organization Owner revoked access this worktree's policy granted, and only a workspace's own egress proxy can refuse a host. Its sessions run without one here, so the revocation could not hold. An owner can make the project's policy Restricted, or switch Organization → Runtime to this server's KVM.";
  }
  return null;
};

/**
 * The database-backed policies: a session reads its worktree's pin less the organization's
 * revocations, and a launch reads the project's own copy. What the server provides.
 */
export const AccessPoliciesFromDatabase: Layer.Layer<
  never,
  never,
  AccessPoliciesRepo | SessionsRepo | WorktreesRepo
> = Layer.mergeAll(
  Layer.effect(
    AccessPolicyStore,
    Effect.gen(function* () {
      const repo = yield* AccessPoliciesRepo;
      return {
        projectPolicy: (projectId) =>
          repo
            .projectPolicy(projectId)
            .pipe(Effect.map((policy) => policy ?? STANDARD_PROJECT_ACCESS_POLICY)),
        revocationsForProject: (projectId) => repo.revocationsForProject(projectId),
      };
    }),
  ),
  Layer.effect(
    AccessPolicies,
    Effect.gen(function* () {
      const repo = yield* AccessPoliciesRepo;
      const sessions = yield* SessionsRepo;
      const worktrees = yield* WorktreesRepo;
      return {
        forSession: (sessionId: SessionId) =>
          Effect.gen(function* () {
            const session = yield* sessions.byId(sessionId);
            const worktree = yield* worktrees.byId(session.worktreeId);
            const revocations = yield* repo.revocationsForProject(worktree.projectId);
            const rules = effectiveAccessPolicyRules(
              pinOrStandard(worktree.accessPolicy),
              revocations,
            );
            return {
              gitTransport: rules.gitTransport,
              allowExecutorTools: rules.allowExecutorTools,
            };
          }).pipe(
            // A session or worktree that cannot be read gets nothing it might not be allowed:
            // the signer signs nothing and Executor tools stay closed.
            Effect.catch(() =>
              Effect.succeed<WorktreeAccessPolicy>({
                gitTransport: "disabled",
                allowExecutorTools: false,
              }),
            ),
          ),
      };
    }),
  ),
);
