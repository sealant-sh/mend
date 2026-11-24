import { AccessPolicyId, type OrganizationId, type ProjectId, type WorktreeId } from "@mend/domain";
import {
  AccessPolicy,
  AccessPolicyRules,
  AccessRevocation,
  type AccessRevocationKind,
  canonicalAccessPolicyRules,
  canonicalPolicyHost,
  isElevatedAccessPolicy,
  ProjectAccessPolicy,
  STANDARD_ACCESS_POLICY_ID,
  STANDARD_ACCESS_POLICY_NAME,
  STANDARD_ACCESS_POLICY_REVISION,
  STANDARD_ACCESS_POLICY_RULES,
  WorktreeAccessPolicyPin,
} from "@mend/domain/workbench";
import { and, asc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  accessPolicies,
  accessRevocations,
  projectSecrets,
  projects,
  worktrees,
} from "../schema/workbench.ts";
import { projectListed } from "./projects.ts";
import { isUniqueViolation } from "./unique-violation.ts";

export class AccessPolicyNotFoundError extends Schema.TaggedError<AccessPolicyNotFoundError>()(
  "AccessPolicyNotFoundError",
  { policyId: Schema.String },
) {}

export class AccessPolicyNameTakenError extends Schema.TaggedError<AccessPolicyNameTakenError>()(
  "AccessPolicyNameTakenError",
  { name: Schema.String },
) {}

export class AccessPolicyStaleWriteError extends Schema.TaggedError<AccessPolicyStaleWriteError>()(
  "AccessPolicyStaleWriteError",
  { policyId: Schema.String, currentRevision: Schema.Int },
) {}

/** Standard is built in: it is never edited or removed. */
export class AccessPolicyBuiltInError extends Schema.TaggedError<AccessPolicyBuiltInError>()(
  "AccessPolicyBuiltInError",
  { policyId: Schema.String },
) {}

export interface NewAccessRevocation {
  readonly organizationId: OrganizationId;
  readonly policyId: AccessPolicyId | null;
  readonly kind: AccessRevocationKind;
  readonly target: string | null;
  readonly revokedByUserId: string;
}

/** A worktree a revocation reaches, with what it pinned. */
export interface ReachedWorktree {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  readonly pin: WorktreeAccessPolicyPin | null;
}

/**
 * Organization → Access policies (ADR 0025's 2026-11-24 amendment): the templates owners make,
 * each project's own copy, and the organization's durable revocations. Standard is built in and
 * has no row; `list` and `byId` answer it for every organization.
 */
export class AccessPoliciesRepo extends Context.Service<
  AccessPoliciesRepo,
  {
    /** Standard first, then the organization's templates by name. */
    readonly list: (organizationId: OrganizationId) => Effect.Effect<ReadonlyArray<AccessPolicy>>;
    readonly byId: (
      organizationId: OrganizationId,
      id: AccessPolicyId,
    ) => Effect.Effect<AccessPolicy, AccessPolicyNotFoundError>;
    readonly create: (input: {
      readonly organizationId: OrganizationId;
      readonly name: string;
      readonly rules: AccessPolicyRules;
      readonly createdByUserId: string;
    }) => Effect.Effect<AccessPolicy, AccessPolicyNameTakenError>;
    /** A new revision of a template's name and rules. Projects keep the copy they took. */
    readonly update: (input: {
      readonly organizationId: OrganizationId;
      readonly id: AccessPolicyId;
      readonly name: string;
      readonly rules: AccessPolicyRules;
      readonly expectedRevision: number;
    }) => Effect.Effect<
      AccessPolicy,
      | AccessPolicyNotFoundError
      | AccessPolicyNameTakenError
      | AccessPolicyStaleWriteError
      | AccessPolicyBuiltInError
    >;
    readonly remove: (
      organizationId: OrganizationId,
      id: AccessPolicyId,
    ) => Effect.Effect<AccessPolicy, AccessPolicyNotFoundError | AccessPolicyBuiltInError>;
    /** The project's own copy; Standard for a project that has no other. */
    readonly projectPolicy: (projectId: ProjectId) => Effect.Effect<ProjectAccessPolicy | null>;
    readonly setProjectPolicy: (
      projectId: ProjectId,
      policy: ProjectAccessPolicy,
    ) => Effect.Effect<void>;
    /** Stored before anything else happens; it wins over every pin from then on. */
    readonly revoke: (revocation: NewAccessRevocation) => Effect.Effect<AccessRevocation>;
    /** Oldest first. */
    readonly revocations: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<AccessRevocation>>;
    /** The revocations of the organization that owns `projectId`, oldest first. */
    readonly revocationsForProject: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<AccessRevocation>>;
    /** The organization's worktrees whose pin came from `policyId` (every one, when null). */
    readonly worktreesFrom: (
      organizationId: OrganizationId,
      policyId: AccessPolicyId | null,
    ) => Effect.Effect<ReadonlyArray<ReachedWorktree>>;
  }
