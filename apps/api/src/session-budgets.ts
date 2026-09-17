import { BudgetExceeded } from "@mend/api-contracts";
import { SessionsRepo } from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { Effect } from "effect";

import {
  budgetMessage,
  Budgets,
  overCeiling,
  type BudgetLimits,
  type BudgetName,
} from "./budgets.ts";

/** The contract's refusal for one budget. Ceilings name no retry time: they free when work settles. */
export const budgetExceeded = (name: BudgetName, limits: BudgetLimits) =>
  Effect.fail(
    new BudgetExceeded({
      budget: name,
      limit: limits[name],
      retryAfterSeconds: null,
      message: budgetMessage(name, limits[name]),
    }),
  );

/**
 * Room for one more session, for the account and for its organization (docs/adr/0004, "Budgets").
 * Counted from the sessions table, so it holds across API processes. Two creates that arrive
 * together can both pass: a ceiling can be overshot by the number in flight, never by more.
 */
export const requireSessionRoom = (userId: string, organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const { limits } = yield* Budgets;
    const sessions = yield* SessionsRepo;
    if (limits.accountLiveSessions > 0) {
      const mine = yield* sessions.listUnsettledForOwner(userId);
      if (overCeiling(mine.length, limits.accountLiveSessions)) {
        return yield* budgetExceeded("accountLiveSessions", limits);
      }
    }
    if (limits.organizationLiveSessions > 0) {
      const count = yield* sessions.countUnsettledForOrganization(organizationId);
      if (overCeiling(count, limits.organizationLiveSessions)) {
        return yield* budgetExceeded("organizationLiveSessions", limits);
      }
    }
  });
