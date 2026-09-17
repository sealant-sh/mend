/**
 * Postgres unique_violation: a unique key collided with a live row. The driver error sits below
 * the Drizzle error as an Effect `Cause` whose `reasons` carry the SQL error, whose `cause` is
 * pg's, so walk causes and reasons alike until a `code` appears.
 */
export const isUniqueViolation = (error: unknown, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 8) return false;
  if ("code" in error && error.code === "23505") return true;
  if ("reasons" in error && Array.isArray(error.reasons)) {
    return error.reasons.some((reason: unknown) => isUniqueViolation(reason, depth + 1));
  }
  if ("cause" in error && isUniqueViolation(error.cause, depth + 1)) return true;
  if ("error" in error && isUniqueViolation(error.error, depth + 1)) return true;
  return "defect" in error && isUniqueViolation(error.defect, depth + 1);
};
