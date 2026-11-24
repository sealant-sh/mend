import {
  AccessPoliciesView,
  AccessPolicyBuiltIn,
  AccessPolicyNameTaken,
  AccessPolicyNotApplied,
  AccessPolicyOwnersOnly,
  AccessPolicyRejected,
  AccessPolicyStaleWrite,
  AccessRevoked,
  AppliedAccessPolicyView,
  CurrentUser,
  MendApi,
  NotFound,
  ProjectAccessPolicyView,
  type RevokeAccessRequest,
  WorkspaceEnforcementView,
  WorktreeAccessPolicyView,
} from "@mend/api-contracts";
import {
  type AccessPolicyBuiltInError,
  type AccessPolicyNameTakenError,
  type AccessPolicyStaleWriteError,
  accessPolicyHash,
  AccessPoliciesRepo,
  AuditEventsRepo,
  type OrganizationMembership,
} from "@mend/db";
import { AccessPolicyId, type OrganizationId, type ProjectId } from "@mend/domain";
import {
  type AccessPolicy,
  type AccessPolicyRules,
  accessPolicyNameProblem,
  accessPolicyRulesProblems,
  canonicalPolicyHost,
  effectiveAccessPolicyRules,
  isElevatedAccessPolicy,
  parseOperatorPrivateEgressCeiling,
  parsePrivateEgressEntry,
  type ProjectAccessPolicy,
  revocationReaches,
  STANDARD_ACCESS_POLICY_ID,
  STANDARD_ACCESS_POLICY_RULES,
  STANDARD_PROJECT_ACCESS_POLICY,
} from "@mend/domain/workbench";
import {
  AccessPolicyEnforcement,
  pinOrStandard,
  SessionEngine,
  type WorkspaceEnforcement,
} from "@mend/sessions";
import { Config, Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { membership } from "./organization.ts";

/**
 * Access policies (ADR 0025's 2026-11-24 amendment; agent-home
 * `docs/workspace-isolation-architecture.md` §7–§8): the organization's templates, each project's
 * own copy, and each worktree's pin. Every member reads; Organization Owners write templates and
 * revoke; whoever manages a project assigns it a copy, an elevated one only an Organization Owner.
 */

/** `MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS`: the private destinations any policy here may open. */
const privateEgressCeiling: Effect.Effect<ReadonlyArray<string>> = Config.String(
  "MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS",
).pipe(
  Config.withDefault(""),
  Effect.orElseSucceed(() => ""),
  Effect.map(parseOperatorPrivateEgressCeiling),
);

const OWNERS_WRITE =
  "Only an Organization Owner changes the organization's Access policies. Ask one to make this change.";
const OWNERS_REVOKE = "Only an Organization Owner revokes access. Ask one to revoke it.";
const OWNERS_ELEVATED =
  "This policy is elevated: it lets Brokered secrets reach the project's workspaces or opens private destinations. Only an Organization Owner assigns an elevated policy. Ask one to assign it.";
const BUILT_IN =
  "Standard is the built-in policy: it can't be edited or removed. Make a policy of your own instead.";

/** The caller's membership when they are an Organization Owner; 403 for a member, 404 for anyone else. */
const ownerOnly = (message: string) =>
  Effect.gen(function* () {
    const found: OrganizationMembership = yield* membership;
    if (found.role !== "owner") return yield* new AccessPolicyOwnersOnly({ message });
    return found;
  });

/** Every rule a template's name and rules break against this server's ceiling. */
const templateProblems = (name: string, rules: AccessPolicyRules) =>
  Effect.gen(function* () {
    const ceiling = yield* privateEgressCeiling;
    const nameProblem = accessPolicyNameProblem(name);
    const problems = [
      ...(nameProblem === null ? [] : [nameProblem]),
      ...accessPolicyRulesProblems(rules, ceiling),
    ];
    if (problems.length > 0) {
      return yield* new AccessPolicyRejected({
        message: "This policy was not saved: fix what is listed and save it again.",
        problems,
      });
    }
  });

const nameTaken = (error: AccessPolicyNameTakenError) =>
  new AccessPolicyNameTaken({
    name: error.name,
    message: `There's already a policy called ${error.name}. Pick another name.`,
  });

const staleWrite = (error: AccessPolicyStaleWriteError) =>
  new AccessPolicyStaleWrite({
    policyId: AccessPolicyId.make(error.policyId),
    currentRevision: error.currentRevision,
    message:
      "Someone changed this policy since you opened it. Open it again to see what changed, then make your change.",
  });

const builtIn = (_: AccessPolicyBuiltInError) => new AccessPolicyBuiltIn({ message: BUILT_IN });

/** The audit facts of a template: never more than its name, revision and whether it is elevated. */
const templateData = (policy: AccessPolicy) => ({
  name: policy.name,
  revision: policy.revision,
  elevated: policy.elevated,
});

/** Every rule a revocation breaks; a named policy must be one of the organization's. */
export const revocationProblems = (request: RevokeAccessRequest): ReadonlyArray<string> => {
  const target = request.target?.trim() ?? "";
  if (request.kind === "all") {
    return request.target === null ? [] : ["target: a revocation of everything names no target"];
  }
  if (target === "") {
    return [
      request.kind === "host"
        ? "target: name the host to revoke, such as api.example.com"
        : "target: name the id of the project secret to revoke",
    ];
  }
  if (request.kind === "secret") return [];
  // A private destination a policy opened (`10.0.4.0/24`) is revoked by its own entry.
  if (parsePrivateEgressEntry(target) !== null) return [];
  // The host as a policy would list it, checked by sealant's rules through the domain's.
  return accessPolicyRulesProblems(
    { ...STANDARD_ACCESS_POLICY_RULES, allowHosts: [{ host: canonicalPolicyHost(target) }] },
    [],
  ).map((problem) => problem.replace(/^allowHosts:/, "target:"));
};

const enforcementView = (result: WorkspaceEnforcement) =>
  new WorkspaceEnforcementView({
    workspaceId: result.workspaceId,
    enforcement: result.enforcement,
    message: result.message,
  });

export const AccessPoliciesGroupLive = HttpApiBuilder.group(MendApi, "accessPolicies", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const found = yield* membership;
        const repo = yield* AccessPoliciesRepo;
        return new AccessPoliciesView({
          policies: yield* repo.list(found.organization.id),
          revocations: yield* repo.revocations(found.organization.id),
          privateEgressCeiling: yield* privateEgressCeiling,
        });
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownerOnly(OWNERS_WRITE);
        const caller = yield* CurrentUser;
        yield* templateProblems(payload.name, payload.rules);
        const created = yield* (yield* AccessPoliciesRepo)
          .create({
            organizationId: found.organization.id,
            name: payload.name,
            rules: payload.rules,
            createdByUserId: caller.user.id,
          })
          .pipe(
            Effect.catchTag("AccessPolicyNameTakenError", (error) => Effect.fail(nameTaken(error))),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "access_policy.created",
          subjectType: "access_policy",
          subjectId: created.id,
          data: templateData(created),
        });
        return created;
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const found = yield* ownerOnly(OWNERS_WRITE);
        const caller = yield* CurrentUser;
        if (params.id === STANDARD_ACCESS_POLICY_ID) {
          return yield* new AccessPolicyBuiltIn({ message: BUILT_IN });
        }
        yield* templateProblems(payload.name, payload.rules);
        const updated = yield* (yield* AccessPoliciesRepo)
          .update({
            organizationId: found.organization.id,
            id: params.id,
            name: payload.name,
            rules: payload.rules,
            expectedRevision: payload.expectedRevision,
          })
          .pipe(
            Effect.catchTags({
              AccessPolicyNotFoundError: () => Effect.fail(new NotFound({ id: params.id })),
              AccessPolicyNameTakenError: (error) => Effect.fail(nameTaken(error)),
              AccessPolicyStaleWriteError: (error) => Effect.fail(staleWrite(error)),
              AccessPolicyBuiltInError: (error) => Effect.fail(builtIn(error)),
            }),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "access_policy.updated",
          subjectType: "access_policy",
          subjectId: updated.id,
          data: templateData(updated),
        });
        return updated;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const found = yield* ownerOnly(OWNERS_WRITE);
        const caller = yield* CurrentUser;
        const removed = yield* (yield* AccessPoliciesRepo)
          .remove(found.organization.id, params.id)
          .pipe(
            Effect.catchTags({
              AccessPolicyNotFoundError: () => Effect.fail(new NotFound({ id: params.id })),
              AccessPolicyBuiltInError: (error) => Effect.fail(builtIn(error)),
            }),
          );
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "access_policy.removed",
          subjectType: "access_policy",
          subjectId: removed.id,
          data: templateData(removed),
        });
        return removed;
      }),
    )
    .handle("revoke", ({ payload }) =>
      Effect.gen(function* () {
        const found = yield* ownerOnly(OWNERS_REVOKE);
        const caller = yield* CurrentUser;
        const repo = yield* AccessPoliciesRepo;
        const problems = revocationProblems(payload);
        if (problems.length > 0) {
          return yield* new AccessPolicyRejected({
            message: "Nothing was revoked: fix what is listed and revoke again.",
            problems,
          });
        }
        if (payload.policyId !== null) {
          yield* repo
            .byId(found.organization.id, payload.policyId)
            .pipe(
              Effect.catchTag("AccessPolicyNotFoundError", () =>
                Effect.fail(new NotFound({ id: payload.policyId ?? "" })),
              ),
            );
        }
        // Stored before anything else: from here on it wins over every pin, whatever the
        // push to running workspaces answers.
        const revocation = yield* repo.revoke({
          organizationId: found.organization.id,
          policyId: payload.policyId,
          kind: payload.kind,
          target: payload.kind === "all" ? null : (payload.target?.trim() ?? null),
          revokedByUserId: caller.user.id,
        });
        const pushed = yield* Effect.exit(
          (yield* AccessPolicyEnforcement).fanOutRevocation(revocation),
        );
        // Recorded even when the push broke: the revocation is stored, and it is the act.
        yield* (yield* AuditEventsRepo).record({
          organizationId: found.organization.id,
          actorUserId: caller.user.id,
          action: "access_policy.revoked",
          subjectType: "access_revocation",
          subjectId: revocation.id,
          data: {
            kind: revocation.kind,
            target: revocation.target,
            policyId: revocation.policyId,
          },
        });
        const workspaces = yield* pushed;
        return new AccessRevoked({ revocation, workspaces: workspaces.map(enforcementView) });
      }),
    ),
);