>()("@mend/db/AccessPoliciesRepo") {}

const decodeRules = Schema.decodeUnknownSync(AccessPolicyRules);
const decodeProjectPolicy = Schema.decodeUnknownSync(ProjectAccessPolicy);
const encodeProjectPolicy = Schema.encodeSync(ProjectAccessPolicy);
const decodePin = Schema.decodeUnknownSync(WorktreeAccessPolicyPin);

/** Standard as one organization sees it. Its times are the epoch: it never changes. */
export const standardAccessPolicy = (organizationId: OrganizationId): AccessPolicy =>
  new AccessPolicy({
    id: STANDARD_ACCESS_POLICY_ID,
    organizationId,
    name: STANDARD_ACCESS_POLICY_NAME,
    builtIn: true,
    revision: STANDARD_ACCESS_POLICY_REVISION,
    rules: STANDARD_ACCESS_POLICY_RULES,
    elevated: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

const toPolicy = (row: typeof accessPolicies.$inferSelect): AccessPolicy => {
  const rules = decodeRules(row.rules);
  return new AccessPolicy({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    builtIn: false,
    revision: row.revision,
    rules,
    elevated: isElevatedAccessPolicy(rules),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

const toRevocation = (row: typeof accessRevocations.$inferSelect): AccessRevocation =>
  new AccessRevocation({
    id: row.id,
    organizationId: row.organizationId,
    policyId: row.policyId,
    kind: row.kind,
    target: row.target,
    revokedByUserId: row.revokedByUserId,
    revokedAt: row.revokedAt,
  });

export const AccessPoliciesRepoLive: Layer.Layer<AccessPoliciesRepo, never, MendDB> = Layer.effect(
  AccessPoliciesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const list = Effect.fn("AccessPoliciesRepo.list")(function* (organizationId: OrganizationId) {
      const rows = yield* db
        .select()
        .from(accessPolicies)
        .where(eq(accessPolicies.organizationId, organizationId))
        .orderBy(asc(sql`lower(${accessPolicies.name})`))
        .pipe(Effect.orDie);
      return [standardAccessPolicy(organizationId), ...rows.map(toPolicy)];
    });

    const byId = Effect.fn("AccessPoliciesRepo.byId")(function* (
      organizationId: OrganizationId,
      id: AccessPolicyId,
    ) {
      if (id === STANDARD_ACCESS_POLICY_ID) return standardAccessPolicy(organizationId);
      const [row] = yield* db
        .select()
        .from(accessPolicies)
        .where(and(eq(accessPolicies.id, id), eq(accessPolicies.organizationId, organizationId)))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AccessPolicyNotFoundError({ policyId: id });
      return toPolicy(row);
    });

    const nameTaken = (name: string) => (cause: unknown) =>
      isUniqueViolation(cause)
        ? Effect.fail(new AccessPolicyNameTakenError({ name }))
        : Effect.die(cause);

    const create = Effect.fn("AccessPoliciesRepo.create")(function* (input: {
      readonly organizationId: OrganizationId;
      readonly name: string;
      readonly rules: AccessPolicyRules;
      readonly createdByUserId: string;
    }) {
      const name = input.name.trim();
      const [row] = yield* db
        .insert(accessPolicies)
        .values({
          id: AccessPolicyId.make(`ap_${crypto.randomUUID()}`),
          organizationId: input.organizationId,
          name,
          rules: canonicalAccessPolicyRules(input.rules),
          createdByUserId: input.createdByUserId,
        })
        .returning()
        .pipe(Effect.catch(nameTaken(name)));
      if (row === undefined) return yield* Effect.die("access policy insert returned no row");
      return toPolicy(row);
    });

    const update = Effect.fn("AccessPoliciesRepo.update")(function* (input: {
      readonly organizationId: OrganizationId;
      readonly id: AccessPolicyId;
      readonly name: string;
      readonly rules: AccessPolicyRules;
      readonly expectedRevision: number;
    }) {
      if (input.id === STANDARD_ACCESS_POLICY_ID) {
        return yield* new AccessPolicyBuiltInError({ policyId: input.id });
      }
      const current = yield* byId(input.organizationId, input.id);
      if (current.revision !== input.expectedRevision) {
        return yield* new AccessPolicyStaleWriteError({
          policyId: input.id,
          currentRevision: current.revision,
        });
      }
      const name = input.name.trim();
      const [row] = yield* db
        .update(accessPolicies)
        .set({
          name,
          rules: canonicalAccessPolicyRules(input.rules),
          revision: sql`${accessPolicies.revision} + 1`,
          updatedAt: yield* DateTime.nowAsDate,
        })
        .where(
          and(
            eq(accessPolicies.id, input.id),
            eq(accessPolicies.organizationId, input.organizationId),
            eq(accessPolicies.revision, input.expectedRevision),
          ),
        )
        .returning()
        .pipe(Effect.catch(nameTaken(name)));
      if (row === undefined) {
        const latest = yield* byId(input.organizationId, input.id);
        return yield* new AccessPolicyStaleWriteError({
          policyId: input.id,
          currentRevision: latest.revision,
        });
      }
      return toPolicy(row);
    });

    const remove = Effect.fn("AccessPoliciesRepo.remove")(function* (
      organizationId: OrganizationId,
      id: AccessPolicyId,
    ) {
      if (id === STANDARD_ACCESS_POLICY_ID) {
        return yield* new AccessPolicyBuiltInError({ policyId: id });
      }
      const [row] = yield* db
        .delete(accessPolicies)
        .where(and(eq(accessPolicies.id, id), eq(accessPolicies.organizationId, organizationId)))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new AccessPolicyNotFoundError({ policyId: id });
      return toPolicy(row);
    });

    const projectPolicy = Effect.fn("AccessPoliciesRepo.projectPolicy")(function* (
      projectId: ProjectId,
    ) {
      const [row] = yield* db
        .select({ accessPolicy: projects.accessPolicy })
        .from(projects)
        .where(and(eq(projects.id, projectId), projectListed))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : decodeProjectPolicy(row.accessPolicy);
    });

    const setProjectPolicy = Effect.fn("AccessPoliciesRepo.setProjectPolicy")(function* (
      projectId: ProjectId,
      policy: ProjectAccessPolicy,
    ) {
      yield* db
        .update(projects)
        .set({
          accessPolicy: encodeProjectPolicy({
            ...policy,
            rules: canonicalAccessPolicyRules(policy.rules),
          }),
          updatedAt: yield* DateTime.nowAsDate,
        })
        .where(and(eq(projects.id, projectId), projectListed))
        .pipe(Effect.orDie);
    });

    const revoke = Effect.fn("AccessPoliciesRepo.revoke")(function* (
      revocation: NewAccessRevocation,
    ) {
      const [row] = yield* db
        .insert(accessRevocations)
        .values({
          id: `arv_${crypto.randomUUID()}`,
          organizationId: revocation.organizationId,
          policyId: revocation.policyId,
          kind: revocation.kind,
          target:
            revocation.kind === "host" && revocation.target !== null
              ? canonicalPolicyHost(revocation.target)
              : revocation.target,
          revokedByUserId: revocation.revokedByUserId,
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("revocation insert returned no row");
      return toRevocation(row);
    });

    const revocations = Effect.fn("AccessPoliciesRepo.revocations")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* db
        .select()
        .from(accessRevocations)
        .where(eq(accessRevocations.organizationId, organizationId))
        .orderBy(asc(accessRevocations.revokedAt), asc(accessRevocations.id))
        .pipe(Effect.orDie);
      return rows.map(toRevocation);
    });

    const revocationsForProject = Effect.fn("AccessPoliciesRepo.revocationsForProject")(function* (
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select({ revocation: accessRevocations })
        .from(accessRevocations)
        .innerJoin(projects, eq(projects.organizationId, accessRevocations.organizationId))
        .where(
          and(
            eq(projects.id, projectId),
            projectListed,
            // A secret's revocation is its own project's alone: another project's never reaches
            // this one's launches, nor drains its standbys.
            or(
              ne(accessRevocations.kind, "secret"),
              inArray(
                accessRevocations.target,
                db
                  .select({ id: projectSecrets.id })
                  .from(projectSecrets)
                  .where(eq(projectSecrets.projectId, projectId)),
              ),
            ),
          ),
        )
        .orderBy(asc(accessRevocations.revokedAt), asc(accessRevocations.id))
        .pipe(Effect.orDie);
      return rows.map((row) => toRevocation(row.revocation));
    });

    const worktreesFrom = Effect.fn("AccessPoliciesRepo.worktreesFrom")(function* (
      organizationId: OrganizationId,
      policyId: AccessPolicyId | null,
    ) {
      const rows = yield* db
        .select({
          worktreeId: worktrees.id,
          projectId: worktrees.projectId,
          pin: worktrees.accessPolicy,
        })
        .from(worktrees)
        .innerJoin(projects, eq(projects.id, worktrees.projectId))
        .where(
          and(
            eq(projects.organizationId, organizationId),
            projectListed,
            policyId === null
              ? undefined
              : policyId === STANDARD_ACCESS_POLICY_ID
                ? sql`coalesce(${worktrees.accessPolicy} #>> '{source,policyId}', 'standard') = ${policyId}`
                : and(
                    isNotNull(worktrees.accessPolicy),
                    sql`${worktrees.accessPolicy} #>> '{source,policyId}' = ${policyId}`,
                  ),
          ),
        )
        .pipe(Effect.orDie);
      return rows.map((row) => ({
        worktreeId: row.worktreeId,
        projectId: row.projectId,
        pin: row.pin === null ? null : decodePin(row.pin),
      }));
    });

    return {
      list,
      byId,
      create,
      update,
      remove,
      projectPolicy,
      setProjectPolicy,
      revoke,
      revocations,
      revocationsForProject,
      worktreesFrom,
    };
  }),
);
