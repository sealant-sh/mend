import {
  accessPolicyPin,
  AccessPoliciesRepo,
  DopplerRepo,
  McpServersRepo,
  ProjectsRepo,
  ProjectSecretsRepo,
  type SealedProjectSecret,
  SessionsRepo,
  WorktreesRepo,
  type WorktreeNotFoundError,
} from "@mend/db";
import { type ProjectId, ProjectSecretId, type WorktreeId } from "@mend/domain";
import type {
  AccessRevocation,
  BrokeredSecretLaunch,
  WorktreeAccessPolicyPin,
} from "@mend/domain/workbench";
import { SealantClient } from "@mend/sealant";
import { SecretCipher } from "@mend/store";
import type { NetworkPolicyEnforcement } from "@sealant/sdk";
import { Config, DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import {
  accessPolicyAdmissionRefusal,
  AccessPolicyStore,
  deliverableSecrets,
  brokeredSecretsFor,
  DOPPLER_HOST,
  launchAccessPolicyOf,
  type LaunchAccessPolicy,
  launchNeedsNetworkPolicy,
  mcpServerHost,
  networkPolicyFor,
  pinOrStandard,
  type PolicyMirror,
  policyMirrorsOf,
  providerHostsFor,
} from "./access-policy.ts";

/** Session states whose workspace may be running. */
const LIVE = new Set(["starting", "running", "waiting", "idle"]);

/** What became of a policy change or revocation on one running workspace. */
export interface WorkspaceEnforcement {
  readonly workspaceId: string;
  /** sealant's answer, or `failed` when it did not take it (the message says why). */
  readonly enforcement: NetworkPolicyEnforcement | "failed";
  readonly message: string | null;
}

/** What "Apply updated policy" did: the new pin, and each running workspace's answer. */
export interface AppliedAccessPolicy {
  readonly pin: WorktreeAccessPolicyPin;
  readonly workspaces: ReadonlyArray<WorkspaceEnforcement>;
}

export class AccessPolicyApplyError extends Schema.TaggedError<AccessPolicyApplyError>()(
  "AccessPolicyApplyError",
  { message: Schema.String },
) {}

/** A project's Brokered secrets for one launch, and their values keyed by each secret's id. */
export interface BrokeredForLaunch {
  readonly secrets: ReadonlyArray<BrokeredSecretLaunch>;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * The project's Brokered secrets a launch under `policy` hands sealant, values unsealed for its
 * egress proxy only. A revoked secret is left out altogether: never its value, never a fallback to
 * the workspace's environment.
 */
export const brokeredForLaunch = (
  sealed: ReadonlyArray<SealedProjectSecret>,
  policy: Pick<LaunchAccessPolicy, "revokedSecretIds" | "revokedHosts" | "revokedAll">,
  decrypt: (sealedValue: string) => Effect.Effect<string, unknown>,
): Effect.Effect<BrokeredForLaunch, AccessPolicyApplyError> =>
  Effect.gen(function* () {
    const secrets: Array<BrokeredSecretLaunch> = [];
    const values: Record<string, string> = {};
    for (const secret of deliverableSecrets(sealed, policy).brokered) {
      if (secret.brokered === null) continue;
      const value = yield* decrypt(secret.sealedValue).pipe(
        // Named by key only: a broken machine key must never print a value.
        Effect.mapError(
          () =>
            new AccessPolicyApplyError({
              message: `secret ${secret.name} could not be unsealed with this machine's key`,
            }),
        ),
      );
      secrets.push({
        secretId: secret.id,
        name: secret.name,
        placeholder: secret.brokered.placeholder,
        binding: secret.brokered.binding,
      });
      values[secret.id] = value;
    }
    return { secrets, values };
  });

/** The mirrors this server runs, as a Restricted policy names them. */
export const configuredPolicyMirrors: Effect.Effect<ReadonlyArray<PolicyMirror>> = Effect.gen(
  function* () {
    const npm = yield* Config.String("MEND_NPM_MIRROR_URL").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const docker = yield* Config.String("SEALANT_DOCKER_REGISTRY_MIRRORS").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    return policyMirrorsOf({ npm, docker });
  },
);

/**
 * Applies Access policies to running workspaces through `@sealant/sdk`: "Apply updated policy"
 * re-pins a worktree and pushes the new rules; a stored revocation is fanned out to every
 * running workspace it reaches. sealant holds each revocation durably from then on, so a
 * workspace that was not running gets it when it next starts.
 */
export class AccessPolicyEnforcement extends Context.Service<
  AccessPolicyEnforcement,
  {
    readonly applyUpdatedPolicy: (
      worktreeId: WorktreeId,
    ) => Effect.Effect<AppliedAccessPolicy, WorktreeNotFoundError | AccessPolicyApplyError>;
    readonly fanOutRevocation: (
      revocation: AccessRevocation,
    ) => Effect.Effect<ReadonlyArray<WorkspaceEnforcement>>;
  }
>()("@mend/sessions/AccessPolicyEnforcement") {}

const failed = (workspaceId: string, error: unknown): WorkspaceEnforcement => ({
  workspaceId,
  enforcement: "failed",
  message:
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error),
});

export const AccessPolicyEnforcementLive: Layer.Layer<
  AccessPolicyEnforcement,
  never,
  | SealantClient
  | SessionsRepo
  | WorktreesRepo
  | AccessPoliciesRepo
  | ProjectSecretsRepo
  | SecretCipher
  | McpServersRepo
  | DopplerRepo
  | ProjectsRepo
> = Layer.effect(
  AccessPolicyEnforcement,
  Effect.gen(function* () {
    const sealant = yield* SealantClient;
    const sessions = yield* SessionsRepo;
    const worktrees = yield* WorktreesRepo;
    const repo = yield* AccessPoliciesRepo;
    const secrets = yield* ProjectSecretsRepo;
    const cipher = yield* SecretCipher;
    const mcpServers = yield* McpServersRepo;
    const doppler = yield* DopplerRepo;
    const projects = yield* ProjectsRepo;

    /** Each running workspace of a worktree, with the harnesses and people of its sessions. */
    const runningWorkspaces = (worktreeId: WorktreeId) =>
      sessions.listForWorktree(worktreeId).pipe(
        Effect.map((all) => {
          const byWorkspace = new Map<string, { harnesses: Set<string>; people: Set<string> }>();
          for (const session of all) {
            if (!LIVE.has(session.status) || session.sealantWorkspaceId === null) continue;
            const entry = byWorkspace.get(session.sealantWorkspaceId) ?? {
              harnesses: new Set<string>(),
              people: new Set<string>(),
            };
            entry.harnesses.add(session.harness);
            if (session.ownerUserId !== null) entry.people.add(session.ownerUserId);
            byWorkspace.set(session.sealantWorkspaceId, entry);
          }
          return byWorkspace;
        }),
      );

    /** The hosts a Restricted workspace reaches unlisted: providers, Doppler, MCP servers. */
    const autoHostsFor = (
      projectId: ProjectId,
      harnesses: ReadonlySet<string>,
      people: ReadonlySet<string>,
    ) =>
      Effect.gen(function* () {
        const hosts = new Set<string>();
        for (const harness of harnesses)
          for (const host of providerHostsFor(harness)) hosts.add(host);
        for (const person of people) {
          const mappings = yield* doppler.mappings(person).pipe(Effect.orElseSucceed(() => []));
          if (mappings.some((mapping) => mapping.projectId === projectId)) hosts.add(DOPPLER_HOST);
          const servers = yield* mcpServers.list(person).pipe(Effect.orElseSucceed(() => []));
          for (const server of servers) {
            if (!server.enabled || server.transport._tag === "stdio") continue;
            const host = mcpServerHost(server.transport.url);
            if (host !== null) hosts.add(host);
          }
        }
        return [...hosts];
      });

    const applyTo = (
      workspaceId: string,
      policy: LaunchAccessPolicy,
      projectId: ProjectId,
      who: { harnesses: ReadonlySet<string>; people: ReadonlySet<string> },
      brokered: BrokeredForLaunch,
      mirrors: ReadonlyArray<PolicyMirror>,
    ) =>
      Effect.gen(function* () {
        const autoHosts = yield* autoHostsFor(projectId, who.harnesses, who.people);
        const workspace = yield* sealant.getWorkspace(workspaceId);
        const answer = yield* sealant.applyNetworkPolicy(workspace, {
          networkPolicy: networkPolicyFor({
            policy,
            autoHosts,
            mirrors,
            brokered: brokered.secrets,
          }),
          ...(brokered.secrets.length === 0
            ? {}
            : {
                brokeredSecrets: brokeredSecretsFor(brokered.secrets),
                brokeredSecretValues: brokered.values,
              }),
        });
        return {
          workspaceId,
          enforcement: answer.enforcement,
          message: null,
        } satisfies WorkspaceEnforcement;
      }).pipe(Effect.catch((error) => Effect.succeed(failed(workspaceId, error))));

    const applyUpdatedPolicy = Effect.fn("AccessPolicyEnforcement.applyUpdatedPolicy")(function* (
      worktreeId: WorktreeId,
    ) {
      const worktree = yield* worktrees.byId(worktreeId);
      const project = yield* projects
        .byId(worktree.projectId)
        .pipe(
          Effect.mapError(
            () =>
              new AccessPolicyApplyError({ message: "the worktree's project could not be read" }),
          ),
        );
      const store = yield* AccessPolicyStore;
      const projectPolicy = yield* store.projectPolicy(worktree.projectId);
      const pin = accessPolicyPin(
        projectPolicy.rules,
        projectPolicy.source,
        yield* DateTime.nowAsDate,
      );
      const revocations = yield* store.revocationsForProject(worktree.projectId);
      const policy = launchAccessPolicyOf(pin, revocations);
      const sealed = yield* secrets
        .sealedForLaunch(worktree.projectId)
        .pipe(
          Effect.mapError(
            () =>
              new AccessPolicyApplyError({ message: "the project's secrets could not be read" }),
          ),
        );
      // The worktree's runtime must hold to the new rules before anything changes: refused, the
      // worktree keeps the pin it had, as a launch under them would be refused (§8.3).
      const deliverable = deliverableSecrets(sealed.secrets, policy);
      const refusal = accessPolicyAdmissionRefusal({
        rules: policy.rules,
        runtime: worktree.sessionRuntime,
        dockerInside: project.workspaceImage.services.docker,
        brokeredCount: deliverable.brokered.length,
        brokeredNames: deliverable.brokered.map((secret) => secret.name),
        revokesHosts: policy.revokedAll || policy.revokedHosts.length > 0,
      });
      if (refusal !== null) return yield* new AccessPolicyApplyError({ message: refusal });
      const brokered = policy.rules.allowBrokeredSecrets
        ? yield* brokeredForLaunch(sealed.secrets, policy, cipher.decrypt)
        : { secrets: [], values: {} };
      const mirrors = yield* configuredPolicyMirrors;
      // Only an egress proxy holds network rules: rules neither side of the change needs one for
      // (a new Git cap, Executor tools) are Mend's own, and re-pinning is all they take.
      const before = launchAccessPolicyOf(pinOrStandard(worktree.accessPolicy), revocations);
      const pushes =
        launchNeedsNetworkPolicy(policy, brokered.secrets.length) ||
        launchNeedsNetworkPolicy(before, 0);
      const running = pushes ? yield* runningWorkspaces(worktreeId) : new Map();
      const workspaces = yield* Effect.forEach(
        [...running.entries()],
        ([workspaceId, who]) =>
          applyTo(workspaceId, policy, worktree.projectId, who, brokered, mirrors),
        { concurrency: 4 },
      );
      // A running workspace whose egress proxy did not confirm the rules (refused, not answered,
      // or no proxy runs and they would reach it only at its next start) keeps the worktree on its
      // old pin: Mend never says a worktree holds rules a running workspace does not.
      const refused = workspaces.filter((workspace) => workspace.enforcement !== "enforced");
      if (refused.length > 0) {
        return yield* new AccessPolicyApplyError({
          message: `The worktree keeps the policy it had: ${refused
            .map((workspace) =>
              workspace.enforcement === "failed"
                ? `workspace ${workspace.workspaceId} did not take the new rules (${workspace.message ?? "no answer"})`
                : workspace.enforcement === "next-start"
                  ? `workspace ${workspace.workspaceId} runs no egress proxy now, so it would take the new rules only when it starts again`
                  : `workspace ${workspace.workspaceId}'s egress proxy has not confirmed the new rules`,
            )
            .join("; ")}. ${
            // A workspace with no proxy takes the rules only when it starts, and a session started
            // before the re-pin starts under the old ones: stop, apply, then start.
            refused.some((workspace) => workspace.enforcement === "next-start")
              ? "Stop the worktree's sessions, apply the updated policy, then start one."
              : "Try again once its workspace answers, or stop the worktree's sessions and apply the updated policy then."
          }`,
        });
      }
      yield* worktrees.setAccessPolicy(worktreeId, pin);
      return { pin, workspaces };
    });

    const fanOutRevocation = Effect.fn("AccessPolicyEnforcement.fanOutRevocation")(function* (
      revocation: AccessRevocation,
    ) {
      const reached = yield* repo.worktreesFrom(revocation.organizationId, revocation.policyId);
      const options =
        revocation.kind === "all"
          ? { all: true }
          : revocation.kind === "host"
            ? { hosts: [revocation.target ?? ""] }
            : { secretIds: [revocation.target ?? ""] };
      const results: Array<WorkspaceEnforcement> = [];
      for (const worktree of reached) {
        // A secret revocation reaches only the project that owns the secret.
        if (revocation.kind === "secret") {
          const owned = yield* secrets
            .deliveryOf(worktree.projectId, ProjectSecretId.make(revocation.target ?? ""))
            .pipe(Effect.orElseSucceed(() => null));
          if (owned === null) continue;
        }
        const running = yield* runningWorkspaces(worktree.worktreeId);
        for (const workspaceId of running.keys()) {
          const result = yield* sealant.getWorkspace(workspaceId).pipe(
            Effect.flatMap((workspace) => sealant.revokeAccess(workspace, options)),
            Effect.map(
              (answer): WorkspaceEnforcement => ({
                workspaceId,
                enforcement: answer.enforcement,
                message: null,
              }),
            ),
            Effect.catch((error) => Effect.succeed(failed(workspaceId, error))),
          );
          results.push(result);
        }
      }
      return results;
    });

    return AccessPolicyEnforcement.of({ applyUpdatedPolicy, fanOutRevocation });
  }),
);