/** A project's own copy, and how it stands against the template it came from. */
const projectPolicyView = (organizationId: OrganizationId, policy: ProjectAccessPolicy) =>
  Effect.gen(function* () {
    const repo = yield* AccessPoliciesRepo;
    const elevated = isElevatedAccessPolicy(policy.rules);
    if (policy.source.policyId === STANDARD_ACCESS_POLICY_ID) {
      return new ProjectAccessPolicyView({
        policy,
        elevated,
        latestRevision: null,
        sourceRemoved: false,
      });
    }
    const template = yield* repo
      .byId(organizationId, policy.source.policyId)
      .pipe(Effect.catchTag("AccessPolicyNotFoundError", () => Effect.succeed(null)));
    return new ProjectAccessPolicyView({
      policy,
      elevated,
      latestRevision:
        template !== null && template.revision > policy.source.revision ? template.revision : null,
      sourceRemoved: template === null,
    });
  });

/** The project's own copy; Standard for a project that holds no other. */
const storedProjectPolicy = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const policy = yield* (yield* AccessPoliciesRepo).projectPolicy(projectId);
    return policy ?? STANDARD_PROJECT_ACCESS_POLICY;
  });

export const ProjectAccessPolicyGroupLive = HttpApiBuilder.group(
  MendApi,
  "projectAccessPolicy",
  (handlers) =>
    handlers
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const project = yield* (yield* ProjectAccess).project(params.id);
          return yield* projectPolicyView(
            project.organizationId,
            yield* storedProjectPolicy(project.id),
          );
        }),
      )
      .handle("set", ({ params, payload }) =>
        Effect.gen(function* () {
          const access = yield* ProjectAccess;
          const project = yield* access.manageProject(params.id);
          const caller = yield* CurrentUser;
          const repo = yield* AccessPoliciesRepo;
          const template = yield* repo
            .byId(project.organizationId, payload.policyId)
            .pipe(
              Effect.catchTag("AccessPolicyNotFoundError", () =>
                Effect.fail(new NotFound({ id: payload.policyId })),
              ),
            );
          if (template.elevated) {
            const viewer = yield* access.viewer();
            if (viewer?.role !== "owner") {
              return yield* new AccessPolicyOwnersOnly({ message: OWNERS_ELEVATED });
            }
          }
          // A copy, never a live link: later edits of the template reach this project only when
          // it is assigned again. Worktrees keep their pins until "Apply updated policy".
          const policy: ProjectAccessPolicy = {
            rules: template.rules,
            source: { policyId: template.id, name: template.name, revision: template.revision },
          };
          yield* repo.setProjectPolicy(project.id, policy);
          yield* (yield* AuditEventsRepo).record({
            organizationId: project.organizationId,
            actorUserId: caller.user.id,
            action: "project.access_policy_assigned",
            subjectType: "project",
            subjectId: project.id,
            data: {
              policyId: template.id,
              revision: template.revision,
              elevated: template.elevated,
            },
          });
          // A standby holds the policy it was made under; the pool makes new ones under this.
          yield* (yield* SessionEngine).reconcileHotSessions(project.id);
          return yield* projectPolicyView(project.organizationId, policy);
        }),
      ),
);

