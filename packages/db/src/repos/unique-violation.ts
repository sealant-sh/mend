/**
 * Postgres unique_violation: a unique key collided with a live row. The driver error sits below
 * the Drizzle error as an Effect `Cause` whose `reasons` carry the SQL error, whose `cause` is
 * pg's, so walk causes and reasons alike until a `code` appears.
 */
export const isUniqueViolation = (error: unknown, depth = 0): boolean =>
  uniqueViolationOf(error, depth) !== null;

/**
 * The unique key the violation names (pg: `constraint`; postgres.js: `constraint_name`), or null
 * when the error is no unique violation. A violation whose driver error carries no name answers
 * the empty string: a violation, of an unknown key.
 */
export const uniqueViolationConstraint = (error: unknown): string | null =>
  uniqueViolationOf(error, 0);

const uniqueViolationOf = (error: unknown, depth: number): string | null => {
  if (typeof error !== "object" || error === null || depth > 8) return null;
  if ("code" in error && error.code === "23505") {
    const named =
      "constraint" in error && typeof error.constraint === "string"
        ? error.constraint
        : "constraint_name" in error && typeof error.constraint_name === "string"
          ? error.constraint_name
          : "";
    return named;
  }
  if ("reasons" in error && Array.isArray(error.reasons)) {
    for (const reason of error.reasons) {
      const found = uniqueViolationOf(reason, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if ("cause" in error) {
    const found = uniqueViolationOf(error.cause, depth + 1);
    if (found !== null) return found;
  }
  if ("error" in error) {
    const found = uniqueViolationOf(error.error, depth + 1);
    if (found !== null) return found;
  }
  return "defect" in error ? uniqueViolationOf(error.defect, depth + 1) : null;
};
