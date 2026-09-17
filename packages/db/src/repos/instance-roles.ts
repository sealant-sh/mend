import { and, asc, count, eq, ne, sql as rawSql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { instanceRoles } from "../schema/workbench.ts";

/** Revoking would leave the instance with no operator, and nobody could recover it. */
export class LastOperatorError extends Schema.TaggedErrorClass<LastOperatorError>()(
  "LastOperatorError",
  {},
) {}

/**
 * Instance roles (docs/adr/0003-organizations-and-tenancy.md). The operator administers the
 * machine and has no default read access to organization content; holding the role grants
 * nothing inside an organization.
 */
export class InstanceRolesRepo extends Context.Service<
  InstanceRolesRepo,
  {
    readonly isOperator: (userId: string) => Effect.Effect<boolean>;
    /** Operators by grant time, earliest first. */
    readonly operators: () => Effect.Effect<ReadonlyArray<string>>;
    readonly grantOperator: (userId: string, grantedByUserId: string | null) => Effect.Effect<void>;
    readonly revokeOperator: (userId: string) => Effect.Effect<void, LastOperatorError>;
  }
>()("@mend/db/InstanceRolesRepo") {}

export const InstanceRolesRepoLive: Layer.Layer<InstanceRolesRepo, never, MendDB> = Layer.effect(
  InstanceRolesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const isOperator = Effect.fn("InstanceRolesRepo.isOperator")(function* (userId: string) {
      const [row] = yield* db
        .select({ userId: instanceRoles.userId })
        .from(instanceRoles)
        .where(and(eq(instanceRoles.userId, userId), eq(instanceRoles.role, "operator")))
        .limit(1)
        .pipe(Effect.orDie);
      return row !== undefined;
    });

    const operators = Effect.fn("InstanceRolesRepo.operators")(function* () {
      const rows = yield* db
        .select({ userId: instanceRoles.userId })
        .from(instanceRoles)
        .where(eq(instanceRoles.role, "operator"))
        .orderBy(asc(instanceRoles.grantedAt), asc(instanceRoles.userId))
        .pipe(Effect.orDie);
      return rows.map((row) => row.userId);
    });

    const grantOperator = Effect.fn("InstanceRolesRepo.grantOperator")(function* (
      userId: string,
      grantedByUserId: string | null,
    ) {
      yield* db
        .insert(instanceRoles)
        .values({ userId, role: "operator", grantedByUserId })
        .onConflictDoNothing()
        .pipe(Effect.orDie);
    });

    const revokeOperator = Effect.fn("InstanceRolesRepo.revokeOperator")(function* (
      userId: string,
    ) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .execute(rawSql`select pg_advisory_xact_lock(hashtext('mend:instance-roles'))`)
              .pipe(Effect.orDie);
            const [others] = yield* tx
              .select({ total: count() })
              .from(instanceRoles)
              .where(and(eq(instanceRoles.role, "operator"), ne(instanceRoles.userId, userId)))
              .pipe(Effect.orDie);
            if ((others?.total ?? 0) === 0) return yield* new LastOperatorError();
            yield* tx
              .delete(instanceRoles)
              .where(and(eq(instanceRoles.userId, userId), eq(instanceRoles.role, "operator")))
              .pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    return { isOperator, operators, grantOperator, revokeOperator };
  }),
);