export const WorktreeAccessPolicyGroupLive = HttpApiBuilder.group(
  MendApi,
  "worktreeAccessPolicy",
  (handlers) =>
    handlers
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const worktree = yield* (yield* ProjectAccess).worktree(params.id);
          const repo = yield* AccessPoliciesRepo;
          const pinned = pinOrStandard(worktree.accessPolicy);
          const revocations = (yield* repo.revocationsForProject(worktree.projectId)).filter(
            (revocation) => revocationReaches(revocation, pinned.source),
          );
          const project = yield* storedProjectPolicy(worktree.projectId);
          return new WorktreeAccessPolicyView({
            pin: worktree.accessPolicy,
            effective: effectiveAccessPolicyRules(pinned, revocations),
            revocations,
            projectPolicyDiffers:
              accessPolicyHash(project.rules) !==
              (worktree.accessPolicy?.policyHash ?? accessPolicyHash(STANDARD_ACCESS_POLICY_RULES)),
          });
        }),
      )
      .handle("apply", ({ params }) =>
        Effect.gen(function* () {
          yield* (yield* ProjectAccess).worktree(params.id);
          const applied = yield* (yield* AccessPolicyEnforcement)
            .applyUpdatedPolicy(params.id)
            .pipe(
              Effect.catchTags({
                WorktreeNotFoundError: () => Effect.fail(new NotFound({ id: params.id })),
                AccessPolicyApplyError: (error) =>
                  Effect.fail(new AccessPolicyNotApplied({ message: error.message })),
              }),
            );
          return new AppliedAccessPolicyView({
            pin: applied.pin,
            workspaces: applied.workspaces.map(enforcementView),
          });
        }),
      ),
);
